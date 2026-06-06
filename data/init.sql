-- =============================================================================
-- IT Onboarding Automator — Database Schema
-- Matches SPEC.md data model exactly.
-- Run once on first boot; tables are created with IF NOT EXISTS guards.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- apps: Catalog of mock SaaS applications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    UNIQUE NOT NULL,
  display_name TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- role_app_grants: Maps roles to their entitled apps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_app_grants (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  role     TEXT NOT NULL,
  app_name TEXT NOT NULL,
  FOREIGN KEY (app_name) REFERENCES apps (name)
);

-- ---------------------------------------------------------------------------
-- employees: Canonical hire records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT UNIQUE NOT NULL,
  full_name  TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- access_grants: Active grants per employee per app
-- Unique on (employee_email, app_name) to prevent duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_email TEXT NOT NULL,
  app_name       TEXT NOT NULL,
  granted_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (employee_email, app_name)
);

-- ---------------------------------------------------------------------------
-- audit_log: Immutable record of every provisioning action.
-- details_json MUST include: event_id, role, granted_apps, idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('provisioned', 'idempotent_skip', 'failed')),
  details_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- webhook_events: Idempotency and retry tracking for every incoming webhook.
-- updated_at must be kept current on every status transition —
-- list_failed_events MCP tool filters on this column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT UNIQUE NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'failed')),
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- =============================================================================
-- Seed Data
-- INSERT OR IGNORE so re-running init.sql never duplicates rows.
-- =============================================================================

-- Apps
INSERT OR IGNORE INTO apps (name, display_name) VALUES
  ('slack',            'Slack'),
  ('google_workspace', 'Google Workspace'),
  ('jira',             'Jira'),
  ('salesforce',       'Salesforce');

-- Role → App mappings
-- engineer: slack, google_workspace, jira
-- sales:    slack, google_workspace, salesforce
-- it_admin: slack, google_workspace, jira, salesforce
INSERT OR IGNORE INTO role_app_grants (role, app_name) VALUES
  ('engineer', 'slack'),
  ('engineer', 'google_workspace'),
  ('engineer', 'jira'),
  ('sales',    'slack'),
  ('sales',    'google_workspace'),
  ('sales',    'salesforce'),
  ('it_admin', 'slack'),
  ('it_admin', 'google_workspace'),
  ('it_admin', 'jira'),
  ('it_admin', 'salesforce');
