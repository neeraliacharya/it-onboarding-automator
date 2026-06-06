/**
 * onboarding/provisioner.ts
 *
 * Core provisioning logic — shared by the HTTP API and the MCP server.
 * The same validation, role resolution, grant writing, and idempotency logic
 * runs whether an event arrives via webhook or via `retry_provision` MCP tool.
 *
 * CLAUDE.md rules enforced here:
 *  - All DB access goes through the db singleton — no direct better-sqlite3 imports.
 *  - All provisioning / validation / idempotency / retry logic lives here.
 *  - All output goes to process.stderr via logger — never stdout.
 *
 * Exported functions:
 *   provisionEmployee(payload)      — called by api/webhook.ts
 *   retryProvisionEmployee(eventId) — called by mcp_server/server.ts retry_provision tool
 */

import db from './db';
import { logger } from './logger';
import type { WebhookPayload, ProvisioningResult, WebhookEvent } from './types';

// ── Error class ──────────────────────────────────────────────────────────────

/**
 * Thrown when provisioning fails for a known, handleable reason.
 * The webhook handler and MCP tool map this to the appropriate HTTP status / error message.
 */
export class ProvisioningHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly eventId: string,
  ) {
    super(message);
    this.name = 'ProvisioningHttpError';
    // Required for `instanceof` checks when extending built-in Error in TS.
    Object.setPrototypeOf(this, ProvisioningHttpError.prototype);
  }
}

// ── Private transaction helper ───────────────────────────────────────────────

/**
 * Runs the core provisioning transaction (steps 5–9 from SPEC.md).
 *
 * Shared by provisionEmployee (fresh hire) and retryProvisionEmployee (MCP retry).
 * A webhook_events row with the given event_id must already be in "pending" state
 * before calling this — the transaction updates it to "completed" on success.
 *
 * Throws ProvisioningHttpError(400, "unknown_role") if the role has no app mappings.
 * better-sqlite3 rolls back automatically on any throw.
 */
function runProvisionTransaction(
  event_id: string,
  email: string,
  full_name: string,
  role: string,
): string[] {
  const runTxn = db.transaction((): string[] => {
    // Step 5: Resolve apps for the role.
    const appRows = db
      .prepare('SELECT app_name FROM role_app_grants WHERE role = ?')
      .all(role) as { app_name: string }[];

    if (appRows.length === 0) {
      throw new ProvisioningHttpError(
        400,
        'unknown_role',
        `Unknown role: ${role}`,
        event_id,
      );
    }

    const apps = appRows.map((r) => r.app_name);

    // Step 6: Insert employee — OR IGNORE so re-hire on same email is safe.
    db.prepare(
      `INSERT OR IGNORE INTO employees (email, full_name, role) VALUES (?, ?, ?)`,
    ).run(email, full_name, role);

    // Step 7: Insert access_grants — OR IGNORE on unique (email, app) pair.
    const insertGrant = db.prepare(
      `INSERT OR IGNORE INTO access_grants (employee_email, app_name) VALUES (?, ?)`,
    );
    for (const app of apps) {
      insertGrant.run(email, app);
    }

    // Step 8: Insert audit_log.
    // details_json MUST include: event_id, role, granted_apps, idempotent.
    db.prepare(
      `INSERT INTO audit_log (event_id, action, details_json)
       VALUES (?, 'provisioned', ?)`,
    ).run(
      event_id,
      JSON.stringify({ event_id, role, granted_apps: apps, idempotent: false }),
    );

    // Step 9: Mark webhook_events "completed" and refresh updated_at.
    db.prepare(
      `UPDATE webhook_events
       SET status     = 'completed',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE event_id = ?`,
    ).run(event_id);

    return apps;
  });

  return runTxn();
}

/**
 * Updates the webhook_events row to "failed" after a transaction rolls back.
 * Called by both provisionEmployee and retryProvisionEmployee catch blocks.
 */
function markFailed(event_id: string, message: string): void {
  db.prepare(
    `UPDATE webhook_events
     SET status        = 'failed',
         error_message = ?,
         updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE event_id = ?`,
  ).run(message, event_id);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Provision access for a new hire (called by the webhook handler).
 *
 * Steps (per SPEC.md):
 *  1. Validate all five required fields.
 *  2. Validate event_type === "employee.hired".
 *  3. Idempotency check on webhook_events.event_id.
 *  4. Insert webhook_events row with status "pending" (outside transaction).
 *  5–9. runProvisionTransaction() — atomic: resolve apps → insert employee →
 *       insert grants → insert audit_log → update webhook_events "completed".
 * 10. Write required structured log to stderr.
 *
 * @throws ProvisioningHttpError for all known failure modes (400 / 409).
 */
export function provisionEmployee(payload: WebhookPayload): ProvisioningResult {
  // ── Step 1: Validate required fields ────────────────────────────────────
  const raw = payload as unknown as Record<string, unknown>;
  const required: Array<keyof WebhookPayload> = [
    'event_id',
    'event_type',
    'email',
    'full_name',
    'role',
  ];

  for (const field of required) {
    if (!raw[field]) {
      throw new ProvisioningHttpError(
        400,
        'missing_field',
        `Missing required field: ${field}`,
        String(raw.event_id ?? ''),
      );
    }
  }

  const { event_id, event_type, email, full_name, role } = payload;

  // ── Step 2: Validate event_type ──────────────────────────────────────────
  if (event_type !== 'employee.hired') {
    throw new ProvisioningHttpError(
      400,
      'invalid_event_type',
      `Invalid event_type: ${event_type}. Expected "employee.hired".`,
      event_id,
    );
  }

  // ── Step 3: Idempotency / state check ───────────────────────────────────
  const existing = db
    .prepare('SELECT status FROM webhook_events WHERE event_id = ?')
    .get(event_id) as { status: string } | undefined;

  if (existing) {
    if (existing.status === 'completed') {
      // Return immediately — no writes.
      logger.info('Idempotent skip — event already completed', { event_id });

      const grants = db
        .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
        .all(email) as { app_name: string }[];

      const emp = db
        .prepare('SELECT role FROM employees WHERE email = ?')
        .get(email) as { role: string } | undefined;

      return {
        event_id,
        status: 'completed',
        idempotent: true,
        employee: { email, role: emp?.role ?? role },
        granted_apps: grants.map((g) => g.app_name),
      };
    }

    if (existing.status === 'pending') {
      throw new ProvisioningHttpError(
        409,
        'conflict',
        `Event ${event_id} is currently being processed.`,
        event_id,
      );
    }

    if (existing.status === 'failed') {
      throw new ProvisioningHttpError(
        400,
        'already_failed',
        `Event ${event_id} previously failed. Use the retry_provision MCP tool to retry.`,
        event_id,
      );
    }
  }

  // ── Step 4: Insert webhook_events "pending" (outside transaction) ────────
  // Committed before the transaction so we always have a row to flip to
  // "failed" even if the transaction rolls back.
  db.prepare(
    `INSERT INTO webhook_events (event_id, payload_json, status)
     VALUES (?, ?, 'pending')`,
  ).run(event_id, JSON.stringify(payload));

  logger.debug('Transaction starting', { event_id });

  // ── Steps 5–9: Atomic provisioning transaction ───────────────────────────
  let grantedApps: string[];

  try {
    grantedApps = runProvisionTransaction(event_id, email, full_name, role);
    logger.debug('Transaction committed', { event_id });
  } catch (err) {
    // Transaction rolled back automatically — durably record the failure.
    markFailed(event_id, err instanceof Error ? err.message : String(err));
    logger.warn('Provisioning failed', {
      event_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // ── Step 10: Required structured log ────────────────────────────────────
  // Mechanically checked by reviewer — must include event_id and granted_apps_count.
  // Format: {"event":"provisioned","event_id":"...","granted_apps_count":N}
  logger.info('provisioned', {
    event: 'provisioned',
    event_id,
    granted_apps_count: grantedApps.length,
  });

  return {
    event_id,
    status: 'completed',
    idempotent: false,
    employee: { email, role },
    granted_apps: grantedApps,
  };
}

/**
 * Retry provisioning for a FAILED event_id (called by the MCP retry_provision tool).
 *
 * All retry validation, state management, and provisioning live here — the MCP
 * handler is a thin wrapper that formats the tool response.
 *
 * Steps:
 *  1. Verify the event exists and is in "failed" state.
 *  2. Parse the original payload_json stored when the event first arrived.
 *  3. UPDATE webhook_events status to "pending" (SPEC: "resets to pending").
 *  4. Run runProvisionTransaction() with the original payload.
 *
 * @throws ProvisioningHttpError when the event doesn't exist or isn't failed.
 */
export function retryProvisionEmployee(eventId: string): ProvisioningResult {
  // ── Step 1: Validate event exists and is "failed" ────────────────────────
  const existing = db
    .prepare('SELECT status, payload_json FROM webhook_events WHERE event_id = ?')
    .get(eventId) as Pick<WebhookEvent, 'status' | 'payload_json'> | undefined;

  if (!existing) {
    throw new ProvisioningHttpError(
      404,
      'not_found',
      `No webhook event found with event_id: ${eventId}`,
      eventId,
    );
  }

  if (existing.status !== 'failed') {
    throw new ProvisioningHttpError(
      400,
      'not_failed',
      `Event ${eventId} is not in failed state (current: ${existing.status}). ` +
        `Only failed events can be retried.`,
      eventId,
    );
  }

  // ── Step 2: Parse original payload ───────────────────────────────────────
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(existing.payload_json) as WebhookPayload;
  } catch {
    throw new ProvisioningHttpError(
      400,
      'corrupted_payload',
      `Failed to parse stored payload for event ${eventId}. The record may be corrupted.`,
      eventId,
    );
  }

  const { event_id, email, full_name, role } = payload;

  // ── Step 3: Reset to "pending" (SPEC: "resets to pending and re-runs provisioner") ──
  // UPDATE preserves the original created_at and event_id — more faithful to SPEC
  // than deleting and re-inserting the row.
  db.prepare(
    `UPDATE webhook_events
     SET status     = 'pending',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE event_id = ?`,
  ).run(eventId);

  logger.info('Retrying provisioning via MCP', { event_id });

  // ── Step 4: Re-run the provisioning transaction ───────────────────────────
  let grantedApps: string[];

  try {
    grantedApps = runProvisionTransaction(event_id, email, full_name, role);
    logger.debug('Retry transaction committed', { event_id });
  } catch (err) {
    // Transaction rolled back — flip back to "failed" with updated error.
    markFailed(event_id, err instanceof Error ? err.message : String(err));
    logger.warn('Retry provisioning failed', {
      event_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Required structured log — same format as a fresh provision.
  logger.info('provisioned', {
    event: 'provisioned',
    event_id,
    granted_apps_count: grantedApps.length,
  });

  return {
    event_id,
    status: 'completed',
    idempotent: false,
    employee: { email, role },
    granted_apps: grantedApps,
  };
}
