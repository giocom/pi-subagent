# pi-subagent

[README-ko.md](./README-ko.md) — 한국어 버전

Pi extension that delegates tasks to specialized subagents, each running in a separate `pi` process with an isolated context window.

## Features

- **Subagent discovery** — agents are defined as markdown files with YAML frontmatter in:
  - `~/.pi/agent/agents/*.md` (user-level, default scope)
  - `.pi/agents/*.md` (project-level, nearest directory walking up from cwd)
- **Three execution modes**
  - `single`: `{ agent, task }` — run one agent
  - `parallel`: `{ tasks: [{ agent, task }, ...] }` — run up to 8 tasks with concurrency 4
  - `chain`: `{ chain: [{ agent, task }, ...] }` — run sequentially, each step can reference the previous output via the `{previous}` placeholder
- **Live streaming** — subagent output streams into the tool result (per-task updates for parallel, per-step for chain)
- **Rich TUI rendering** — themed call/result rendering with per-task token/cost usage stats, tool call previews, and markdown output
- **Safety** — project-local agents are repo-controlled, so a confirmation prompt is shown before running them (disable per call with `confirmProjectAgents: false`)
- **Context inheritance** — subagents inherit the current model (and thinking level, when the agent does not pin its own model) from the parent session
- **Timeout** — each agent has a run-time limit (default 10 minutes, configurable per call); the process is terminated (SIGTERM → SIGKILL) when it exceeds the limit
- **Output truncation** — huge subagent output is protected from flooding the parent context window. Final output (single / parallel / chain) is head-truncated at 50 KiB with a marker stating how many bytes were omitted; the complete output is preserved in the tool details (expand with Ctrl+O). Chain `{previous}` substitution is capped tighter at 32 KiB so one verbose step cannot bloat the next agent's prompt
- **`subagent_manager` tool** — create, update, and delete agent definitions (`create` / `update` / `delete` on user- or project-scope `.md` files)
- **`/subagents` command** — lists all available agents and their sources
- **Built-in default agents** — on first load, five ready-to-use agents (`planner`, `coder`, `websearcher`, `reviewer`, `agentbrowser`) are installed to `~/.pi/agent/agents/`. Existing files are never overwritten, and installation can be skipped with `PI_SUBAGENT_NO_DEFAULT_AGENTS=1`

## Agent Definition Format

```markdown
---
name: code-reviewer
description: Reviews code changes for bugs and style
tools: [read, grep, bash]      # optional, comma string or array
model: anthropic/claude-...    # optional, pins the subagent model
noContextFiles: true           # optional, skip AGENTS.md / project context files
---
You are a meticulous code reviewer. Always check for null safety...
```

- `name` and `description` are required.
- `tools` restricts the tools available to the subagent. **Security note:** when `tools` is omitted, the subagent gets the default tools (read, bash, edit, write) plus any extension tools, and since it runs non-interactively it executes them **without confirmation prompts**. Always set `tools` for agents that should not have full file/shell access.
- `model` pins a specific model; otherwise the parent session's model is used.
- `noContextFiles: true` launches the subagent with `--no-context-files`, so it does not load AGENTS.md / project context files. Useful for fully isolated, prompt-only agents.
- The markdown body is injected as an appended system prompt.
- When two agents declare the same `name`, the later one wins (project overrides user in `both` scope) and a warning is printed to the console.

## Using Subagents

Once installed, the extension registers a `subagent` tool. You can either ask the main agent to delegate in plain language ("delegate the code review to the code-reviewer agent") or invoke the tool directly.

### 1. Create an agent file

Five default agents are installed automatically on first load into `~/.pi/agent/agents/` — edit or delete them as you like, they will never be overwritten. Set `PI_SUBAGENT_NO_DEFAULT_AGENTS=1` to disable the auto-install.

| Agent | Role | Tools |
|---|---|---|
| `planner` | Explores the code as needed and produces a detailed, step-by-step implementation plan | read, grep, find, ls |
| `coder` | Implements the plan: edits code, verifies with build/test/lint | read, grep, find, ls, edit, write, bash |
| `reviewer` | Reviews code changes for bugs, edge cases, security issues, and test gaps | read, grep, find, ls, bash |
| `websearcher` | Researches external sources via web search / URL reading and structures the findings | websearch_searxng_web_search, websearch_web_url_read |
| `agentbrowser` | Browser automation: navigates sites, fills forms, clicks, takes screenshots, extracts data, login, web app testing, Electron app automation — delegate all browser/web interaction tasks to it (via the `agent-browser` CLI) | bash, read |

A typical pipeline: `planner` → `coder` → `reviewer` (use chain mode so each step receives the previous output via `{previous}`).

For custom agents, create a markdown file in `~/.pi/agent/agents/` (or `.pi/agents/`):

```markdown
# ~/.pi/agent/agents/code-reviewer.md
---
name: code-reviewer
description: Reviews code changes for bugs and style
tools: [read, grep]
---
You are a meticulous code reviewer. Always check for null safety...
```

Project-level agents go in `.pi/agents/` inside the repository and require confirmation before running (unless `confirmProjectAgents: false` is passed).

### 2. Single mode — one task, one agent

```json
{
  "agent": "code-reviewer",
  "task": "Review src/utils/parse.ts for bugs",
  "cwd": "/path/to/project",      // optional
  "timeout": 15                   // optional, minutes (default 10)
}
```

### 3. Parallel mode — up to 8 independent tasks (concurrency 4)

```json
{
  "tasks": [
    { "agent": "code-reviewer", "task": "Review the auth module" },
    { "agent": "test-writer", "task": "Write tests for the payment module" },
    { "agent": "doc-writer", "task": "Update the API docs", "cwd": "/path/to/docs" }
  ]
}
```

Use parallel mode when the tasks do not depend on each other. If any task fails, the call is reported as an error but all per-task results are still included in the output.

### 4. Chain mode — sequential steps with shared context

```json
{
  "chain": [
    { "agent": "researcher", "task": "Summarize the API surface of src/api.ts" },
    { "agent": "doc-writer", "task": "Write documentation based on this summary: {previous}" }
  ]
}
```

Each step's output is substituted into the next step's task wherever you place `{previous}`. The chain stops at the first failed step and reports which step failed.

### 5. Check what is available

Run `/subagents` in the pi session to list all discovered agents and their source (user vs. project). Set `agentScope: "both"` (or `"project"`) in a call to include project-local agents, and `confirmProjectAgents: false` to skip the confirmation prompt.

### Tips

- **Isolate noisy work** — delegate long-running exploration (log analysis, large refactors, test runs) so the main session's context window stays small.
- **Pin tools tightly** — always set `tools` in the agent frontmatter; subagents run non-interactively without confirmation prompts.
- **Pin models per agent** — use `model:` in the frontmatter for cheap/fast models (summarization) while the parent session keeps a strong model.
- **Use `noContextFiles: true`** for fully isolated, prompt-only agents that should not see your AGENTS.md / project context.

### 6. Manage agents (add / update / delete)

The `subagent_manager` tool edits agent definition files directly, so no manual file editing is needed:

```jsonc
// Create a new user-level agent
{ "action": "create", "name": "reviewer", "scope": "user",
  "description": "Reviews code for bugs", "systemPrompt": "You are a reviewer...",
  "tools": ["read", "grep", "find"] }

// Update only the provided fields (tools: [] clears the tool list, model: "" clears the model)
{ "action": "update", "name": "reviewer", "scope": "user", "model": "anthropic/claude-sonnet-4-6" }

// Delete an agent
{ "action": "delete", "name": "reviewer", "scope": "user" }
```

Notes:
- `scope: "project"` targets the nearest `.pi/agents/` directory (created automatically for `create`).
- `create` refuses to overwrite an existing agent unless `overwrite: true` is set.
- New agents are immediately available to the `subagent` tool — no restart needed.

## Tool Parameters

| Parameter | Description |
|---|---|
| `agent`, `task` | Single mode (exactly one mode per call) |
| `tasks` | Parallel mode: array of `{ agent, task, cwd? }` (max 8) |
| `chain` | Chain mode: array of `{ agent, task, cwd? }`; `{previous}` in a task is replaced with the prior step's output |
| `agentScope` | `user` (default), `project`, or `both` |
| `confirmProjectAgents` | Prompt before running project-local agents (default `true`) |
| `timeout` | Maximum run time per agent in minutes (default `10`) |
| `cwd` | Working directory for the agent process (single mode) |

### Failure semantics

- A task is considered failed when the process exits non-zero (including signal deaths such as OOM), the agent reports an `error`/`aborted` stop reason, or it hits the timeout.
- In parallel mode, a call is marked as an error (`isError`) when **any** task fails; the text output still includes the per-task results.
- In chain mode, the chain stops at the first failed step and reports which step failed.

## Install

```bash
pi install git:github.com/giocom/pi-subagent
```

Or from a local path:

```bash
pi install /path/to/pi-subagent
```

Or run directly for testing:

```bash
pi -e ./src/index.ts
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run check       # typecheck + tests
```

## License

MIT
