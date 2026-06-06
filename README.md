# IT Onboarding Automator

A mock IT onboarding service that automatically provisions SaaS application access when HR records a new hire. Built as a take-home technical assessment for Appfire.

---

## What It Does

1. **HR system** POSTs a webhook event to `POST /webhooks/hris` when an employee is hired
2. The service validates the payload, resolves which apps the role should receive, writes grants to SQLite, and records an immutable audit entry
3. An **MCP server** (stdio) exposes three tools so an AI agent (e.g. Claude Code) can inspect access and retry any failed provisioning events without touching the database directly

---

## Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node.js 20+) |
| HTTP framework | Express 4 |
| Database | SQLite via `better-sqlite3` |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Test runner | Jest + `ts-jest` |
| Schema | Plain SQL init script (`data/init.sql`) |

---

## Prerequisites

- **Node.js 20+** — `node --version`
- **npm 10+** — `npm --version`
- **npx** — bundled with npm 10, used for the MCP Inspector smoke-test
- **Ollama** — optional; only needed for the stretch-goal LLM summary feature

No other global installs are required.

---

## Setup (clean machine)

### 1. Clone and enter the repo

```bash
git clone <repo-url>
cd it-onboarding-automator
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

The defaults in `.env` work out of the box:

```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
DB_PATH=data/onboarding.db
OLLAMA_BASE_URL=http://localhost:11434   # stretch goal only
OLLAMA_MODEL=llama3                      # stretch goal only
```

### 4. Initialise the database

```bash
npm run db:init
```

This creates `data/onboarding.db`, runs the DDL from `data/init.sql`, and seeds the apps and role→app mappings. Expected output:

```
[db] Schema initialised from data/init.sql (.../data/onboarding.db)
```

If you run it again on an existing DB it exits silently (idempotent).

### 5. Start the development server

```bash
npm run dev
```

Expected output (all on **stderr**, port **3000**):

```
[db] Connected to existing database at .../data/onboarding.db
{"level":"info","ts":"2024-01-01T10:00:00.000Z","msg":"Server started","port":3000,"log_level":"info"}
```

---

## Running

### Development (TypeScript, compiled on the fly)

```bash
npm run dev
```

### Production (compile first)

```bash
npm run build
npm start
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the Express server listens on |
| `NODE_ENV` | `development` | Runtime environment |
| `LOG_LEVEL` | `info` | Minimum log level written to stderr. Valid values: `debug` \| `info` \| `warn` \| `error` |
| `DB_PATH` | `data/onboarding.db` | Path to the SQLite database file. Set to `:memory:` to use an in-memory DB (used by tests). |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL (stretch goal only) |
| `OLLAMA_MODEL` | `llama3` | Ollama model name (stretch goal only). e.g. `mistral` |

---

## Testing

```bash
npm test
```

All tests use an **isolated in-memory SQLite database** — they never touch `data/onboarding.db`. Each test gets a completely fresh database via `jest.resetModules()` + `DB_PATH=:memory:` in `beforeEach`.

```bash
npm run test:watch     # re-run on file changes
npm run test:coverage  # generate coverage report in coverage/
```

Expected output:

```
PASS tests/webhook.test.ts
  POST /webhooks/hris
    valid hire
      ✓ engineer: 202, DB rows correct, audit_log has all 4 required keys
      ✓ sales: 202 with correct 3 apps (slack, google_workspace, salesforce)
      ✓ it_admin: 202 with all 4 apps
    idempotency
      ✓ duplicate event_id: 202 idempotent:true, no new rows in grants or audit_log
      ✓ idempotent response returns the same granted_apps and employee as the original
      ✓ multiple replays of the same event_id all return 202 idempotent:true
    input validation
      ✓ missing role → 400 missing_field
      ✓ missing email → 400 missing_field
      ✓ missing event_id → 400 missing_field
      ✓ wrong event_type → 400 invalid_event_type
      ✓ empty body → 400 missing_field
    error paths
      ✓ invalid role: 400, webhook_events failed, zero access_grants
      ✓ invalid role: no employee row created
      ✓ re-POST of failed event_id: 400 already_failed, webhook_events still failed
      ✓ different event_ids for same email succeed independently

PASS tests/mcp.test.ts
  MCP tools
    extractArg (MCP Inspector input parsing)
      ✓ plain string value → returns it unchanged
      ✓ JSON-wrapped string (Inspector form-mode bug) → extracts the key value
      ✓ object value → extracts the named key
      ✓ (+ 5 more edge-case tests)
    get_employee_access
      ✓ engineer: correct email, full_name, role, and 3 apps
      ✓ sales: correct 3 apps (slack, google_workspace, salesforce)
      ✓ it_admin: all 4 apps
      ✓ throws for an email that has not been provisioned
      ✓ after retry_provision succeeds, returns the correct grants
    list_failed_events
      ✓ returns empty array when no events have failed
      ✓ returns the failed event with all required fields
      ✓ since filter: excludes events before cutoff, includes events at or after
      ✓ multiple failed events all appear in the list
      ✓ successfully retried event is no longer returned
    retry_provision
      ✓ throws for a nonexistent event_id
      ✓ throws when event is completed (not in failed state)
      ✓ succeeds after seeding the corrected role mapping
      ✓ retry success writes an audit_log entry with all 4 required keys
      ✓ retry → completed → retry again throws "not in failed state"
      ✓ webhook_events row preserves original created_at after retry

Tests: 39 passed, 39 total
```

---

## API

### `POST /webhooks/hris`

Accepts a new-hire event from the HR system.

**Validation rules:**
- All five fields required: `event_id`, `event_type`, `email`, `full_name`, `role`
- `event_type` must be exactly `"employee.hired"`
- `role` must exist in the seeded `role_app_grants` table

**Seeded roles and their app grants:**

| Role | Apps granted |
|---|---|
| `engineer` | slack, google_workspace, jira |
| `sales` | slack, google_workspace, salesforce |
| `it_admin` | slack, google_workspace, jira, salesforce |

**Response codes:**

| Code | Condition |
|---|---|
| `202 Accepted` | New event processed successfully |
| `202 Accepted` | Duplicate `event_id` — already completed (`"idempotent": true`) |
| `400 Bad Request` | Missing field / wrong `event_type` / unknown role / re-POST of a failed event |
| `409 Conflict` | Event currently `pending` (in-flight processing) |

---

### Example curl requests

Run these after `npm run dev` in a separate terminal.

#### 1. Valid hire → 202

```bash
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/valid_hire.json | jq .
```

Expected response:

```json
{
  "event_id": "evt_hire_001",
  "status": "completed",
  "idempotent": false,
  "employee": {
    "email": "alex.chen@example.com",
    "role": "engineer"
  },
  "granted_apps": [
    "slack",
    "google_workspace",
    "jira"
  ]
}
```

#### 2. Duplicate replay → 202 idempotent:true

```bash
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/duplicate.json | jq .
```

Expected response (same `event_id` as above — idempotent replay, no writes):

```json
{
  "event_id": "evt_hire_001",
  "status": "completed",
  "idempotent": true,
  "employee": {
    "email": "alex.chen@example.com",
    "role": "engineer"
  },
  "granted_apps": [
    "slack",
    "google_workspace",
    "jira"
  ]
}
```

#### 3. Invalid role → 400

```bash
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/invalid_role.json | jq .
```

Expected response:

```json
{
  "event_id": "evt_hire_bad_role",
  "error": "unknown_role",
  "message": "Unknown role: unknown_role_xyz"
}
```

---

## MCP Server

The MCP server runs as a **stdio process** — it does not bind to a network port. All server output goes to **stderr only**; stdout is reserved for MCP JSON-RPC messages.

### Register with Claude Code

Build first, then register:

```bash
npm run build
claude mcp add onboarding-automator node dist/mcp_server/server.js
```

### Smoke-test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/mcp_server/server.js
```

The Inspector opens a local web UI where you can list and call all three tools interactively.

### Available tools

| Tool | Input | Description |
|---|---|---|
| `get_employee_access` | `{ email: string }` | Email → role, full name, and list of active grants |
| `list_failed_events` | `{ since?: string }` | All failed webhook events. Optional ISO-8601 `since` filter on `updated_at` |
| `retry_provision` | `{ event_id: string }` | Re-run provisioning for a failed event using the original payload |

**`retry_provision` notes:**
- Only works on events with `status = "failed"`
- Resets status to `"pending"` then re-runs the shared provisioner
- Returns `{ event_id, status: "completed", granted_apps }` on success

---

## Repository Layout

```
.
├── SPEC.md                    # Full specification — written before any code
├── AI_TRANSCRIPT.md           # Log of every AI-assisted change in this session
├── VIBE_LOG.md                # AI collaboration narrative
├── README.md                  # This file
├── CLAUDE.md                  # Claude Code steering rules
├── package.json
├── tsconfig.json
├── jest.config.ts
├── .env.example               # Environment variable reference (commit this)
├── .env                       # Local values — git-ignored
│
├── onboarding/                # Domain logic — shared by API and MCP server
│   ├── provisioner.ts         # Core: validate → resolve → grant → audit + retry
│   ├── db.ts                  # SQLite connection singleton (all DB access goes here)
│   ├── types.ts               # Shared TypeScript interfaces
│   └── logger.ts              # Structured JSON logger — stderr only
│
├── api/
│   ├── server.ts              # Express app factory + entry point
│   └── webhook.ts             # POST /webhooks/hris — thin adapter over provisioner
│
├── mcp_server/
│   └── server.ts              # MCP stdio server — 3 tools, thin adapters over provisioner
│
├── data/
│   └── init.sql               # Schema DDL + seed data (auto-run on first boot)
│
├── fixtures/webhooks/
│   ├── valid_hire.json        # evt_hire_001 — engineer role
│   ├── duplicate.json         # Same as valid_hire — triggers idempotent path
│   └── invalid_role.json      # unknown_role_xyz — triggers 400 path
│
└── tests/
    ├── webhook.test.ts        # POST /webhooks/hris — 15 tests (happy path, idempotency, validation, errors)
    └── mcp.test.ts            # MCP tool handlers — 24 tests (extractArg, all 3 tools, state machine)
```

---

## Database

SQLite file at `data/onboarding.db` (git-ignored, auto-created on first run).

Six tables: `apps`, `role_app_grants`, `employees`, `access_grants`, `audit_log`, `webhook_events`.

To inspect the live database:

```bash
sqlite3 data/onboarding.db

sqlite> SELECT * FROM employees;
sqlite> SELECT * FROM access_grants;
sqlite> SELECT action, details_json FROM audit_log;
sqlite> SELECT event_id, status, error_message FROM webhook_events;
```

---

## Design Assumptions

1. **Re-POST of a failed event returns 400.** The SPEC requires idempotency on `event_id` but does not define behaviour for re-POSTing a *failed* event. Returning 400 prevents silent accidental re-provisioning. Operators who need to retry must use the `retry_provision` MCP tool, which carries explicit intent and keeps the webhook handler's idempotency contract simple and auditable.

2. **`retry_provision` resets to `pending` via UPDATE, not DELETE.** Preserves the original `created_at` timestamp so the audit trail reflects when the event first arrived.

3. **All logs go to stderr.** Stdout is reserved exclusively for MCP JSON-RPC messages — any write to stdout corrupts the stdio transport.

4. **No authentication on the webhook endpoint.** Out of scope for this exercise. Production would use HMAC signature verification (`X-Hub-Signature-256`).

5. **Role list is seeded at init time.** There is no `POST /admin/roles` endpoint. Adding a role requires updating `data/init.sql` and re-running `npm run db:init` (or a schema migration in production).

---

## Stretch Goal — Ollama LLM Summary

After a successful provisioning, the provisioner can optionally call a local Ollama model to generate a plain-English onboarding summary, logged to stderr. If Ollama is not running the system skips silently — the core flow is never blocked.

```bash
# Pull and start Ollama
ollama pull llama3
ollama serve
```

Set `OLLAMA_MODEL` in `.env` to switch models (e.g. `mistral`).
Set `OLLAMA_BASE_URL` to point at a remote Ollama instance.

The integration lives in `onboarding/llm.ts` (stretch goal module, additive only).

---

## Git Checkpoints

| Tag | Meaning |
|---|---|
| `v1-webhook` | `POST /webhooks/hris` accepts valid hire, writes grants + audit |
| `v2-mcp` | MCP server runs over stdio, `tools/list` returns all 3 tools |
| `v3-final` | Idempotency, error paths, all tests passing, README + VIBE_LOG complete |

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
