# AI_TRANSCRIPT.md — IT Onboarding Automator

> Log of every AI-assisted change in this session. Appended after each prompt.

---

## Session kickoff & rules established

**Prompt:** Shared `Technical_Assignment_-_Appfire.pdf` and `SPEC.md`. Established session rules:
- Stack: TypeScript + Node.js 20+, Express 4, better-sqlite3, @modelcontextprotocol/sdk, Jest + ts-jest
- Spec-first / incremental build — no whole-repo generation in one shot
- After every change: append entry to `AI_TRANSCRIPT.md`
- Never write to stdout in `mcp_server/server.ts` — stderr only
- All DB access through `onboarding/db.ts` singleton
- All provisioning logic in `onboarding/provisioner.ts` — no duplication in handlers or MCP tools

**What you generated:** Confirmed reading of both files. Summarised PDF requirements, SPEC.md architecture, data model, MCP tools, idempotency strategy, and required implementation markers.

**Outcome:** Working — session context established, ready to build incrementally.

---

## Workflow preferences saved

**Prompt:** Always make changes in local repo only (never push to remote or create PRs unless explicitly asked). For each change, create a checkpoint file with diff, new additions, reasons, and revert instructions.

**What you generated:** Saved two memory files (`feedback_workflow.md`, `project_context.md`) and updated `MEMORY.md` index. Defined checkpoint file convention: `checkpoints/YYYYMMDD-HHMMSS-<slug>.md`.

**Outcome:** Working — preferences persisted to memory for future sessions.

---

## Created AI_TRANSCRIPT.md

**Prompt:** Create `AI_TRANSCRIPT.md` and include past prompts of this chat.

**What you generated:** Created `AI_TRANSCRIPT.md` at repo root with backfilled entries for all prior prompts in this session. Created checkpoint `checkpoints/20260606-000001-create-ai-transcript.md`.

**Outcome:** Working.

---

## .env setup and .gitignore expansion

**Prompt:** Keep updating .gitignore as new files/directories are created. Create `.env`, add it to `.gitignore`, and create `.env.example` with just the key names.

**What you generated:** Expanded `.gitignore` with sections for `.env`, `node_modules/`, `dist/`, and SQLite DB files. Created `.env` with dev values (git-ignored) and `.env.example` with empty key names for reference. Checkpoint `20260606-000002-env-and-gitignore.md` written.

**Outcome:** Working.

---

## Database layer — data/init.sql + onboarding/db.ts

**Prompt:** Create `data/init.sql` with full schema and seed data per SPEC.md (all 6 tables, 4 apps, 10 role mappings, webhook_events.updated_at strftime default). Create `onboarding/db.ts` as a better-sqlite3 singleton that runs init.sql on first boot. Verify with SQLite CLI and show output.

**What you generated:** `data/init.sql` with 6 tables (IF NOT EXISTS guards, CHECK constraints, strftime defaults) and seed data (INSERT OR IGNORE). `onboarding/db.ts` singleton with WAL mode, DB_PATH env support, and first-boot init guard on `apps` table presence. Verified via `sqlite3` CLI against a temp DB — all tables, 4 app rows, 10 role_app_grant rows, correct webhook_events column list with updated_at default. Checkpoint `20260606-000003-db-layer.md` written.

**Outcome:** Working — verification output matches SPEC.md exactly.

---

## .gitignore full audit and fix

**Prompt:** Analyse and verify .gitignore has everything needed; update if not.

**What you generated:** Found two critical bugs — `AI_TRANSCRIPT.md` and `checkpoints/` were both being silently ignored. Fixed by removing them. Added missing patterns: `.AppleDouble`, `.LSOverride`, `.env.local`, `npm-debug.log*`, `yarn-*.log`, `package-lock.json`, `*.tsbuildinfo`, `coverage/`, `.jest-cache/`, `*.log`. Verified with `git check-ignore` that all required-to-track files are unignored and all generated/secret files are ignored. Checkpoint `20260606-000004-gitignore-audit.md` written.

**Outcome:** Working — two bugs fixed, six new patterns added, all verified clean.

---

## Webhook handler + provisioner + tests (core)

**Prompt:** Build end-to-end: logger, types, provisioner (with transaction, idempotency, audit log), Express webhook handler, server factory, fixture JSONs, and 4 Jest tests. Run `npm test` and fix failures before declaring done.

**What you generated:** `package.json` (Express 4.22.2, Jest 29.7.0, TS 5.9.3), `tsconfig.json`, `jest.config.ts`. `onboarding/logger.ts` (structured JSON → stderr, LOG_LEVEL-aware). `onboarding/types.ts` (7 interfaces). Updated `onboarding/db.ts` (`:memory:` guard for tests). `onboarding/provisioner.ts` (full 10-step flow, transaction on steps 5–9, INSERT pending outside transaction so catch can flip to failed). `api/webhook.ts` (POST /webhooks/hris, delegates fully to provisioner). `api/server.ts` (createApp factory, listen only when require.main === module). Fixture JSONs. `tests/webhook.test.ts` (4 tests using jest.resetModules + DB_PATH=:memory: isolation). Fixed two TypeScript cast errors (`as Record<string, unknown>` → `as unknown as Record<string, unknown>`) and ts-jest globals deprecation. Checkpoint `20260606-000005-webhook-provisioner-tests.md` written.

**Outcome:** Working — 4/4 tests green on first full run after fixes.

---

## SPEC architecture audit + violation fix

**Prompt:** Verify MCP flow follows SPEC strictly. Audit that validation, provisioning, idempotency, and retry logic live exclusively in provisioner.ts. Show violations. Verify .gitignore completeness.

**What you generated:** Full audit across all source files. Found one hard violation: `mcp_server/server.ts::handleRetryProvision` contained status validation, payload parsing, and a direct `DELETE FROM webhook_events` DB write — all business logic that SPEC requires in provisioner.ts. Also found a SPEC deviation: DELETE+re-insert instead of UPDATE to "pending". Fixed by: (1) extracting private `runProvisionTransaction()` and `markFailed()` helpers from `provisionEmployee`, (2) adding exported `retryProvisionEmployee(eventId)` to provisioner.ts that owns all retry logic and uses UPDATE to reset to "pending" per SPEC, (3) reducing `handleRetryProvision` in MCP server to a 3-line wrapper. Removed now-unused `provisionEmployee` and `WebhookPayload` imports from MCP server. gitignore verified complete — no changes needed. All 13 tests green. Checkpoint `20260606-000009-spec-architecture-audit.md` written.

**Outcome:** Working — 1 hard violation fixed, 1 SPEC deviation corrected, 13/13 tests green.

---

## SPEC compliance + .gitignore full audit

**Prompt:** Verify database and webhook handler match SPEC.md exactly; verify .gitignore is complete.

**What you generated:** Ran full systematic audit — schema columns/constraints/defaults, seed data counts, response codes, response shapes, CLAUDE.md rules (no stdout, singleton, no duplicated logic), required implementation markers. All passed. Found one .gitignore issue: `package-lock.json` was being ignored, risking non-reproducible installs for the reviewer — removed it from .gitignore. Checkpoint `20260606-000006-spec-gitignore-audit.md` written.

**Outcome:** Working — everything matches SPEC; one .gitignore bug fixed (package-lock.json now tracked).

---

## README.md + tsconfig declaration fix

**Prompt:** Create README.md as a complete setup guide for a reviewer on a clean machine. Use actual project structure, scripts, and dependencies — do not invent commands. Log what we have done so far.

**What you generated:** Discovered `npm run build` failing with TS4023 (`db` export can't be named in .d.ts — BetterSqlite3.Database uses `export =` module). Fixed by disabling declaration generation in tsconfig.json (`declaration: false`, `declarationMap: false`) — correct for an application project. Verified build exits 0, server starts, curl returns correct JSON. Wrote `README.md` with: prerequisites, 3-step setup (clone/install/env), dev + production run commands, full test output, API reference with curl examples, role/grant table, MCP server status, repo layout, DB inspect commands, design assumptions, and Ollama stretch goal. Checkpoint `20260606-000007-readme-tsconfig-fix.md` written.

**Outcome:** Working — build clean (exit 0), 4/4 tests green, README verified end-to-end.

---

## MCP server + tests

**Prompt:** Create `mcp_server/server.ts` with stdio transport and exactly 3 tools: `get_employee_access`, `list_failed_events`, `retry_provision`. Match SPEC.md exactly. Verify with tools/list smoke-test, mcp.test.ts, and grep for stdout.

**What you generated:** Investigated MCP SDK v1.29.0 CJS import paths — `@modelcontextprotocol/sdk/server`, `server/stdio.js`, `types.js`. Fixed TypeScript resolution by adding `baseUrl` + `paths` in tsconfig.json (SDK uses package exports that `moduleResolution: "node"` doesn't understand). Wrote `mcp_server/server.ts` with exported handler functions (`handleGetEmployeeAccess`, `handleListFailedEvents`, `handleRetryProvision`), MCP server wired via ListToolsRequestSchema/CallToolRequestSchema handlers, stdio transport guarded behind `require.main === module`. `retry_provision` deletes the failed row then calls `provisionEmployee()` fresh. No stdout anywhere. Wrote `tests/mcp.test.ts` with 9 tests (get_employee_access happy path + not-found, list_failed_events with/without since filter, retry_provision error cases + success after seeding role). Checkpoint `20260606-000008-mcp-server.md` written.

**Outcome:** Working — 13/13 tests green, tools/list returns exactly 3 named tools, zero stdout writes confirmed.

---
