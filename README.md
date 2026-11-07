# Jarvis Core

A local-first TypeScript foundation for Jarvis. It stores user facts, goals,
projects, and decisions in a SQLite database on the local machine. The SQLite
engine is `sql.js` (SQLite compiled to WebAssembly), so using the project does
not require a separately installed SQLite executable or native build tools.

## Windows setup

Requires Node.js 18 or newer and npm.

```powershell
npm.cmd install
npm.cmd test
npm.cmd run build
```

`npm.cmd` avoids PowerShell execution-policy errors that can block the
`npm.ps1` shim. Memory tests use temporary SQLite databases under the operating
system's temporary directory. They do not use the project `jarvis.sqlite` or
open the user's personal database.

## Memory API

```ts
import { MemoryStore } from "./src";

const memory = await MemoryStore.open("jarvis.sqlite");
const fact = await memory.create({
  kind: "fact",
  key: "preferred-name",
  value: "Sam",
  provenance: "User said so",
});

await memory.update("preferred-name", fact.version, {
  kind: "fact",
  key: "preferred-name",
  value: "Samuel",
  provenance: "User corrected the preferred name",
});
```

Each update must provide the version the caller read. A stale or missing version
raises `MemoryConflictError`; it never silently overwrites newer data. Current
records retain creation/update timestamps, and `history(key)` returns every
version with its provenance. Writes are serialized with a local lock and
atomically replace the database file. Stale locks are reclaimed only after
their owner process is no longer running.

## OpenRouter (free models only)

`OpenRouterProvider` implements the independent `AIProvider` interface. It
reads `OPENROUTER_API_KEY` from the process environment and defaults to
OpenRouter's `openrouter/free` router. Requests are always sent to that router;
any `OPENROUTER_MODEL` value other than `openrouter/free` is rejected before a
request is sent. No individual model or paid fallback can be selected. The API
key is never written to disk or included in request bodies, error messages, or
URLs.

The provider uses Node's built-in `fetch`, has a request timeout, and surfaces
configuration, connection, timeout, HTTP, and malformed-response errors. It
caps completions at 256 tokens, does not retry requests, and does not fall back
to paid models.
Prompts and optional context passed to `complete` are sent to OpenRouter; do not
include private memory unless it is intentionally approved for external
processing.

The repository ignores `.env` files; `.env.example` only documents the variable
name and a placeholder. Do not put a real key in that example or commit a local
`.env` file. In VS Code, run **Check OpenRouter connection (free only)** from
the task runner. VS Code asks for the API key in a password-style local prompt,
passes it to the process as an environment variable, and runs a minimal live
request through the free router. The key is not saved by the task. The same
check is available with `npm.cmd run openrouter:live-test` when the environment
already contains the key. Alternatively, set `OPENROUTER_API_KEY` in the
environment that launches your application and create a provider with:

```ts
import { OpenRouterProvider } from "./src";

const provider = OpenRouterProvider.fromEnv();
const answer = await provider.complete({ prompt: "Hello" });
```

Unit tests mock the HTTP transport and never contact OpenRouter. Run them with
`npm.cmd test`. The live test fails with a safe configuration message if the
key is not present and never prints it.

`MemoryStore.search(query)` ranks matching current records using their keys,
values, and provenance. It returns stored records only; it does not generate
or invent memories. Search does not include superseded revisions; use
`history(key)` to inspect those.

## Conversation and memory

`ConversationService` connects an `AIProvider` to a `MemoryStore` without
changing either component. Call `respond(message)` to search at most five
relevant current records and add their values, provenance, and timestamps to
the provider context. The context instructs the model to treat records as
quoted user data, never as instructions, and not to claim prior knowledge when
no matching memory exists. If local search fails, the original message still
goes to the provider and the result reports `memoryStatus: "unavailable"`.

Ordinary messages and model responses are never saved automatically. Users
must explicitly issue `/remember key = value` (stored as a fact), or a typed
command such as `/remember fact key = value`, `/remember preference key = value`,
`/remember goal key = value`, `/remember project key = value`, or
`/remember decision key = value`.
Preferences are stored as facts under a `preference:` key. Use
`/correct key = value` to update an existing current record; the prior revision
remains in history and concurrent corrections are rejected. Uncertain claims
are not saved as facts. Tasks, temporary details, and assumptions are not
stored as persistent memories.

Before any provider call, the conversation layer blocks messages matching
secret, health, contact-detail, or other sensitive-data patterns, and excludes
matching memory records from context. There is no sensitive-data consent
override in this stage. These are conservative pattern checks, not a complete
privacy classifier; avoid sending sensitive content through the external
provider. The operation result exposes `memoryStatus` so callers can show
whether memories were used, unavailable, saved, corrected, or blocked.

## Terminal chat

The CLI uses `~/.jarvis/jarvis.sqlite` by default. Set `JARVIS_DB_PATH` to
choose a different database file. For example, in a POSIX shell:

```sh
JARVIS_DB_PATH="<path-to-existing-database>" npm run chat
```

Changing the default path does not move or automatically use an older
`jarvis.sqlite` in the project directory. You are responsible for choosing the
intended database path and keeping a backup before directing Jarvis to an older
database.

Set `OPENROUTER_API_KEY` in the environment that launches the terminal, then
start the local chat with:

```powershell
npm.cmd run chat
```

The CLI opens the database at the selected path, wires `OpenRouterProvider` and
`ConversationService`, and reads one message per line. Enter `/exit` to leave.
Existing `/remember ...` and `/correct ...` commands are handled by
`ConversationService`; the CLI does not reimplement memory behavior. Missing
credentials fail before opening memory.
Provider and memory failures are displayed without printing raw errors or
secrets. Automated CLI tests use in-memory mocks and do not send network
requests.

The `Tool` interface remains independent; concrete tools and a Jarvis runtime
are not included yet.

## Context and routing foundations

`ConversationService` builds a bounded, task-labelled context through
`TaskContextBuilder`. It retrieves at most five current SQLite memories,
deduplicates them, filters sensitive records, and limits the assembled context
to 8,000 characters by default. It reports the task type and IDs of the
long-term memories included in the response.

`ShortTermMemory` keeps only the current process's recent safe conversation
events (30-minute TTL, at most 20 events per session, 128 sessions, and 4,000
characters per event by default). `WorkingMemory` holds temporary values
isolated by task ID (one-hour TTL, at most 32 values per task, 128 tasks, and
4,000 characters per value). These stores are intentionally volatile; they are
not written to the user's SQLite database.

The chat factory wraps the existing `OpenRouterProvider` in `HybridModelRouter`.
Its only cloud provider is the typed OpenRouter provider, which remains fixed to
`openrouter/free`. Sensitive requests are local-only; without an explicitly
supplied local provider, they fail closed instead of falling back to cloud.
Sensitive detection is shared by the conversation and routing layers, and
`ConversationService` blocks sensitive messages before any provider call. No
local model is auto-detected or configured. The router retains the last 100
route events in process memory with task, privacy, provider, reason, duration,
and success metadata; actual cost is not available from the current provider
contract. The chat factory accepts an `onRoute` callback for consumers that
need to record these metadata events; the callback receives no prompt or memory
content. `QualityEvaluator` provides local deterministic metrics for
Recall@K, Precision@K, MRR, NDCG, exact-answer comparison, abstention, and
operation duration. It is not yet connected to production request aggregation
or a persistent benchmark dataset.

These are runtime foundations, not the complete long-term architecture.
Persistent short-term/event storage, confidence/importance/validity metadata,
memory relationships, a durable local knowledge base, a persistent
consolidation review queue, and versioned persistent skills have not been
implemented. There is no general migration framework. The schema initializer
creates the `tasks` and `task_events` tables, and adds and backfills the
`sequence` column when it detects an older `task_events` table without that
column. Sleep-time analysis must remain a
bounded local proposal/review process and must not edit confirmed memories
automatically. No background job, model call, or network activity is started
by these foundations.

Run `npm.cmd test` for offline tests of short-term expiry and bounds,
task-isolated working context, context filtering/budgets, provider routing,
and existing memory/conversation behavior.
