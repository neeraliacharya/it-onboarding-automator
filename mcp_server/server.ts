/**
 * mcp_server/server.ts
 *
 * MCP stdio server exposing three tools for inspecting and retrying
 * IT onboarding provisioning events.
 *
 * ⚠️  STDOUT IS RESERVED FOR MCP JSON-RPC — NEVER WRITE TO IT.
 *     All debug / error output must go to process.stderr or via logger.
 *
 * Tools (exactly as named in SPEC.md):
 *   - get_employee_access
 *   - list_failed_events
 *   - retry_provision
 *
 * Handler functions are exported so tests can call them directly without
 * triggering the stdio transport (same pattern as api/server.ts createApp).
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import db from '../onboarding/db';
import { logger } from '../onboarding/logger';
import {
  retryProvisionEmployee,
  ProvisioningHttpError,
} from '../onboarding/provisioner';
import type { Employee, WebhookEvent } from '../onboarding/types';

// ── Tool handler functions (exported for unit tests) ─────────────────────────

/**
 * get_employee_access — Email → role, full name, and active grants.
 * Throws if the employee is not found.
 */
export function handleGetEmployeeAccess(email: string): {
  email: string;
  full_name: string;
  role: string;
  granted_apps: string[];
} {
  const emp = db
    .prepare('SELECT * FROM employees WHERE email = ?')
    .get(email) as Employee | undefined;

  if (!emp) {
    throw new Error(`Employee not found: ${email}`);
  }

  const grants = db
    .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
    .all(email) as { app_name: string }[];

  return {
    email: emp.email,
    full_name: emp.full_name,
    role: emp.role,
    granted_apps: grants.map((g) => g.app_name),
  };
}

/**
 * list_failed_events — All failed webhook_events, optionally filtered by
 * updated_at >= since (ISO-8601 string).
 *
 * SPEC query note: filter is on `updated_at`; both created_at and updated_at
 * are returned in every row.
 */
export function handleListFailedEvents(since?: string): {
  event_id: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}[] {
  if (since) {
    return db
      .prepare(
        `SELECT event_id, error_message, created_at, updated_at
         FROM webhook_events
         WHERE status = 'failed' AND updated_at >= ?
         ORDER BY updated_at DESC`,
      )
      .all(since) as WebhookEvent[];
  }

  return db
    .prepare(
      `SELECT event_id, error_message, created_at, updated_at
       FROM webhook_events
       WHERE status = 'failed'
       ORDER BY updated_at DESC`,
    )
    .all() as WebhookEvent[];
}

/**
 * retry_provision — Thin adapter: all retry logic lives in provisioner.ts.
 *
 * retryProvisionEmployee() handles:
 *  - Validating the event exists and is in "failed" state
 *  - Parsing the original payload
 *  - Resetting status to "pending" (per SPEC)
 *  - Running the shared provisioning transaction
 *
 * This function only formats the MCP tool response.
 */
export function handleRetryProvision(eventId: string): {
  event_id: string;
  status: 'completed';
  granted_apps: string[];
} {
  const result = retryProvisionEmployee(eventId);
  return {
    event_id: result.event_id,
    status: 'completed',
    granted_apps: result.granted_apps,
  };
}

// ── MCP Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'onboarding-automator', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ── tools/list ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_employee_access',
      description:
        'Look up an employee by email and return their role, full name, and list of active application grants.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          email: {
            type: 'string',
            description: 'The employee email address to look up.',
          },
        },
        required: ['email'],
      },
    },
    {
      name: 'list_failed_events',
      description:
        'Return all webhook events that failed provisioning. ' +
        'Optionally filter to events that last failed on or after a given ISO-8601 timestamp.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description:
              'Optional ISO-8601 timestamp. Only events with updated_at >= since are returned.',
          },
        },
        required: [],
      },
    },
    {
      name: 'retry_provision',
      description:
        'Re-run provisioning for a failed event_id using the original webhook payload. ' +
        'Only works on events with status = "failed". Use the webhook endpoint for new hires.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event_id: {
            type: 'string',
            description: 'The event_id of the failed webhook event to retry.',
          },
        },
        required: ['event_id'],
      },
    },
  ],
}));

// ── Argument extraction helper ────────────────────────────────────────────────

/**
 * Safely extract a named string argument from an MCP tool call's args object.
 *
 * The MCP Inspector (form mode) sometimes passes the *entire* arguments JSON
 * as the string value of a single field when the user types the full JSON body
 * into one input box — e.g. the user types '{ "email": "a@b.com" }' into the
 * "email" field, so a.email === '{ "email": "a@b.com" }' instead of 'a@b.com'.
 *
 * This helper handles that case by trying to JSON-parse string values that look
 * like objects and re-extracting the named key.
 */
export function extractArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = args[key];

  // Normal case: the argument is already a plain string.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // Inspector passed the full JSON body as this field's value — unwrap it.
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner = parsed[key];
        // Key found → return it; key absent → return undefined so callers
        // emit "Missing required argument" rather than using a garbage string.
        return typeof inner === 'string' ? inner : undefined;
      } catch {
        // Not valid JSON — fall through and use the raw value as-is.
      }
    }
    return trimmed || undefined;
  }

  // Edge case: the argument is already an object (e.g. `{ email: "a@b.com" }`).
  if (typeof raw === 'object' && raw !== null) {
    const inner = (raw as Record<string, unknown>)[key];
    if (typeof inner === 'string') return inner;
  }

  return undefined;
}

// ── tools/call ────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  logger.debug('MCP tool called', { tool: name, args });

  try {
    switch (name) {
      case 'get_employee_access': {
        const email = extractArg(a, 'email');
        if (!email) {
          return {
            content: [{ type: 'text' as const, text: 'Missing required argument: email' }],
            isError: true,
          };
        }
        const result = handleGetEmployeeAccess(email);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'list_failed_events': {
        const since = extractArg(a, 'since');
        const result = handleListFailedEvents(since);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'retry_provision': {
        const event_id = extractArg(a, 'event_id');
        if (!event_id) {
          return {
            content: [{ type: 'text' as const, text: 'Missing required argument: event_id' }],
            isError: true,
          };
        }
        const result = handleRetryProvision(event_id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isProvisioning = err instanceof ProvisioningHttpError;

    logger.warn('MCP tool error', {
      tool: name,
      error: message,
      ...(isProvisioning && { errorCode: err.errorCode }),
    });

    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Transport — only connect when run as the entry point ─────────────────────
// Guards tests from accidentally binding to stdio.

if (require.main === module) {
  const transport = new StdioServerTransport();

  server.connect(transport).then(() => {
    logger.debug('MCP server connected via stdio transport');
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcp] Fatal error connecting transport: ${message}\n`);
    process.exit(1);
  });
}
