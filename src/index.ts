/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";
import { installDefaultAgents } from "./default-agents.js";
import { createAgent, deleteAgent, renameAgent, updateAgent, type ManageResult } from "./manage.js";

type ManagerDetails = ManageResult & { success: boolean };

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DEFAULT_OUTPUT_CAP_BYTES = 50 * 1024;
/** Cap for the {previous} substitution in chain mode. Intermediate step output flows into the next agent's prompt, so it is capped tighter than final output. */
const CHAIN_PREVIOUS_CAP_BYTES = 32 * 1024;
/** Hard cap on how long a single subagent process may run before it is force-killed. */
const DEFAULT_TIMEOUT_MINUTES = 30;
/** Watchdog interval: how often each running subagent's output is checked for error loops. */
const WATCHDOG_INTERVAL_MS = 5 * 60_000;
/** Consecutive watchdog checks that must see an error state before the subagent is killed (first error → wait one more cycle, second → kill). */
const WATCHDOG_ERROR_STRIKES = 2;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatTimestamp(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * Truncates a UTF-8 string to `maxBytes` without splitting a multi-byte
 * character. Returns the input unchanged when it fits.
 */
function truncateToBytes(input: string, maxBytes: number): string {
	if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
	let truncated = input.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return truncated;
}

/**
 * Protects the parent context window from huge subagent output: keeps the head
 * of the output within the byte cap and appends a marker with the omitted size.
 * The complete output is still available in the tool details (expanded TUI view).
 */
export function truncateOutput(output: string, maxBytes: number = DEFAULT_OUTPUT_CAP_BYTES): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= maxBytes) return output;
	const truncated = truncateToBytes(output, maxBytes);
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

/**
 * Truncation for the {previous} substitution in chain mode. The next agent
 * cannot see the parent's tool details, so the marker tells it to scope its
 * work to the visible part of the previous output.
 */
export function truncateChainPrevious(output: string, maxBytes: number = CHAIN_PREVIOUS_CAP_BYTES): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= maxBytes) return output;
	const truncated = truncateToBytes(output, maxBytes);
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Previous step output truncated: ${omitted} bytes omitted. Use only the part shown above.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	timeoutMinutes: number,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.noContextFiles) args.push("--no-context-files");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let timedOut = false;
		let watchdogKilled = false;
		let timeout: NodeJS.Timeout | undefined;
		let watchdog: NodeJS.Timeout | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				// A process killed by a signal (OOM, SIGKILL fallback) has code=null;
				// treat any signal death as a failure, not a success.
				resolve(code ?? (signal ? 1 : 0));
			});

			proc.on("error", (err) => {
				currentResult.stderr += (currentResult.stderr ? "\n" : "") + `Failed to start subagent: ${err.message}`;
				resolve(1);
			});

			// Watchdog: every WATCHDOG_INTERVAL_MS, check the subagent's latest output.
			// No error → keep waiting. Error detected → wait one more cycle; if the next
			// check still sees the error state, kill the process and report the error message.
			let errorStrikes = 0;
			const killForErrorLoop = (reason: string) => {
				if (watchdogKilled || proc.killed) return;
				watchdogKilled = true;
				currentResult.errorMessage = reason;
				currentResult.stopReason = "error";
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref?.();
			};
			watchdog = setInterval(() => {
				if (watchdogKilled || wasAborted || timedOut || proc.killed) return;
				let inErrorState = false;
				for (let i = currentResult.messages.length - 1; i >= 0; i--) {
					const msg = currentResult.messages[i];
					if (msg.role !== "assistant") continue;
					inErrorState = msg.stopReason === "error" || Boolean(msg.errorMessage) || msg.stopReason === "aborted";
					break;
				}
				if (inErrorState) {
					errorStrikes++;
					if (errorStrikes >= WATCHDOG_ERROR_STRIKES) {
						const detail = currentResult.errorMessage || "(no error message received)";
						killForErrorLoop(
						`Subagent terminated by watchdog: repeated errors detected across ${errorStrikes} checks (one every ${WATCHDOG_INTERVAL_MS / 60_000} minutes). Last error: ${detail}`,
						);
					}
				} else {
					errorStrikes = 0;
				}
			}, WATCHDOG_INTERVAL_MS);
			watchdog.unref?.();

			timeout = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref?.();
			}, timeoutMinutes * 60_000);
			timeout.unref?.();

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		clearTimeout(timeout);
		clearInterval(watchdog);
		currentResult.exitCode = exitCode;

		if (timedOut) throw new Error(`Subagent timed out after ${timeoutMinutes} minute${timeoutMinutes > 1 ? "s" : ""}`);
		if (watchdogKilled) return currentResult; // already marked as error with the subagent's error message
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	timeout: Type.Optional(Type.Number({
		description: `Maximum run time in minutes for each agent (default ${DEFAULT_TIMEOUT_MINUTES}).`,
		default: DEFAULT_TIMEOUT_MINUTES,
	})),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	// Install default subagents (planner, coder, websearcher, reviewer, agentbrowser) if missing.
	const createdDefaults = installDefaultAgents();
	if (createdDefaults.length > 0) {
		console.log(`[pi-subagent] Installed default agents: ${createdDefaults.join(", ")}`);
	}

	// Show TUI status when subagent tool is called
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("subagent", event)) return;
		const args = event.input as {
			agent?: string;
			tasks?: Array<{ agent: string }>;
			chain?: Array<{ agent: string }>;
		};
		if (!args.agent && !args.tasks && !args.chain) return;

		const agentNames = args.agent
			? args.agent
			: args.tasks
				? args.tasks.map((t) => t.agent).join(", ")
				: args.chain
					? `chain(${args.chain.map((s) => s.agent).join(" → ")})`
					: "";

		const mode = args.agent ? "single" : args.tasks ? "parallel" : "chain";
		const modeIcon = mode === "single" ? "🤖" : mode === "parallel" ? "🤖×" : "🤖→🤖";

		ctx.ui.setStatus("subagent", `${modeIcon} Running: ${agentNames}...`);
	});

	// Clear the status bar when a subagent tool call finishes (success or failure)
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "subagent") {
			ctx.ui.setStatus("subagent", undefined);
		}
	});

	// Register /subagents command to list available agents
	pi.registerCommand("subagents", {
		description: "List all available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found. Create .pi/agents/*.md or ~/.pi/agent/agents/*.md", "info");
				return;
			}
			const lines = agents.map((a) => {
				const tools = a.tools ? ` [${a.tools.join(", ")}]` : "";
				const model = a.model ? ` (model: ${a.model})` : "";
				const source = a.source === "user" ? "👤" : "📁";
				return `  ${source} **${a.name}**${model}\n     ${a.description}${tools}`;
			});
			const msg = `## Available Subagents (${agents.length})\n\n${lines.join("\n\n")}\n\n👤 = user-level (~/.pi/agent/agents/)\n📁 = project-level (.pi/agents/)\n\nUse the **subagent_manager** tool to create, update, or delete agents.`;
			ctx.ui.notify(msg, "info");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			`Watchdog: each agent is checked every ${WATCHDOG_INTERVAL_MS / 60_000} minutes; if it stays in an error state across consecutive checks it is terminated and its error message is reported.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const timeoutMinutes = params.timeout ?? DEFAULT_TIMEOUT_MINUTES;
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = formatAgentList(agents, 10);
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available.text}${available.remaining > 0 ? ` (+${available.remaining} more)` : ""}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						timeoutMinutes,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = truncateOutput(getResultOutput(result));
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					// Cap intermediate output before it is substituted into the next step's prompt.
					previousOutput = truncateChainPrevious(getFinalOutput(result.messages));
				}
				const lastOutput = getFinalOutput(results[results.length - 1].messages);
				return {
					content: [{ type: "text", text: lastOutput ? truncateOutput(lastOutput) : "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						timeoutMinutes,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					// Propagate partial failures so the model knows at least one task failed.
					isError: successCount < results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					timeoutMinutes,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = truncateOutput(getResultOutput(result));
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const finalOutput = getFinalOutput(result.messages);
				return {
					content: [{ type: "text", text: finalOutput ? truncateOutput(finalOutput) : "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = formatAgentList(agents, 10);
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available.text}${available.remaining > 0 ? ` (+${available.remaining} more)` : ""}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const border = theme.fg("dim", "─");
			const startTime = formatTimestamp(new Date());

			if (args.chain && args.chain.length > 0) {
				const agents = args.chain.map((s) => s.agent).join(" → ");
				let text =
					theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK START [${startTime}]`)) +
					theme.fg("muted", `${border.repeat(30)}`) +
					"\n" +
					theme.fg("accent", theme.bold(`chain (${args.chain.length} steps)`)) +
					theme.fg("muted", ` [${scope}]`) +
					"\n" +
					theme.fg("dim", `Agents: ${agents}`) +
					"\n";
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					const stepIcon = i === 0 ? "▶" : i === args.chain.length - 1 ? "▸" : "·";
					text +=
						"  " +
						theme.fg("accent", stepIcon + " ") +
						theme.fg("toolTitle", step.agent) +
						theme.fg("dim", `: ${preview}`) +
						"\n";
				}
				if (args.chain.length > 3) text += `  ${theme.fg("muted", `... +${args.chain.length - 3} more steps`)}`;
				return new Text(text.trimEnd(), 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				const agents = args.tasks.map((t) => t.agent).join(", ");
				let text =
					theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK START [${startTime}]`)) +
					theme.fg("muted", `${border.repeat(30)}`) +
					"\n" +
					theme.fg("accent", theme.bold(`parallel (${args.tasks.length} tasks)`)) +
					theme.fg("muted", ` [${scope}]`) +
					"\n" +
					theme.fg("dim", `Agents: ${agents}`) +
					"\n";
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `  ${theme.fg("accent", "⬥ ")}${theme.fg("toolTitle", t.agent)}${theme.fg("dim", `: ${preview}`)}\n`;
				}
				if (args.tasks.length > 3) text += `  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text.trimEnd(), 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK START [${startTime}]`)) +
				theme.fg("muted", `${border.repeat(30)}`) +
				"\n" +
				theme.fg("accent", theme.bold(`single`)) +
				theme.fg("muted", ` [${scope}]`) +
				"\n" +
				theme.fg("dim", `Agent: ${agentName}`) +
				"\n" +
				theme.fg("dim", `Task: ${preview}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				const endTime = formatTimestamp(new Date());
				let text =
				theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK END [${endTime}]`)) +
				"\n" +
				theme.fg("muted", `${theme.fg("dim", "─").repeat(30)}`) +
				"\n" +
				`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else {
				text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
				if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				const agents = details.results.map((r) => r.agent).join(" → ");
				const endTime = formatTimestamp(new Date());
				let text =
					theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK END [${endTime}]`)) +
					"\n" +
					theme.fg("muted", `${theme.fg("dim", "─").repeat(30)}`) +
					"\n" +
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`) +
					theme.fg("muted", ` [${agents}]`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				const agents = details.results.map((r) => r.agent).join(", ");
				const endTime = formatTimestamp(new Date());
				let text =
					theme.fg("toolTitle", theme.bold(`🤖  SUBAGENT TASK END [${endTime}]`)) +
					"\n" +
					theme.fg("muted", `${theme.fg("dim", "─").repeat(30)}`) +
					"\n" +
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}` +
					theme.fg("muted", ` [${agents}]`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// Register /subagent_manager tool to create, update, and delete agents
	const ManagerScopeSchema = StringEnum(["user", "project"] as const, {
		description: 'Which agent directory to modify. Default: "user" (~/.pi/agent/agents/). "project" targets .pi/agents/.',
		default: "user",
	});

	const ManagerActionSchema = StringEnum(["create", "update", "rename", "delete"] as const, {
		description: "Management action to perform. Use rename to change an agent's name (requires newName).",
		default: "create",
	});

	const SubagentManagerParams = Type.Object({
		action: Type.Optional(ManagerActionSchema),
		name: Type.String({ description: "Agent name (1-64 chars: letters, digits, '-', '_'; starts with a letter). For rename: the current name." }),
		newName: Type.Optional(
			Type.String({
				description:
					"For rename only: the new agent name. Moves the file and updates the frontmatter; do NOT create a new agent to rename one (the old file would remain).",
			}),
		),
		scope: Type.Optional(ManagerScopeSchema),
		description: Type.Optional(
			Type.String({ description: "One-line description of the agent's role (required for create)" }),
		),
		systemPrompt: Type.Optional(
			Type.String({ description: "Full system prompt / instructions for the agent (required for create)" }),
		),
		tools: Type.Optional(
			Type.Array(Type.String(), { description: "Allowed tool names. Omit to inherit all tools." }),
		),
		model: Type.Optional(
			Type.String({ description: "Optional model override (provider/model-id). Empty string clears the override." }),
		),
		noContextFiles: Type.Optional(
			Type.Boolean({ description: "Skip AGENTS.md / project context files for this agent. Default: false." }),
		),
		overwrite: Type.Optional(
			Type.Boolean({ description: "For create: replace an existing agent with the same name. Default: false.", default: false }),
		),
	});

	pi.registerTool({
		name: "subagent_manager",
		label: "Subagent Manager",
		description: [
			"Create, update, rename, or delete subagent definition files (.md) used by the subagent tool.",
			"action: create (needs description + systemPrompt, set overwrite=true to replace), update (change any provided fields), rename (name = current name, newName = new name; moves the file so no stale file is left behind), delete (removes the agent file).",
			`scope "user" -> ${path.join(getAgentDir(), "agents")}, scope "project" -> .pi/agents/ (nearest to cwd, created if missing for create).`,
		].join(" "),
		parameters: SubagentManagerParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action ?? "create";
			const scope = params.scope ?? "user";

			try {
				let result: ManageResult;

				switch (action) {
					case "create": {
						if (!params.description) throw new Error("description is required for action: create");
						if (!params.systemPrompt) throw new Error("systemPrompt is required for action: create");
						result = await createAgent({
							name: params.name,
							cwd: ctx.cwd,
							scope,
							description: params.description,
							systemPrompt: params.systemPrompt,
							tools: params.tools,
							model: params.model || undefined,
							noContextFiles: params.noContextFiles,
							overwrite: params.overwrite ?? false,
						});
						break;
					}
					case "update": {
						const hasChanges =
							params.description !== undefined ||
							params.systemPrompt !== undefined ||
							params.tools !== undefined ||
							params.model !== undefined ||
							params.noContextFiles !== undefined;
						if (!hasChanges)
							throw new Error(
								"No fields provided to update. Provide at least one of: description, systemPrompt, tools, model, noContextFiles.",
							);
						result = await updateAgent({
							name: params.name,
							cwd: ctx.cwd,
							scope,
							description: params.description,
							systemPrompt: params.systemPrompt,
							tools: params.tools,
							model: params.model,
							noContextFiles: params.noContextFiles,
						});
						break;
					}
					case "rename": {
						if (!params.newName) throw new Error("newName is required for action: rename");
						result = await renameAgent({
							name: params.name,
							newName: params.newName,
							cwd: ctx.cwd,
							scope,
							overwrite: params.overwrite ?? false,
						});
						break;
					}
					case "delete": {
						result = await deleteAgent({ name: params.name, cwd: ctx.cwd, scope });
						break;
					}
					default:
						throw new Error(`Unknown action: ${action}`);
				}

				const verb =
					result.action === "created"
						? "✅ Created"
						: result.action === "updated"
							? "✏️ Updated"
							: result.action === "renamed"
								? "🔁 Renamed"
								: "🗑️ Deleted";
				let text = result.action === "renamed"
					? `${verb} subagent "${result.oldAgent}" → "${result.agent}" [${result.scope}]\nFile: ${result.filePath}`
					: `${verb} subagent "${result.agent}" [${result.scope}]\nFile: ${result.filePath}`;
				if (result.fields) {
					const parts: string[] = [`description: ${result.fields.description}`];
					if (result.fields.tools?.length) parts.push(`tools: ${result.fields.tools.join(", ")}`);
					else parts.push("tools: (inherit all)");
					if (result.fields.model) parts.push(`model: ${result.fields.model}`);
					if (result.fields.noContextFiles) parts.push("noContextFiles: true");
					text += `\n${parts.join("\n")}`;
					if (result.action !== "deleted")
					text += `\n\nUse the subagent tool with agent: "${result.agent}" to invoke it.`;
				}

				return {
					content: [{ type: "text" as const, text }],
					details: { ...result, success: true },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Subagent management failed: ${message}` }],
					details: {
						action:
							action === "delete"
								? "deleted"
								: action === "update"
									? "updated"
									: action === "rename"
										? "renamed"
										: "created",
						agent: params.name,
						scope,
						filePath: "",
						success: false,
					} as ManagerDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "create";
			const icon = action === "create" ? "＋" : action === "update" ? "✎" : action === "rename" ? "➜" : "－";
			const extra: string[] = [];
			if (args.newName) extra.push(`→ ${args.newName}`);
			if (args.description) extra.push(`desc: ${args.description.slice(0, 40)}`);
			if (args.tools?.length) extra.push(`tools: ${args.tools.join(", ")}`);
			if (args.overwrite) extra.push("overwrite");
			const border = theme.fg("dim", "─");
			let text =
				theme.fg("toolTitle", theme.bold("🤖  SUBAGENT MANAGER  ")) +
				theme.fg("muted", border.repeat(26)) +
				"\n" +
				theme.fg("accent", theme.bold(`${action}`)) +
				theme.fg("muted", ` [${args.scope ?? "user"}]`) +
				"\n" +
				theme.fg("dim", `${icon} Agent: `) + theme.fg("toolTitle", args.name || "...");
			for (const e of extra) text += `\n${theme.fg("dim", e)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const isError = (result.details as ManagerDetails | undefined)?.success === false;
			const body = text?.type === "text" ? text.text : "(no output)";
			const lines = body.split("\n").map((line) =>
				theme.fg(isError ? "error" : "toolOutput", line),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
