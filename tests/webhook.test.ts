/**
 * tests/webhook.test.ts
 *
 * Required tests for the POST /webhooks/hris endpoint.
 *
 * Isolation strategy: each test gets a completely fresh in-memory SQLite
 * database.  We achieve this by:
 *  1. Calling jest.resetModules() in beforeEach to clear the module cache.
 *  2. Setting process.env.DB_PATH = ':memory:' before requiring any module
 *     so db.ts opens a new in-memory database (dotenv won't override an
 *     already-set env var).
 *  3. Requiring db and the Express app via require() so each test gets
 *     fresh module instances backed by the same in-memory DB.
 */

import supertest from 'supertest';
import type { Application } from 'express';
import type Database from 'better-sqlite3';

// ── Shared fixture payloads (match fixtures/webhooks/ exactly) ───────────────

const VALID_HIRE = {
  event_id: 'evt_hire_001',
  event_type: 'employee.hired',
  email: 'alex.chen@example.com',
  full_name: 'Alex Chen',
  role: 'engineer',
};

const INVALID_ROLE = {
  event_id: 'evt_hire_bad_role',
  event_type: 'employee.hired',
  email: 'bad.role@example.com',
  full_name: 'Bad Role',
  role: 'unknown_role_xyz',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /webhooks/hris', () => {
  let app: Application;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    // Clear module registry so each test gets fresh module instances.
    jest.resetModules();

    // Set BEFORE any require() — dotenv (loaded by server.ts) will not
    // override an already-set env var, so the in-memory flag is preserved.
    process.env.DB_PATH = ':memory:';

    // Load db first so it is cached before server transitively requires it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = (require('../onboarding/db') as { default: InstanceType<typeof Database> })
      .default;

    // Load the Express app factory.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createApp } = require('../api/server') as {
      createApp: () => Application;
    };
    app = createApp();
  });

  afterEach(() => {
    // Close the in-memory DB to release resources immediately.
    try {
      db.close();
    } catch {
      // Already closed — ignore.
    }
  });

  // ── Test 1: Valid hire ──────────────────────────────────────────────────────

  test('valid hire: 202, employee row, correct grants, audit_log keys, webhook completed', async () => {
    const res = await supertest(app)
      .post('/webhooks/hris')
      .send(VALID_HIRE);

    // HTTP response shape
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      event_id: 'evt_hire_001',
      status: 'completed',
      idempotent: false,
      employee: { email: 'alex.chen@example.com', role: 'engineer' },
    });
    expect(res.body.granted_apps).toHaveLength(3);
    expect(res.body.granted_apps).toEqual(
      expect.arrayContaining(['slack', 'google_workspace', 'jira']),
    );

    // Employee row exists in DB
    const employee = db
      .prepare('SELECT * FROM employees WHERE email = ?')
      .get('alex.chen@example.com');
    expect(employee).toBeTruthy();

    // access_grants has exactly slack, google_workspace, jira — no more, no fewer
    const grants = db
      .prepare(
        'SELECT app_name FROM access_grants WHERE employee_email = ?',
      )
      .all('alex.chen@example.com') as { app_name: string }[];
    expect(grants).toHaveLength(3);
    expect(grants.map((g) => g.app_name)).toEqual(
      expect.arrayContaining(['slack', 'google_workspace', 'jira']),
    );

    // audit_log has one entry with all required keys in details_json
    const auditEntry = db
      .prepare('SELECT details_json FROM audit_log WHERE event_id = ?')
      .get('evt_hire_001') as { details_json: string } | undefined;
    expect(auditEntry).toBeTruthy();
    const details = JSON.parse(auditEntry!.details_json) as Record<
      string,
      unknown
    >;
    expect(details).toHaveProperty('event_id', 'evt_hire_001');
    expect(details).toHaveProperty('role', 'engineer');
    expect(details.granted_apps).toEqual(
      expect.arrayContaining(['slack', 'google_workspace', 'jira']),
    );
    expect(details).toHaveProperty('idempotent', false);

    // webhook_events row is "completed"
    const webhookEvent = db
      .prepare('SELECT status FROM webhook_events WHERE event_id = ?')
      .get('evt_hire_001') as { status: string } | undefined;
    expect(webhookEvent?.status).toBe('completed');
  });

  // ── Test 2: Duplicate event_id ──────────────────────────────────────────────

  test('duplicate event_id: 202 idempotent:true, no new rows in grants or audit_log', async () => {
    // First POST — should succeed normally.
    const first = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);
    expect(first.status).toBe(202);
    expect(first.body.idempotent).toBe(false);

    // Second POST with identical event_id — idempotent replay.
    const second = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);
    expect(second.status).toBe(202);
    expect(second.body.idempotent).toBe(true);

    // access_grants still has exactly 3 rows (no duplicates written).
    const grants = db
      .prepare(
        'SELECT app_name FROM access_grants WHERE employee_email = ?',
      )
      .all('alex.chen@example.com') as { app_name: string }[];
    expect(grants).toHaveLength(3);

    // audit_log still has exactly 1 entry (no second audit row).
    const auditCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?',
      )
      .get('evt_hire_001') as { count: number };
    expect(auditCount.count).toBe(1);
  });

  // ── Test 3: Invalid role ────────────────────────────────────────────────────

  test('invalid role: 400 unknown_role, webhook_events failed, zero access_grants', async () => {
    const res = await supertest(app)
      .post('/webhooks/hris')
      .send(INVALID_ROLE);

    // HTTP response
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_role');
    expect(res.body).toHaveProperty('event_id', 'evt_hire_bad_role');

    // webhook_events row is "failed"
    const webhookEvent = db
      .prepare('SELECT status FROM webhook_events WHERE event_id = ?')
      .get('evt_hire_bad_role') as { status: string } | undefined;
    expect(webhookEvent?.status).toBe('failed');

    // No access_grants written
    const grants = db
      .prepare(
        'SELECT * FROM access_grants WHERE employee_email = ?',
      )
      .all('bad.role@example.com');
    expect(grants).toHaveLength(0);
  });

  // ── Test 4: Re-POST of a failed event_id ────────────────────────────────────

  test('re-POST of failed event_id: 400 (must use retry_provision MCP tool instead)', async () => {
    // First POST — fails due to unknown role, sets status = "failed".
    await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);

    // Second POST of the same (now failed) event_id → must also be 400.
    const res = await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('already_failed');
  });
});
