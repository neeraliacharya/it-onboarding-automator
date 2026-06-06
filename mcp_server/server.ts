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

// ── tools/call ────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  logger.debug('MCP tool called', { tool: name, args });

  try {
    switch (name) {
      case 'get_employee_access': {
        const email = a.email as string;
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
        const since = a.since as string | undefined;
        const result = handleListFailedEvents(since);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'retry_provision': {
        const event_id = a.event_id as string;
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
