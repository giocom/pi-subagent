# pi-subagent

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
- **`/subagents` command** — lists all available agents and their sources

## Agent Definition Format

```markdown
---
name: code-reviewer
description: Reviews code changes for bugs and style
tools: [read, grep, bash]     # optional, comma string or array
model: anthropic/claude-...   # optional, pins the subagent model
---
You are a meticulous code reviewer. Always check for null safety...
```

- `name` and `description` are required.
- `tools` restricts the tools available to the subagent.
- `model` pins a specific model; otherwise the parent session's model is used.
- The markdown body is injected as an appended system prompt.

## Tool Parameters

| Parameter | Description |
|---|---|
| `agent`, `task` | Single mode (exactly one mode per call) |
| `tasks` | Parallel mode: array of `{ agent, task, cwd? }` (max 8) |
| `chain` | Chain mode: array of `{ agent, task, cwd? }`; `{previous}` in a task is replaced with the prior step's output |
| `agentScope` | `user` (default), `project`, or `both` |
| `confirmProjectAgents` | Prompt before running project-local agents (default `true`) |
| `cwd` | Working directory for the agent process (single mode) |

## Install

```bash
pi install git:github.com/<you>/pi-subagent
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
