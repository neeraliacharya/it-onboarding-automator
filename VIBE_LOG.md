AI Tools Used

- Kiro.ai and Claude.ai — planning, architecture, and SPEC.md. All the big design decisions, before a single file was created.

- Claude Code — everything implementation-related. Explicitly told it not to generate the whole repo at once — and had to remind it of that a couple of times.

---

## AI Code That Worked First Time and Shipped As-Is

1. The provisioner transaction logic

This was the part I was most worried about getting right — the 10-step flow with a better-sqlite3 transaction, and specifically the decision to insert the webhook_events row as pending outside the transaction so a rollback can still change it back it to failed. Claude Code got this correct on the first attempt, matching SPEC.md exactly. I reviewed it line by line a and all 4 webhook tests went green on the first run.

2. The structured JSON logger

Told Claude Code to write a LOG_LEVEL-aware logger that outputs JSON to stderr. It generated exactly the same — including the fallback to plain string write if JSON.stringify fails, which I hadn't explicitly asked for but was the right defensive move. Used it everywhere without modification.

---

## Where AI Got It Wrong

- The MCP retry violation

When Claude Code first built `mcp_server/server.ts`, the `handleRetryProvision` function looked fine — it worked, tests passed. But it had put status validation, payload parsing, and a direct `DELETE FROM webhook_events` write inside the MCP handler. That's what SPEC.md says it must never happen.

I only caught it because I ran a targeted audit prompt asking Claude Code to verify no business logic lived outside the provisioner. It found its own violation. The fix was extracting `runProvisionTransaction()` and `markFailed()` as private helpers, adding a proper `retryProvisionEmployee()` export to the provisioner, and reducing the MCP handler to 3 lines.

- The .gitignore mistake

It ignored adding `package-lock.json` to .gitignore, which would have broken reproducible installs for the reviewer.


- The issue with AI_TRANSCRIPT.md - it failed on this one

I was using clade code and in that we are not able to copy past the whole chat like claude chat. I before starting chats, I tested and found this. So I asked it to create AI_TRANSCRIPT.md file and log each and everything in it. But it failed it add things properly. It added summary of everything and missed the real prompts that I added. So I digged where it actually sotres the history. Now shareD the session files and AI_TRANSCRIPT and aksed it to create honest history of that chat.

---

## How MCP Was Tested

- `tests/mcp.test.ts` — 9 automated cases covering all three tools with  in-memory SQLite
  `list_failed_events` tested with and without the `since`   filter
   `retry_provision` tested for success, non-failed event error, and   non-existent event error.
- MCP Inspector smoke-test: `npx @modelcontextprotocol/inspector node dist/mcp_server/server.js`   — confirmed `tools/list` returns exactly 3 tools with correct names, called each tool manually in the browser UI.

---

## Reflection

- Where AI saved time:
Boilerplate that would have taken an hour took minutes — TypeScript interfaces, Jest test setup with in-memory DB isolation, SQL DDL with CHECK constraints and strftime defaults, MCP SDK import path resolution for CJS modules. The DB layer and logger were essentially correct on first generation. I'd estimate AI compressed about 3 hours of mechanical work into 30 minutes.

- Where I had to actually think:
Writing SPEC.md before any code. The design decisions — shared provisioner as single source of truth, failed event re-POST returns 400 not 202, retry only via MCP tool — those required deliberate choices upfront that had to be held firm when AI occasionally tried to drift from them.

The architecture audit was also human judgment. AI built working code that passed all tests but violated the structural constraint that matters most for this assignment. A reviewer looking at the MCP handler would have caught it immediately. I had to think to prompt for that audit — AI wouldn't have flagged it on its own.

The other thing AI consistently needed help with was knowing when to stop. Left to its own devices it would add more than asked, modify files it wasn't supposed to touch, or suggest dependencies that weren't needed. Short, precise prompts with explicit "do not" constraints worked better than open-ended ones.