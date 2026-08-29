/**
 * Subagent management: create, update, and delete agent definition files.
 *
 * Agents live as markdown files with YAML frontmatter:
 *   - user scope:    <agentDir>/agents/<name>.md  (~/.pi/agent/agents/)
 *   - project scope: .pi/agents/<name>.md (nearest to cwd)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import type { AgentScope } from "./agents.js";

export interface ManageAgentFields {
	description: string;
	tools?: string[];
	model?: string;
	noContextFiles?: boolean;
	systemPrompt: string;
}

export interface ManageAgentsDirOptions {
	/** For project scope: create the .pi/agents directory if it does not exist (default true). */
	createIfMissing?: boolean;
}

const AGENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_RE.test(name);
}

/**
 * Resolve the agents directory for a scope.
 *
 * - "user": always returns the user agent directory.
 * - "project": nearest `.pi/agents` directory from cwd, or `<cwd>/.pi/agents`
 *   when none exists yet.
 */
export function resolveAgentsDir(
	cwd: string,
	scope: "user" | "project",
	options: ManageAgentsDirOptions = {},
): string {
	if (scope === "user") return path.join(getAgentDir(), "agents");

	const createIfMissing = options.createIfMissing ?? true;
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	if (createIfMissing) return path.join(cwd, CONFIG_DIR_NAME, "agents");
	throw new Error(`No .pi/agents directory found from ${cwd}`);
}

export function agentFilePath(dir: string, name: string): string {
	return path.join(dir, `${name}.md`);
}

/** Serialize frontmatter values into YAML-safe lines. */
function yamlValue(value: string): string {
	// Quote when the value could be misparsed (leading special chars, colon+space, quotes).
	if (/^[\s"'`#&*!|>%@{\[]/.test(value) || /[:#]\s/.test(value) || /\s$/.test(value)) {
		return JSON.stringify(value);
	}
	return value;
}

export function serializeAgentFile(fields: ManageAgentFields, name: string): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlValue(name)}`);
	lines.push(`description: ${yamlValue(fields.description)}`);
	if (fields.tools && fields.tools.length > 0) lines.push(`tools: [${fields.tools.join(", ")}]`);
	if (fields.model) lines.push(`model: ${yamlValue(fields.model)}`);
	if (fields.noContextFiles) lines.push("noContextFiles: true");
	lines.push("---", "");
	const prompt = fields.systemPrompt.trimEnd();
	lines.push(prompt.length > 0 ? prompt : "(no system prompt)");
	lines.push("");
	return lines.join("\n");
}

type UpdateFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	noContextFiles?: unknown;
};

export interface ManageResult {
	action: "created" | "updated" | "renamed" | "deleted";
	agent: string;
	/** Previous agent name (rename only). */
	oldAgent?: string;
	scope: "user" | "project";
	filePath: string;
	/** Updated fields after the operation (absent for delete). */
	fields?: ManageAgentFields;
}

function parseToolListLoose(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function assertValidName(name: string): void {
	if (!isValidAgentName(name)) {
		throw new Error(
			`Invalid agent name "${name}". Use 1-64 characters: letters, digits, '-' or '_', starting with a letter.`,
		);
	}
}

async function ensureDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
}

export interface CreateAgentOptions extends ManageAgentFields {
	name: string;
	cwd: string;
	scope: "user" | "project";
	/** Overwrite an existing agent with the same name (default false). */
	overwrite?: boolean;
}

export async function createAgent(options: CreateAgentOptions): Promise<ManageResult> {
	assertValidName(options.name);
	if (!options.description.trim()) throw new Error("Agent description is required.");
	if (!options.systemPrompt.trim()) throw new Error("Agent systemPrompt is required.");

	const dir = resolveAgentsDir(options.cwd, options.scope);
	const filePath = agentFilePath(dir, options.name);

	if (fs.existsSync(filePath) && !options.overwrite) {
		throw new Error(`Agent "${options.name}" already exists at ${filePath}. Use overwrite: true to replace it.`);
	}

	const content = serializeAgentFile(options, options.name);
	await ensureDir(dir);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, "utf-8");
	});

	return {
		action: "created",
		agent: options.name,
		scope: options.scope,
		filePath,
		fields: {
			description: options.description,
			tools: options.tools,
			model: options.model,
			noContextFiles: options.noContextFiles,
			systemPrompt: options.systemPrompt,
		},
	};
}

export interface UpdateAgentOptions {
	name: string;
	cwd: string;
	scope: "user" | "project";
	description?: string;
	tools?: string[];
	model?: string;
	noContextFiles?: boolean;
	systemPrompt?: string;
}

/**
 * Update one or more fields of an existing agent. Only provided fields are
 * changed; `tools: []` clears the tool list, `model: ""` clears the model.
 */
export async function updateAgent(options: UpdateAgentOptions): Promise<ManageResult> {
	assertValidName(options.name);
	const dir = resolveAgentsDir(options.cwd, options.scope, { createIfMissing: false });
	const filePath = agentFilePath(dir, options.name);

	if (!fs.existsSync(filePath)) {
		throw new Error(`Agent "${options.name}" not found in ${dir}. Use action: "create" first.`);
	}

	const raw = await fs.promises.readFile(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<UpdateFrontmatter>(raw);

	const next: ManageAgentFields = {
		description:
			typeof options.description === "string" ? options.description : (frontmatter.description as string),
		tools: options.tools !== undefined ? options.tools : parseToolListLoose(frontmatter.tools),
		model:
			typeof options.model === "string"
				? options.model || undefined
				: (typeof frontmatter.model === "string" ? frontmatter.model : undefined),
		noContextFiles:
			options.noContextFiles !== undefined ? options.noContextFiles : frontmatter.noContextFiles === true,
		systemPrompt: options.systemPrompt ?? body,
	};

	if (!next.description?.trim()) throw new Error("Agent description is empty and no replacement was provided.");

	const content = serializeAgentFile(next, options.name);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, "utf-8");
	});

	return { action: "updated", agent: options.name, scope: options.scope, filePath, fields: next };
}

export interface RenameAgentOptions {
	/** Current agent name (source). */
	name: string;
	/** New agent name (target). */
	newName: string;
	cwd: string;
	scope: "user" | "project";
	/** Overwrite an existing agent with the new name (default false). */
	overwrite?: boolean;
}

/**
 * Rename an agent: moves the definition file to <newName>.md and updates the
 * `name:` frontmatter field in place. This is the only supported rename path —
 * creating a new agent with the new name would leave the old file behind.
 */
export async function renameAgent(options: RenameAgentOptions): Promise<ManageResult> {
	assertValidName(options.name);
	assertValidName(options.newName);
	if (options.name === options.newName) {
		throw new Error(`New name is identical to the current name "${options.name}".`);
	}

	const dir = resolveAgentsDir(options.cwd, options.scope, { createIfMissing: false });
	const fromPath = agentFilePath(dir, options.name);
	const toPath = agentFilePath(dir, options.newName);

	if (!fs.existsSync(fromPath)) {
		throw new Error(`Agent "${options.name}" not found in ${dir}. Nothing to rename.`);
	}
	if (fs.existsSync(toPath) && !options.overwrite) {
		throw new Error(
			`Agent "${options.newName}" already exists at ${toPath}. Use overwrite: true to replace it.`,
		);
	}

	const raw = await fs.promises.readFile(fromPath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<UpdateFrontmatter>(raw);

	const fields: ManageAgentFields = {
		description:
			typeof frontmatter.description === "string" ? frontmatter.description : "",
		tools: parseToolListLoose(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		noContextFiles: frontmatter.noContextFiles === true,
		systemPrompt: body,
	};
	if (!fields.description.trim()) {
		throw new Error(`Agent "${options.name}" has an empty description; cannot rename.`);
	}

	const content = serializeAgentFile(fields, options.newName);
	await withFileMutationQueue(fromPath, async () => {
		await withFileMutationQueue(toPath, async () => {
			await fs.promises.writeFile(toPath, content, "utf-8");
			await fs.promises.unlink(fromPath);
		});
	});

	return {
		action: "renamed",
		agent: options.newName,
		oldAgent: options.name,
		scope: options.scope,
		filePath: toPath,
		fields,
	};
}

export interface DeleteAgentOptions {
	name: string;
	cwd: string;
	scope: "user" | "project";
}

export async function deleteAgent(options: DeleteAgentOptions): Promise<ManageResult> {
	assertValidName(options.name);
	const dir = resolveAgentsDir(options.cwd, options.scope, { createIfMissing: false });
	const filePath = agentFilePath(dir, options.name);

	if (!fs.existsSync(filePath)) {
		throw new Error(`Agent "${options.name}" not found in ${dir}. Nothing to delete.`);
	}

	await withFileMutationQueue(filePath, async () => {
		await fs.promises.unlink(filePath);
	});

	return { action: "deleted", agent: options.name, scope: options.scope, filePath };
}
