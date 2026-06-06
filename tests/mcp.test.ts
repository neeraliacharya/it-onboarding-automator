/**
 * tests/mcp.test.ts
 *
 * MCP tool happy-path tests (per SPEC.md Test Plan).
 *
 * Isolation: same strategy as webhook.test.ts —
 *   jest.resetModules() + DB_PATH=':memory:' in beforeEach gives every test
 *   a fresh in-memory SQLite database.
 *
 * We import the exported handler functions directly so we can call tool logic
 * without standing up a stdio transport.
 */

import type Database from 'better-sqlite3';

// ── Fixture payloads ─────────────────────────────────────────────────────────

const ENGINEER_HIRE = {
  event_id: 'mcp_test_001',
  event_type: 'employee.hired',
  email: 'alex.chen@example.com',
  full_name: 'Alex Chen',
  role: 'engineer',
};

const BAD_ROLE_HIRE = {
  event_id: 'mcp_test_bad_role',
  event_type: 'employee.hired',
  email: 'bad.role@example.com',
  full_name: 'Bad Role',
  role: 'unknown_role_xyz',
};

const SALES_HIRE = {
  event_id: 'mcp_test_sales',
  event_type: 'employee.hired',
  email: 'sam.sales@example.com',
  full_name: 'Sam Sales',
  role: 'sales',
};

// ── Suite ────────────────────────────────────────────────────────────────────

describe('MCP tools', () => {
  let db: InstanceType<typeof Database>;
  let handleGetEmployeeAccess: (email: string) => ReturnType<typeof import('../mcp_server/server').handleGetEmployeeAccess>;
  let handleListFailedEvents: (since?: string) => ReturnType<typeof import('../mcp_server/server').handleListFailedEvents>;
  let handleRetryProvision: (eventId: string) => ReturnType<typeof import('../mcp_server/server').handleRetryProvision>;
  let provisionEmployee: typeof import('../onboarding/provisioner').provisionEmployee;

  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';

    // Load db first so the same in-memory instance is shared with all modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = (require('../onboarding/db') as { default: InstanceType<typeof Database> }).default;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const provisioner = require('../onboarding/provisioner') as typeof import('../onboarding/provisioner');
    provisionEmployee = provisioner.provisionEmployee;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcpServer = require('../mcp_server/server') as typeof import('../mcp_server/server');
    handleGetEmployeeAccess = mcpServer.handleGetEmployeeAccess;
    handleListFailedEvents = mcpServer.handleListFailedEvents;
    handleRetryProvision = mcpServer.handleRetryProvision;
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ── get_employee_access ────────────────────────────────────────────────────

  describe('get_employee_access', () => {
    test('returns correct role, full_name, and granted_apps for a provisioned engineer', () => {
      provisionEmployee(ENGINEER_HIRE);

      const result = handleGetEmployeeAccess(ENGINEER_HIRE.email);

      expect(result.email).toBe('alex.chen@example.com');
      expect(result.full_name).toBe('Alex Chen');
      expect(result.role).toBe('engineer');
      expect(result.granted_apps).toHaveLength(3);
      expect(result.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira']),
      );
    });

    test('returns correct apps for a provisioned sales employee', () => {
      provisionEmployee(SALES_HIRE);

      const result = handleGetEmployeeAccess(SALES_HIRE.email);

      expect(result.role).toBe('sales');
      expect(result.granted_apps).toHaveLength(3);
      expect(result.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'salesforce']),
      );
    });

    test('throws an error for an email that has not been provisioned', () => {
      expect(() => handleGetEmployeeAccess('ghost@example.com')).toThrow(
        'Employee not found: ghost@example.com',
      );
    });
  });

  // ── list_failed_events ─────────────────────────────────────────────────────

  describe('list_failed_events', () => {
    test('returns empty array when no events have failed', () => {
      provisionEmployee(ENGINEER_HIRE); // succeeds → no failed events
      const result = handleListFailedEvents();
      expect(result).toHaveLength(0);
    });

    test('returns the failed event with correct fields', () => {
      // Trigger a failure (unknown role)
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const result = handleListFailedEvents();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        event_id: 'mcp_test_bad_role',
        error_message: 'Unknown role: unknown_role_xyz',
      });
      expect(result[0]).toHaveProperty('created_at');
      expect(result[0]).toHaveProperty('updated_at');
    });

    test('since filter: excludes events whose updated_at is before the cutoff', () => {
      // Cause a failure and capture its updated_at
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const row = db
        .prepare("SELECT updated_at FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { updated_at: string };

      // A future cutoff → event should be excluded
      const future = '9999-01-01T00:00:00.000Z';
      expect(handleListFailedEvents(future)).toHaveLength(0);

      // Cutoff at or before updated_at → event should be included
      expect(handleListFailedEvents(row.updated_at)).toHaveLength(1);
    });
  });

  // ── retry_provision ────────────────────────────────────────────────────────

  describe('retry_provision', () => {
    test('throws on unknown event_id', () => {
      expect(() => handleRetryProvision('nonexistent_evt')).toThrow(
        'No webhook event found',
      );
    });

    test('throws when event is not in failed state (completed)', () => {
      provisionEmployee(ENGINEER_HIRE); // succeeds → status is "completed"
      expect(() => handleRetryProvision(ENGINEER_HIRE.event_id)).toThrow(
        'is not in failed state',
      );
    });

    test('retry_provision succeeds after seeding a corrected role', () => {
      // Step 1: Cause initial failure (unknown role)
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const failedRow = db
        .prepare("SELECT status FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { status: string };
      expect(failedRow.status).toBe('failed');

      // Step 2: Manually seed the role into role_app_grants so the retry works
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'jira')").run();

      // Step 3: Retry
      const result = handleRetryProvision('mcp_test_bad_role');

      expect(result.event_id).toBe('mcp_test_bad_role');
      expect(result.status).toBe('completed');
      expect(result.granted_apps).toEqual(expect.arrayContaining(['slack', 'jira']));

      // Confirm the DB reflects the success
      const retried = db
        .prepare("SELECT status FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { status: string };
      expect(retried.status).toBe('completed');
    });
  });
});
