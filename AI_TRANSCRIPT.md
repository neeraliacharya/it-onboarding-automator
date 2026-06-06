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
