# SPEC.md — Mock IT Onboarding Automator

> Written before any application code, as required by the assignment.

---

## Problem Statement

When HR records a new hire, IT needs to grant the right application access based on the employee's role and maintain an audit trail of every provisioning action. Today that is a manual, error-prone process. This project automates it locally:

1. An HR system POSTs a webhook event to our service when someone is hired.
2. Our service looks up which mock SaaS apps that role should receive, writes grants to SQLite, and records an audit entry.
3. An MCP server (stdio) exposes three tools so an AI agent (e.g. Cursor or Claude Code) can inspect access and retry any failed provisioning events without touching the database directly.

---

## Architecture

```
┌──────────────┐     POST /webhooks/hris      ┌─────────────────────┐
│  Mock HRIS   │ ──────────────────────────▶  │   Express API        │
│  (curl/test) │                               │   api/webhook.ts     │
└──────────────┘                               └──────────┬──────────┘
                                                          │
                                              uses shared provisioning module
                                                          │
                                               ┌──────────▼──────────┐
                                               │  onboarding/         │
                                               │  provisioner.ts      │
                                               │  (validate, resolve, │
                                               │   write, idempotency)│
                                               └──────────┬──────────┘
                                                          │
                                               ┌──────────▼──────────┐
                                               │     SQLite (local)   │
                                               │  data/onboarding.db  │
                                               └──────────┬──────────┘
                                                          │
                                               ┌──────────▼──────────┐
                                               │   MCP Server (stdio) │
                                               │   mcp_server/        │
                                               │   server.ts          │
                                               └─────────────────────┘
                                                          ▲
                                                          │  JSON-RPC over stdio
                                               ┌──────────┴──────────┐
                                               │  Claude Code /       │
                                               │  MCP Inspector       │
                                               └─────────────────────┘
```

**Key architectural decision:** The provisioner module (`onboarding/provisioner.ts`) is shared by both the HTTP API and the MCP server. The same validation, role resolution, grant writing, and idempotency logic runs whether an event arrives via webhook or via a manual `retry_provision` call from the MCP server.

---

## Tech Choices & Rationale

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node.js 20+) | Mature MCP SDK available; strong typing models data contracts clearly |
| HTTP framework | Express 4 | Minimal, well-understood, no overhead for this scope |
| Database | SQLite via `better-sqlite3` | Local-only; synchronous API simplifies transaction handling, zero setup |
| MCP SDK | `@modelcontextprotocol/sdk` | Official SDK, stdio transport built-in |
| Test runner | Jest + `ts-jest` | First-class TypeScript support, familiar ecosystem |
| Schema migrations | Plain SQL init script (`data/init.sql`) | Minimal dependencies; migration tooling is out of scope |
| Stretch: LLM | `ollama` npm package → local Ollama | Free, offline, no credentials; only used for optional summaries — core flow never calls it |

---

## Repository Layout

```
.
├── SPEC.md                    # This file — written before app code
├── VIBE_LOG.md                # AI collaboration log
├── README.md                  # Setup and run instructions
├── AI_TRANSCRIPT.md           # Exported AI chat
├── CLAUDE.md                  # Claude Code rules file (AI steering)
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
│
├── onboarding/                # Domain logic (shared by API + MCP)
│   ├── provisioner.ts         # Core: validate → resolve → grant → audit
│   ├── db.ts                  # SQLite connection singleton
│   ├── types.ts               # Shared TypeScript interfaces
│   └── llm.ts                 # (stretch) Ollama summary helper
│
├── api/
│   ├── server.ts              # Express app entry point
│   └── webhook.ts             # POST /webhooks/hris route handler
│
├── mcp_server/
│   └── server.ts              # MCP stdio server with 3 tools
│
├── data/
│   └── init.sql               # Schema DDL + seed data
│
├── fixtures/
│   └── webhooks/
│       ├── valid_hire.json
│       ├── duplicate.json
│       └── invalid_role.json
│
└── tests/
    ├── webhook.test.ts        # Required: valid hire + duplicate event_id
    ├── errorPaths.test.ts     # Recommended: invalid role
    └── mcp.test.ts            # Recommended: MCP tool happy path
```

---

## Data Model

### `apps`
Catalog of mock SaaS applications.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | auto-increment |
| `name` | TEXT UNIQUE | e.g. `slack`, `google_workspace`, `jira`, `salesforce` |
| `display_name` | TEXT | Human-readable label |

### `role_app_grants`
Maps roles to their entitled apps.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `role` | TEXT | e.g. `engineer` |
| `app_name` | TEXT | FK → `apps.name` |

### `employees`
Canonical hire records.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `email` | TEXT UNIQUE | |
| `full_name` | TEXT | |
| `role` | TEXT | |
| `created_at` | TEXT | ISO-8601 |

### `access_grants`
Active grants per employee per app. Unique on `(employee_email, app_name)`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `employee_email` | TEXT | |
| `app_name` | TEXT | |
| `granted_at` | TEXT | ISO-8601 |

### `audit_log`
Immutable record of every provisioning action.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `event_id` | TEXT | |
| `action` | TEXT | `provisioned`, `idempotent_skip`, or `failed` |
| `details_json` | TEXT | JSON — **must include** `event_id`, `role`, `granted_apps`, `idempotent` |
| `created_at` | TEXT | ISO-8601 |

### `webhook_events`
Tracks every incoming webhook, enabling idempotency and retry.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `event_id` | TEXT UNIQUE | Natural key for idempotency check |
| `payload_json` | TEXT | Raw request body |
| `status` | TEXT | `pending` → `completed` or `failed` |
| `error_message` | TEXT | Populated on failure |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 — updated on every status transition |

> **Note on `updated_at`:** Must be declared explicitly in `data/init.sql` and updated on every status change — not just on insert. The MCP `list_failed_events` `since` filter queries this column.

The `init.sql` DDL for this table will be:

```sql
CREATE TABLE webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT UNIQUE NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### Seed Data

```sql
-- Apps
INSERT INTO apps (name, display_name) VALUES
  ('slack',             'Slack'),
  ('google_workspace',  'Google Workspace'),
  ('jira',              'Jira'),
  ('salesforce',        'Salesforce');

-- Role → App mappings
INSERT INTO role_app_grants (role, app_name) VALUES
  ('engineer', 'slack'),
  ('engineer', 'google_workspace'),
  ('engineer', 'jira'),
  ('sales', 'slack'),
  ('sales', 'google_workspace'),
  ('sales', 'salesforce'),
  ('it_admin', 'slack'),
  ('it_admin', 'google_workspace'),
  ('it_admin', 'jira'),
  ('it_admin', 'salesforce');
```

---

## Fixture Payloads

These are the exact JSON bodies in `fixtures/webhooks/` and referenced by tests.

### `fixtures/webhooks/valid_hire.json`
```json
{
  "event_id": "evt_hire_001",
  "event_type": "employee.hired",
  "email": "alex.chen@example.com",
  "full_name": "Alex Chen",
  "role": "engineer"
}
```

### `fixtures/webhooks/duplicate.json`
```json
{
  "event_id": "evt_hire_001",
  "event_type": "employee.hired",
  "email": "alex.chen@example.com",
  "full_name": "Alex Chen",
  "role": "engineer"
}
```
*(Identical to `valid_hire.json` — same `event_id` triggers the idempotent path. Tests will POST the valid hire payload twice in sequence rather than loading this file; `duplicate.json` exists as a reference fixture only.)*

### `fixtures/webhooks/invalid_role.json`
```json
{
  "event_id": "evt_hire_bad_role",
  "event_type": "employee.hired",
  "email": "bad.role@example.com",
  "full_name": "Bad Role",
  "role": "unknown_role_xyz"
}
```

---

## API Contract

### `POST /webhooks/hris`

**Validation rules:**
- All five fields (`event_id`, `event_type`, `email`, `full_name`, `role`) required
- `event_type` must be exactly `"employee.hired"`
- `role` must exist in `role_app_grants`

**Response codes:**

| Code | Condition |
|---|---|
| `202 Accepted` | New event processed successfully |
| `202 Accepted` | Duplicate `event_id` — already completed (idempotent replay, `"idempotent": true`) |
| `400 Bad Request` | Missing fields, wrong `event_type`, unknown role, or re-POST of a failed `event_id` |
| `409 Conflict` | Event currently `pending` (in-flight processing) |

**Successful response:**
```json
{
  "event_id": "evt_hire_001",
  "status": "completed",
  "idempotent": false,
  "employee": { "email": "alex.chen@example.com", "role": "engineer" },
  "granted_apps": ["slack", "google_workspace", "jira"]
}
```

**Error response (unknown role):**
```json
{
  "event_id": "evt_hire_bad_role",
  "error": "unknown_role",
  "message": "Unknown role: unknown_role_xyz"
}
```

---

## MCP Server

Transport: **stdio** (JSON-RPC 2.0 via `@modelcontextprotocol/sdk`)

> ⚠️ No writes to stdout anywhere in `mcp_server/server.ts`. All debug/error output goes to stderr only.

### Tools

#### `get_employee_access`
Email → role, full name, and list of active grants.

Input: `{ "email": string }`

Output:
```json
{
  "email": "alex.chen@example.com",
  "full_name": "Alex Chen",
  "role": "engineer",
  "granted_apps": ["slack", "google_workspace", "jira"]
}
```

#### `list_failed_events`
Returns all `webhook_events` with `status = "failed"`. Optional ISO-8601 `since` parameter filters on `updated_at` (the time the event last changed status). The response returns both `created_at` and `updated_at` so callers can see when the event arrived and when it last failed.

Input: `{ "since"?: string }`

Output:
```json
[
  {
    "event_id": "evt_hire_bad_role",
    "error_message": "Unknown role: unknown_role_xyz",
    "created_at": "2024-01-01T10:00:00.000Z",
    "updated_at": "2024-01-01T10:00:00.000Z"
  }
]
```

> **Query note:** `WHERE status = 'failed' AND updated_at >= ?` — filter is on `updated_at`, both columns are returned in the response.

#### `retry_provision`
Re-runs provisioning for a **failed** `event_id` using the same shared provisioner module.

Input: `{ "event_id": string }`

Output:
```json
{
  "event_id": "evt_hire_bad_role",
  "status": "completed",
  "granted_apps": ["slack", "google_workspace", "jira"]
}
```

### MCP Server Config (Claude Code)

Register via the Claude Code CLI (user-level config at `~/.claude/mcp_servers.json`):

```bash
claude mcp add onboarding-automator node dist/mcp_server/server.js
```

Smoke-test before wiring into Claude Code:
```bash
npx @modelcontextprotocol/inspector node dist/mcp_server/server.js
```

---

## Idempotency Strategy

| Existing `webhook_events` status | Webhook POST behaviour | Retry via MCP |
|---|---|---|
| Row not found | Insert `pending`, process, update to `completed`/`failed` | N/A |
| `completed` | Return 202 `idempotent: true`, no writes | N/A |
| `pending` | Return 409 | N/A |
| `failed` | Return 400 (see assumption below) | `retry_provision` resets to `pending` and re-runs provisioner |

> **Design assumption (also in README Assumptions):** The assignment requires idempotency on `event_id` but does not define behaviour for re-POSTing a *failed* event. We return 400 to prevent silent accidental re-provisioning — operators who need to retry must use the `retry_provision` MCP tool, which carries explicit intent. This keeps the webhook handler's idempotency contract simple and auditable.

---

## Test Plan

| File | Case | Assertions |
|---|---|---|
| `webhook.test.ts` | Valid hire | Employee row created, grants match role's app list, `audit_log` entry written with correct `details_json` keys, `webhook_events.status = "completed"` |
| `webhook.test.ts` | Duplicate `event_id` | Second POST returns 202 with `"idempotent": true`, no new rows in `access_grants` or `audit_log` |
| `errorPaths.test.ts` | Invalid role | Returns 400, `webhook_events.status = "failed"`, zero rows in `access_grants` |
| `mcp.test.ts` | `get_employee_access` | Returns correct `role`, `full_name`, and `granted_apps` array for a provisioned email |

Run all tests with: `npm test`

---

## Required Implementation Markers

Checked mechanically during review:

1. **Structured stderr log on successful provisioning** — must include `event_id` and granted-app count.
   Format: `{"event":"provisioned","event_id":"evt_hire_001","granted_apps_count":3}`

2. **`audit_log.details_json`** for completed events must contain the keys: `event_id`, `role`, `granted_apps`, `idempotent`.

3. **MCP retry tool named exactly `retry_provision`** — not `retry_event`, not `requeue`.

---

## AI Collaboration Rules (CLAUDE.md)

A `CLAUDE.md` file at the repo root will encode the following constraints for Claude Code (equivalent to `.cursor/rules/`):

- Never write to stdout in `mcp_server/server.ts` — use `process.stderr` only
- All provisioning logic lives in `onboarding/provisioner.ts` — do not duplicate grant logic in route handlers or MCP tools
- All DB access goes through the `onboarding/db.ts` singleton — no direct `better-sqlite3` imports elsewhere
- Tests use Jest with `ts-jest` — do not modify `jest.config.ts` without confirming
- Do not add npm dependencies without confirming first
- `audit_log.details_json` must always include `event_id`, `role`, `granted_apps`, `idempotent`

---

## Stretch Goal: Ollama Integration

After a successful provisioning, the provisioner optionally calls a local Ollama model to generate a plain-English onboarding summary, logged to stderr. This is purely additive — if Ollama is not running the system skips silently.

**Package:** `ollama` (npm) — `npm install ollama`
**Model:** `llama3` (default) or `mistral` — configurable via `OLLAMA_MODEL` env var
**Endpoint:** `http://localhost:11434` (Ollama default)

```ts
// onboarding/llm.ts (stretch)
// generateOnboardingSummary(employee, grantedApps): Promise<string | null>
// - POST to Ollama /api/generate with model + prompt
// - returns null on any network/timeout error (non-blocking)
// - caller logs result to stderr only
```

---

## Git Checkpoints

| Tag | Meaning |
|---|---|
| `v1-webhook` | `POST /webhooks/hris` accepts valid hire, writes grants + audit |
| `v2-mcp` | MCP server runs over stdio, `tools/list` returns all 3 tools |
| `v3-final` | Idempotency, error paths, tests passing, README + VIBE_LOG done |

---

## Known Limitations & Future Work

| Limitation | What I'd do with more time |
|---|---|
| No authentication on the webhook endpoint | Add HMAC signature verification (`X-Hub-Signature-256`) |
| SQLite is single-writer | Swap to PostgreSQL + connection pool for multi-process production use |
| Role list is seeded at init time | Add `POST /admin/roles` to manage roles at runtime |
| No retry backoff or queue | BullMQ with exponential backoff for production reliability |
| No pagination on `list_failed_events` | Add `limit` + `offset` params |
| Ollama stretch goal is additive | Make it configurable per deployment via env var |

---

*End of SPEC.md*
