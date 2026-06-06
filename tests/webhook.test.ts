/**
 * tests/webhook.test.ts
 *
 * Tests for the POST /webhooks/hris endpoint.
 *
 * Covers:
 *   - Valid hire (engineer, sales, it_admin roles)
 *   - Input validation (missing fields, wrong event_type)
 *   - Idempotency (duplicate event_id, response body completeness)
 *   - Error paths (invalid role, re-POST of failed event)
 *   - DB state assertions for every case
 *
 * Isolation strategy: each test gets a completely fresh in-memory SQLite DB.
 *   1. jest.resetModules() clears the module cache
 *   2. process.env.DB_PATH = ':memory:' is set before any require()
 *      (dotenv won't override an already-set env var)
 *   3. db and the Express app are loaded fresh via require()
 */

import supertest from 'supertest';
import type { Application } from 'express';
import type Database from 'better-sqlite3';

// ── Shared fixture payloads ───────────────────────────────────────────────────

const VALID_HIRE = {
  event_id:   'evt_hire_001',
  event_type: 'employee.hired',
  email:      'alex.chen@example.com',
  full_name:  'Alex Chen',
  role:       'engineer',
};

const INVALID_ROLE = {
  event_id:   'evt_hire_bad_role',
  event_type: 'employee.hired',
  email:      'bad.role@example.com',
  full_name:  'Bad Role',
  role:       'unknown_role_xyz',
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/hris', () => {
  let app: Application;
  let db:  InstanceType<typeof Database>;

  beforeEach(() => {
    jest.resetModules();
    process.env.DB_PATH = ':memory:';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = (require('../onboarding/db') as { default: InstanceType<typeof Database> }).default;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createApp } = require('../api/server') as { createApp: () => Application };
    app = createApp();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  describe('valid hire', () => {
    test('engineer: 202, DB rows correct, audit_log has all 4 required keys', async () => {
      const res = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        event_id:  'evt_hire_001',
        status:    'completed',
        idempotent: false,
        employee:  { email: 'alex.chen@example.com', role: 'engineer' },
      });
      expect(res.body.granted_apps).toHaveLength(3);
      expect(res.body.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira']),
      );

      // Employee row
      const employee = db
        .prepare('SELECT full_name, role FROM employees WHERE email = ?')
        .get('alex.chen@example.com') as { full_name: string; role: string } | undefined;
      expect(employee).toBeTruthy();
      expect(employee?.full_name).toBe('Alex Chen');
      expect(employee?.role).toBe('engineer');

      // access_grants — exactly 3, correct apps
      const grants = db
        .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
        .all('alex.chen@example.com') as { app_name: string }[];
      expect(grants).toHaveLength(3);
      expect(grants.map(g => g.app_name)).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira']),
      );

      // audit_log — action + all 4 required details_json keys
      const audit = db
        .prepare('SELECT action, details_json FROM audit_log WHERE event_id = ?')
        .get('evt_hire_001') as { action: string; details_json: string } | undefined;
      expect(audit).toBeTruthy();
      expect(audit!.action).toBe('provisioned');
      const details = JSON.parse(audit!.details_json) as Record<string, unknown>;
      expect(details).toHaveProperty('event_id', 'evt_hire_001');
      expect(details).toHaveProperty('role', 'engineer');
      expect(details).toHaveProperty('idempotent', false);
      expect(details.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira']),
      );

      // webhook_events
      const we = db
        .prepare('SELECT status FROM webhook_events WHERE event_id = ?')
        .get('evt_hire_001') as { status: string } | undefined;
      expect(we?.status).toBe('completed');
    });

    test('sales: 202 with correct 3 apps (slack, google_workspace, salesforce)', async () => {
      const payload = {
        event_id:   'evt_hire_sales',
        event_type: 'employee.hired',
        email:      'sam.sales@example.com',
        full_name:  'Sam Sales',
        role:       'sales',
      };
      const res = await supertest(app).post('/webhooks/hris').send(payload);

      expect(res.status).toBe(202);
      expect(res.body.granted_apps).toHaveLength(3);
      expect(res.body.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'salesforce']),
      );
      expect(res.body.granted_apps).not.toContain('jira');

      const grants = db
        .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
        .all('sam.sales@example.com') as { app_name: string }[];
      expect(grants).toHaveLength(3);
    });

    test('it_admin: 202 with all 4 apps', async () => {
      const payload = {
        event_id:   'evt_hire_itadmin',
        event_type: 'employee.hired',
        email:      'admin@example.com',
        full_name:  'IT Admin',
        role:       'it_admin',
      };
      const res = await supertest(app).post('/webhooks/hris').send(payload);

      expect(res.status).toBe(202);
      expect(res.body.granted_apps).toHaveLength(4);
      expect(res.body.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira', 'salesforce']),
      );
    });
  });

  // ── Idempotency ───────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    test('duplicate event_id: 202 idempotent:true, no new rows in grants or audit_log', async () => {
      const first = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);
      expect(first.status).toBe(202);
      expect(first.body.idempotent).toBe(false);

      const second = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);
      expect(second.status).toBe(202);
      expect(second.body.idempotent).toBe(true);

      // access_grants unchanged
      const grants = db
        .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
        .all('alex.chen@example.com') as { app_name: string }[];
      expect(grants).toHaveLength(3);

      // audit_log unchanged
      const auditCount = db
        .prepare('SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?')
        .get('evt_hire_001') as { count: number };
      expect(auditCount.count).toBe(1);
    });

    test('idempotent response returns the same granted_apps and employee as the original', async () => {
      await supertest(app).post('/webhooks/hris').send(VALID_HIRE);

      const replay = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);

      expect(replay.status).toBe(202);
      expect(replay.body.idempotent).toBe(true);
      // Must return the full data, not empty arrays
      expect(replay.body.granted_apps).toHaveLength(3);
      expect(replay.body.granted_apps).toEqual(
        expect.arrayContaining(['slack', 'google_workspace', 'jira']),
      );
      expect(replay.body.employee).toMatchObject({
        email: 'alex.chen@example.com',
        role:  'engineer',
      });
    });

    test('multiple replays of the same event_id all return 202 idempotent:true', async () => {
      await supertest(app).post('/webhooks/hris').send(VALID_HIRE);

      for (let i = 0; i < 3; i++) {
        const res = await supertest(app).post('/webhooks/hris').send(VALID_HIRE);
        expect(res.status).toBe(202);
        expect(res.body.idempotent).toBe(true);
      }

      // Still only 3 grants and 1 audit row after 4 total POSTs
      const grants = db
        .prepare('SELECT * FROM access_grants WHERE employee_email = ?')
        .all('alex.chen@example.com');
      expect(grants).toHaveLength(3);

      const count = db
        .prepare('SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?')
        .get('evt_hire_001') as { count: number };
      expect(count.count).toBe(1);
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    test('missing role → 400 missing_field', async () => {
      const { role: _role, ...noRole } = VALID_HIRE;
      const res = await supertest(app)
        .post('/webhooks/hris')
        .send({ ...noRole, event_id: 'evt_missing_role' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_field');
    });

    test('missing email → 400 missing_field', async () => {
      const { email: _email, ...noEmail } = VALID_HIRE;
      const res = await supertest(app)
        .post('/webhooks/hris')
        .send({ ...noEmail, event_id: 'evt_missing_email' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_field');
    });

    test('missing event_id → 400 missing_field', async () => {
      const { event_id: _id, ...noId } = VALID_HIRE;
      const res = await supertest(app)
        .post('/webhooks/hris')
        .send(noId);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_field');
    });

    test('wrong event_type → 400 invalid_event_type', async () => {
      const res = await supertest(app).post('/webhooks/hris').send({
        ...VALID_HIRE,
        event_id:   'evt_wrong_type',
        event_type: 'employee.terminated',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_event_type');
      expect(res.body.event_id).toBe('evt_wrong_type');
    });

    test('empty body → 400 missing_field', async () => {
      const res = await supertest(app)
        .post('/webhooks/hris')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_field');
    });
  });

  // ── Error paths ───────────────────────────────────────────────────────────────

  describe('error paths', () => {
    test('invalid role: 400, webhook_events failed, zero access_grants', async () => {
      const res = await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unknown_role');
      expect(res.body).toHaveProperty('event_id', 'evt_hire_bad_role');
      expect(res.body.message).toMatch('Unknown role: unknown_role_xyz');

      const we = db
        .prepare('SELECT status, error_message FROM webhook_events WHERE event_id = ?')
        .get('evt_hire_bad_role') as { status: string; error_message: string } | undefined;
      expect(we?.status).toBe('failed');
      expect(we?.error_message).toMatch('Unknown role: unknown_role_xyz');

      const grants = db
        .prepare('SELECT * FROM access_grants WHERE employee_email = ?')
        .all('bad.role@example.com');
      expect(grants).toHaveLength(0);
    });

    test('invalid role: no employee row created', async () => {
      await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);

      const emp = db
        .prepare('SELECT * FROM employees WHERE email = ?')
        .get('bad.role@example.com');
      expect(emp).toBeFalsy();
    });

    test('re-POST of failed event_id: 400 already_failed, webhook_events still failed', async () => {
      await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);

      const res = await supertest(app).post('/webhooks/hris').send(INVALID_ROLE);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('already_failed');

      // Status must remain "failed" — a second POST must not flip it to anything else
      const we = db
        .prepare('SELECT status FROM webhook_events WHERE event_id = ?')
        .get('evt_hire_bad_role') as { status: string } | undefined;
      expect(we?.status).toBe('failed');
    });

    test('different event_ids for same email succeed independently', async () => {
      // First hire
      await supertest(app).post('/webhooks/hris').send(VALID_HIRE);

      // Second event_id for the same email — should be accepted (INSERT OR IGNORE on employee)
      const second = await supertest(app).post('/webhooks/hris').send({
        ...VALID_HIRE,
        event_id: 'evt_hire_002',
      });
      expect(second.status).toBe(202);
      expect(second.body.idempotent).toBe(false);

      // Still only 3 grants (INSERT OR IGNORE on access_grants)
      const grants = db
        .prepare('SELECT app_name FROM access_grants WHERE employee_email = ?')
        .all('alex.chen@example.com') as { app_name: string }[];
      expect(grants).toHaveLength(3);

      // Two distinct audit rows
      const auditCount = db
        .prepare('SELECT COUNT(*) AS count FROM audit_log')
        .get() as { count: number };
      expect(auditCount.count).toBe(2);
    });
  });
});
