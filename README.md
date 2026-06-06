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

- **Node.js 20+** — check with `node --version`
- **npm 9+** — check with `npm --version`
- No other global installs required

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

Open `.env` and fill in the values (defaults shown below work out of the box):

```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
DB_PATH=data/onboarding.db
OLLAMA_BASE_URL=http://localhost:11434   # stretch goal only
OLLAMA_MODEL=llama3                      # stretch goal only
```

`LOG_LEVEL` valid values: `debug` | `info` | `warn` | `error`

The SQLite database is created automatically on first run — no migration step needed.

---

## Running

### Development (TypeScript, auto-compiled)

```bash
npm run dev
```

### Production (compile first, then run)

```bash
npm run build
npm start
```

Server starts on `PORT` (default **3000**) and logs to **stderr** in structured JSON.

---

## Testing

```bash
npm test
```

All tests use an isolated in-memory SQLite database — they never touch `data/onboarding.db`.

```bash
npm run test:watch     # re-run on file changes
npm run test:coverage  # generate coverage report in coverage/
```

Expected output:

```
PASS tests/webhook.test.ts
  POST /webhooks/hris
    ✓ valid hire: 202, employee row, correct grants, audit_log keys, webhook completed
    ✓ duplicate event_id: 202 idempotent:true, no new rows in grants or audit_log
    ✓ invalid role: 400 unknown_role, webhook_events failed, zero access_grants
    ✓ re-POST of failed event_id: 400 (must use retry_provision MCP tool instead)

Tests: 4 passed, 4 total
```

---

## API

### `POST /webhooks/hris`

Accepts a new-hire event from the HR system.

**Request body:**

```json
{
  "event_id":   "evt_hire_001",
  "event_type": "employee.hired",
  "email":      "alex.chen@example.com",
  "full_name":  "Alex Chen",
  "role":       "engineer"
}
```

**Seeded roles and their app grants:**

| Role | Apps granted |
|---|---|
| `engineer` | slack, google_workspace, jira |
| `sales` | slack, google_workspace, salesforce |
| `it_admin` | slack, google_workspace, jira, salesforce |

**Response codes:**

| Code | Condition |
|---|---|
| `202` | New event processed successfully |
| `202` | Duplicate `event_id` — already completed (`"idempotent": true`) |
| `400` | Missing field / wrong `event_type` / unknown role / re-POST of a failed event |
| `409` | Event currently `pending` (in-flight processing) |

**Success response:**

```json
{
  "event_id":    "evt_hire_001",
  "status":      "completed",
  "idempotent":  false,
  "employee":    { "email": "alex.chen@example.com", "role": "engineer" },
  "granted_apps": ["slack", "google_workspace", "jira"]
}
```

**Error response (unknown role):**

```json
{
  "event_id": "evt_hire_bad_role",
  "error":    "unknown_role",
  "message":  "Unknown role: unknown_role_xyz"
}
```

**Try it with curl** (after `npm run dev`):

```bash
# Valid hire
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/valid_hire.json | jq .

# Duplicate (idempotent)
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/duplicate.json | jq .

# Invalid role
curl -s -X POST http://localhost:3000/webhooks/hris \
  -H "Content-Type: application/json" \
  -d @fixtures/webhooks/invalid_role.json | jq .
```

---

## MCP Server

> **Status: in progress — not yet wired up**

The MCP server will be registered with Claude Code via:

```bash
claude mcp add onboarding-automator node dist/mcp_server/server.js
```

And smoke-tested with:

```bash
npx @modelcontextprotocol/inspector node dist/mcp_server/server.js
```

Three tools will be exposed:

| Tool | Description |
|---|---|
| `get_employee_access` | Email → role, full name, and active grants |
| `list_failed_events` | All failed webhook events (optional `since` ISO-8601 filter) |
| `retry_provision` | Re-run provisioning for a failed `event_id` |

---

## Repository Layout

```
.
├── SPEC.md                    # Full specification (written before app code)
├── AI_TRANSCRIPT.md           # Log of every AI-assisted change
├── VIBE_LOG.md                # AI collaboration narrative (in progress)
├── README.md                  # This file
├── CLAUDE.md                  # Claude Code steering rules (in progress)
├── package.json
├── tsconfig.json
├── jest.config.ts
├── .env.example               # Environment variable reference
│
├── onboarding/                # Domain logic — shared by API + MCP
│   ├── provisioner.ts         # Core: validate → resolve → grant → audit
│   ├── db.ts                  # SQLite connection singleton
│   ├── types.ts               # Shared TypeScript interfaces
│   ├── logger.ts              # Structured JSON logger (stderr only)
│   └── llm.ts                 # (stretch) Ollama summary helper
│
├── api/
│   ├── server.ts              # Express app factory + entry point
│   └── webhook.ts             # POST /webhooks/hris route handler
│
├── mcp_server/
│   └── server.ts              # MCP stdio server — 3 tools (in progress)
│
├── data/
│   └── init.sql               # Schema DDL + seed data (auto-run on first boot)
│
├── fixtures/webhooks/
│   ├── valid_hire.json
│   ├── duplicate.json
│   └── invalid_role.json
│
├── tests/
│   ├── webhook.test.ts        # Required: valid hire, duplicate, invalid role, re-POST
│   ├── errorPaths.test.ts     # Recommended: additional error paths (in progress)
│   └── mcp.test.ts            # Recommended: MCP tool happy path (in progress)
│
└── checkpoints/               # Per-change snapshots for revert tracking
```

---

## Database

SQLite file at `data/onboarding.db` (created automatically). Schema is defined in `data/init.sql` and applied once on first boot.

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

- **Re-POST of a failed event returns 400** — the SPEC requires idempotency on `event_id` but does not define behaviour for re-POSTing a *failed* event. Returning 400 prevents silent accidental re-provisioning. Operators who need to retry must use the `retry_provision` MCP tool, which carries explicit intent.
- **SQLite WAL mode** is enabled for better concurrent read performance.
- **All logs go to stderr** — stdout is reserved for MCP JSON-RPC communication and must remain clean.

---

## Stretch Goal — Ollama LLM Summary

After a successful provisioning, the provisioner optionally calls a local Ollama model to generate a plain-English onboarding summary, logged to stderr. If Ollama is not running the system skips silently — the core flow is never blocked.

```bash
# Pull and start Ollama (if you want to test the stretch goal)
ollama pull llama3
ollama serve
```

Set `OLLAMA_MODEL` in `.env` to switch models (e.g. `mistral`).
