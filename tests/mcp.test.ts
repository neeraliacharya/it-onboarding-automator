/**
 * tests/mcp.test.ts
 *
 * Tests for MCP tool handler functions and the extractArg input parser.
 *
 * Covers:
 *   - get_employee_access: all three seeded roles, not-found error
 *   - list_failed_events: empty, with failures, since filter, retry exclusion
 *   - retry_provision: error cases, success, state machine (retry → completed → retry again)
 *   - extractArg: all three input shapes (plain string, JSON-wrapped string, object value)
 *
 * Isolation: jest.resetModules() + DB_PATH=':memory:' in beforeEach gives every
 * test a fresh in-memory SQLite database.  Handler functions are imported via
 * require() so they share the same in-memory db instance.
 */

import type Database from 'better-sqlite3';

// ── Fixture payloads ──────────────────────────────────────────────────────────

const ENGINEER_HIRE = {
  event_id:   'mcp_test_001',
  event_type: 'employee.hired',
  email:      'alex.chen@example.com',
  full_name:  'Alex Chen',
  role:       'engineer',
};

const SALES_HIRE = {
  event_id:   'mcp_test_sales',
  event_type: 'employee.hired',
  email:      'sam.sales@example.com',
  full_name:  'Sam Sales',
  role:       'sales',
};

const ITADMIN_HIRE = {
  event_id:   'mcp_test_itadmin',
  event_type: 'employee.hired',
  email:      'admin@example.com',
  full_name:  'IT Admin',
  role:       'it_admin',
};

const BAD_ROLE_HIRE = {
  event_id:   'mcp_test_bad_role',
  event_type: 'employee.hired',
  email:      'bad.role@example.com',
  full_name:  'Bad Role',
  role:       'unknown_role_xyz',
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('MCP tools', () => {
  let db:                     InstanceType<typeof Database>;
  let handleGetEmployeeAccess: (email: string) => ReturnType<typeof import('../mcp_server/server').handleGetEmployeeAccess>;
  let handleListFailedEvents:  (since?: string) => ReturnType<typeof import('../mcp_server/server').handleListFailedEvents>;
  let handleRetryProvision:    (eventId: string) => ReturnType<typeof import('../mcp_server/server').handleRetryProvision>;
  let extractArg:              (args: Record<string, unknown>, key: string) => string | undefined;
  let provisionEmployee:       typeof import('../onboarding/provisioner').provisionEmployee;

  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = (require('../onboarding/db') as { default: InstanceType<typeof Database> }).default;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const provisioner = require('../onboarding/provisioner') as typeof import('../onboarding/provisioner');
    provisionEmployee = provisioner.provisionEmployee;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mcpServer = require('../mcp_server/server') as typeof import('../mcp_server/server');
    handleGetEmployeeAccess = mcpServer.handleGetEmployeeAccess;
    handleListFailedEvents  = mcpServer.handleListFailedEvents;
    handleRetryProvision    = mcpServer.handleRetryProvision;
    extractArg              = mcpServer.extractArg;
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ── extractArg — argument parsing (MCP Inspector compatibility) ───────────────

  describe('extractArg (MCP Inspector input parsing)', () => {
    test('plain string value → returns it unchanged', () => {
      expect(extractArg({ email: 'a@b.com' }, 'email')).toBe('a@b.com');
    });

    test('JSON-wrapped string (Inspector form-mode bug) → extracts the key value', () => {
      // Inspector passes the entire JSON body as the string value of a field
      const args = { email: '{ "email": "alex.chen@example.com" }' };
      expect(extractArg(args, 'email')).toBe('alex.chen@example.com');
    });

    test('object value → extracts the named key', () => {
      const args = { email: { email: 'alex.chen@example.com' } } as Record<string, unknown>;
      expect(extractArg(args, 'email')).toBe('alex.chen@example.com');
    });

    test('empty string → returns undefined', () => {
      expect(extractArg({ email: '' }, 'email')).toBeUndefined();
    });

    test('missing key → returns undefined', () => {
      expect(extractArg({}, 'email')).toBeUndefined();
    });

    test('JSON string where named key is absent → returns undefined', () => {
      // JSON has a different key, so extraction yields nothing
      const args = { email: '{ "other": "value" }' };
      expect(extractArg(args, 'email')).toBeUndefined();
    });

    test('invalid JSON string that starts with { → falls back to the raw string', () => {
      const args = { email: '{ not valid json' };
      // Cannot parse → returns the raw string as-is
      expect(extractArg(args, 'email')).toBe('{ not valid json');
    });

    test('event_id extraction works the same way', () => {
      const args = { event_id: '{ "event_id": "evt_123" }' };
      expect(extractArg(args, 'event_id')).toBe('evt_123');
    });
  });

  // ── get_employee_access ───────────────────────────────────────────────────────

  describe('get_employee_access', () => {
    test('engineer: correct email, full_name, role, and 3 apps', () => {
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

    test('sales: correct 3 apps (slack, google_workspace, salesforce)', () => {
      provisionEmployee(SALES_HIRE);

      const result = handleGetEmployeeAccess(SALES_HIRE.email);

      expect(result.role).toBe('sales');
      expect(result.granted_apps).toHaveLength(3);
      expect(result.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'salesforce']),
      );
      expect(result.granted_apps).not.toContain('jira');
    });

    test('it_admin: all 4 apps', () => {
      provisionEmployee(ITADMIN_HIRE);

      const result = handleGetEmployeeAccess(ITADMIN_HIRE.email);

      expect(result.role).toBe('it_admin');
      expect(result.granted_apps).toHaveLength(4);
      expect(result.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira', 'salesforce']),
      );
    });

    test('throws for an email that has not been provisioned', () => {
      expect(() => handleGetEmployeeAccess('ghost@example.com')).toThrow(
        'Employee not found: ghost@example.com',
      );
    });

    test('after retry_provision succeeds, returns the correct grants', () => {
      // Fail first, then seed the role and retry
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'jira')").run();
      handleRetryProvision(BAD_ROLE_HIRE.event_id);

      const result = handleGetEmployeeAccess(BAD_ROLE_HIRE.email);
      expect(result.granted_apps).toEqual(expect.arrayContaining(['slack', 'jira']));
    });
  });

  // ── list_failed_events ────────────────────────────────────────────────────────

  describe('list_failed_events', () => {
    test('returns empty array when no events have failed', () => {
      provisionEmployee(ENGINEER_HIRE);
      expect(handleListFailedEvents()).toHaveLength(0);
    });

    test('returns the failed event with all required fields', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const result = handleListFailedEvents();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        event_id:      'mcp_test_bad_role',
        error_message: 'Unknown role: unknown_role_xyz',
      });
      expect(result[0]).toHaveProperty('created_at');
      expect(result[0]).toHaveProperty('updated_at');
    });

    test('since filter: excludes events before cutoff, includes events at or after', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const row = db
        .prepare("SELECT updated_at FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { updated_at: string };

      expect(handleListFailedEvents('9999-01-01T00:00:00.000Z')).toHaveLength(0);
      expect(handleListFailedEvents(row.updated_at)).toHaveLength(1);
    });

    test('multiple failed events all appear in the list', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }
      try {
        provisionEmployee({ ...BAD_ROLE_HIRE, event_id: 'mcp_test_bad_role_2', email: 'b@b.com' });
      } catch { /* expected */ }

      const result = handleListFailedEvents();
      expect(result).toHaveLength(2);
    });

    test('successfully retried event is no longer returned', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      // Seed the role so retry can succeed
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      handleRetryProvision(BAD_ROLE_HIRE.event_id);

      // Should now have status = 'completed', not 'failed'
      const result = handleListFailedEvents();
      expect(result).toHaveLength(0);
    });
  });

  // ── retry_provision ────────────────────────────────────────────────────────────

  describe('retry_provision', () => {
    test('throws for a nonexistent event_id', () => {
      expect(() => handleRetryProvision('nonexistent_evt')).toThrow(
        'No webhook event found',
      );
    });

    test('throws when event is completed (not in failed state)', () => {
      provisionEmployee(ENGINEER_HIRE);
      expect(() => handleRetryProvision(ENGINEER_HIRE.event_id)).toThrow(
        'is not in failed state',
      );
    });

    test('succeeds after seeding the corrected role mapping', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const failedRow = db
        .prepare("SELECT status FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { status: string };
      expect(failedRow.status).toBe('failed');

      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'jira')").run();

      const result = handleRetryProvision('mcp_test_bad_role');

      expect(result.event_id).toBe('mcp_test_bad_role');
      expect(result.status).toBe('completed');
      expect(result.granted_apps).toEqual(expect.arrayContaining(['slack', 'jira']));

      const retriedRow = db
        .prepare("SELECT status FROM webhook_events WHERE event_id = 'mcp_test_bad_role'")
        .get() as { status: string };
      expect(retriedRow.status).toBe('completed');
    });

    test('retry success writes an audit_log entry with all 4 required keys', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();

      handleRetryProvision(BAD_ROLE_HIRE.event_id);

      const audit = db
        .prepare("SELECT action, details_json FROM audit_log WHERE event_id = ?")
        .get(BAD_ROLE_HIRE.event_id) as { action: string; details_json: string } | undefined;

      expect(audit).toBeTruthy();
      expect(audit!.action).toBe('provisioned');
      const details = JSON.parse(audit!.details_json) as Record<string, unknown>;
      expect(details).toHaveProperty('event_id', BAD_ROLE_HIRE.event_id);
      expect(details).toHaveProperty('role', BAD_ROLE_HIRE.role);
      expect(details).toHaveProperty('granted_apps');
      expect(details).toHaveProperty('idempotent', false);
    });

    test('retry → completed → retry again throws "not in failed state"', () => {
      // Fail → seed → retry → completed
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }
      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      handleRetryProvision(BAD_ROLE_HIRE.event_id);

      // Attempting a second retry on the now-completed event must throw
      expect(() => handleRetryProvision(BAD_ROLE_HIRE.event_id)).toThrow(
        'is not in failed state',
      );
    });

    test('webhook_events row preserves original created_at after retry', () => {
      try { provisionEmployee(BAD_ROLE_HIRE); } catch { /* expected */ }

      const before = db
        .prepare("SELECT created_at FROM webhook_events WHERE event_id = ?")
        .get(BAD_ROLE_HIRE.event_id) as { created_at: string };

      db.prepare("INSERT INTO role_app_grants (role, app_name) VALUES ('unknown_role_xyz', 'slack')").run();
      handleRetryProvision(BAD_ROLE_HIRE.event_id);

      const after = db
        .prepare("SELECT created_at FROM webhook_events WHERE event_id = ?")
        .get(BAD_ROLE_HIRE.event_id) as { created_at: string };

      // created_at must not change — only updated_at changes (UPDATE, not DELETE+INSERT)
      expect(after.created_at).toBe(before.created_at);
    });
  });
});
