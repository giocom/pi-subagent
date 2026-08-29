import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentFilePath,
	createAgent,
	deleteAgent,
	isValidAgentName,
	serializeAgentFile,
	updateAgent,
} from "../src/manage.js";

let userAgentRoot = "";
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, getAgentDir: () => userAgentRoot };
});

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-manage-test-"));
	tmpDirs.push(dir);
	return dir;
}

beforeEach(() => {
	// Route user-scope agent files into a per-test temp dir.
	userAgentRoot = makeTmpDir();
});

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("isValidAgentName", () => {
	it("accepts valid names", () => {
		expect(isValidAgentName("planner")).toBe(true);
		expect(isValidAgentName("my-agent-2")).toBe(true);
		expect(isValidAgentName("a")).toBe(true);
	});

	it("rejects invalid names", () => {
		expect(isValidAgentName("")).toBe(false);
		expect(isValidAgentName("9lives")).toBe(false);
		expect(isValidAgentName("-lead")).toBe(false);
		expect(isValidAgentName("has space")).toBe(false);
		expect(isValidAgentName("with/slash")).toBe(false);
		expect(isValidAgentName("a".repeat(65))).toBe(false);
	});
});

describe("serializeAgentFile", () => {
	it("writes frontmatter with all fields", () => {
		const content = serializeAgentFile(
			{
				description: "Test agent",
				tools: ["read", "bash"],
				model: "anthropic/claude-sonnet-4-6",
				noContextFiles: true,
				systemPrompt: "You are a test.",
			},
			"test",
		);
		expect(content).toContain("name: test");
		expect(content).toContain("description: Test agent");
		expect(content).toContain("tools: [read, bash]");
		expect(content).toContain("model: anthropic/claude-sonnet-4-6");
		expect(content).toContain("noContextFiles: true");
		expect(content).toContain("You are a test.");
	});

	it("quotes descriptions that would break YAML", () => {
		const content = serializeAgentFile(
			{ description: "a: b", systemPrompt: "x" },
			"test",
		);
		expect(content).toContain('description: "a: b"');
	});
});

describe("createAgent", () => {
	it("creates a user-scope agent file", async () => {
		const cwd = makeTmpDir();
		const result = await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "Writes code",
			systemPrompt: "You are a coder.",
			tools: ["read", "bash"],
		});
		expect(result.action).toBe("created");
		expect(result.scope).toBe("user");
		expect(fs.existsSync(result.filePath)).toBe(true);

		const content = fs.readFileSync(result.filePath, "utf-8");
		expect(content).toContain("name: coder");
		expect(content).toContain("tools: [read, bash]");
		expect(content).toContain("You are a coder.");
	});

	it("creates a project-scope agent in the nearest .pi/agents", async () => {
		const cwd = makeTmpDir();
		const result = await createAgent({
			name: "tester",
			cwd,
			scope: "project",
			description: "Writes tests",
			systemPrompt: "You write tests.",
		});
		expect(result.filePath).toBe(path.join(cwd, ".pi", "agents", "tester.md"));
		expect(fs.existsSync(result.filePath)).toBe(true);
	});

	it("respects an existing project agents dir higher up the tree", async () => {
		const root = makeTmpDir();
		const nested = path.join(root, "src", "deep");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });

		const result = await createAgent({
			name: "tester",
			cwd: nested,
			scope: "project",
			description: "Writes tests",
			systemPrompt: "You write tests.",
		});
		expect(result.filePath).toBe(path.join(root, ".pi", "agents", "tester.md"));
	});

	it("refuses to overwrite an existing agent unless asked", async () => {
		const cwd = makeTmpDir();
		await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "v1",
			systemPrompt: "old prompt",
		});
		await expect(
			createAgent({
				name: "coder",
				cwd,
				scope: "user",
				description: "v2",
				systemPrompt: "new prompt",
			}),
		).rejects.toThrow(/already exists/);

		const result = await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "v2",
			systemPrompt: "new prompt",
			overwrite: true,
		});
		expect(result.action).toBe("created");
		expect(fs.readFileSync(result.filePath, "utf-8")).toContain("new prompt");
	});

	it("rejects invalid input", async () => {
		const cwd = makeTmpDir();
		await expect(
			createAgent({ name: "bad name", cwd, scope: "user", description: "d", systemPrompt: "p" }),
		).rejects.toThrow(/Invalid agent name/);
		await expect(
			createAgent({ name: "ok", cwd, scope: "user", description: "  ", systemPrompt: "p" }),
		).rejects.toThrow(/description is required/);
		await expect(
			createAgent({ name: "ok", cwd, scope: "user", description: "d", systemPrompt: "" }),
		).rejects.toThrow(/systemPrompt is required/);
	});
});

describe("updateAgent", () => {
	it("updates only the provided fields", async () => {
		const cwd = makeTmpDir();
		await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "old desc",
			systemPrompt: "old prompt",
			tools: ["read"],
		});

		const result = await updateAgent({
			name: "coder",
			cwd,
			scope: "user",
			tools: ["read", "bash"],
		});
		expect(result.action).toBe("updated");
		const content = fs.readFileSync(result.filePath, "utf-8");
		expect(content).toContain("description: old desc");
		expect(content).toContain("old prompt");
		expect(content).toContain("tools: [read, bash]");
	});

	it("clears tools and model with explicit empty values", async () => {
		const cwd = makeTmpDir();
		await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "d",
			systemPrompt: "p",
			tools: ["read"],
			model: "anthropic/claude-sonnet-4-6",
		});

		const result = await updateAgent({
			name: "coder",
			cwd,
			scope: "user",
			tools: [],
			model: "",
		});
		const content = fs.readFileSync(result.filePath, "utf-8");
		expect(content).not.toContain("tools:");
		expect(content).not.toContain("model:");
	});

	it("replaces the system prompt body", async () => {
		const cwd = makeTmpDir();
		await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "d",
			systemPrompt: "old prompt",
		});

		const result = await updateAgent({
			name: "coder",
			cwd,
			scope: "user",
			systemPrompt: "brand new prompt",
		});
		const content = fs.readFileSync(result.filePath, "utf-8");
		expect(content).toContain("brand new prompt");
		expect(content).not.toContain("old prompt");
	});

	it("fails for a missing agent", async () => {
		const cwd = makeTmpDir();
		await expect(
			updateAgent({ name: "ghost", cwd, scope: "user", description: "d" }),
		).rejects.toThrow(/not found/);
	});
});

describe("deleteAgent", () => {
	it("removes the agent file", async () => {
		const cwd = makeTmpDir();
		const created = await createAgent({
			name: "coder",
			cwd,
			scope: "user",
			description: "d",
			systemPrompt: "p",
		});

		const result = await deleteAgent({ name: "coder", cwd, scope: "user" });
		expect(result.action).toBe("deleted");
		expect(fs.existsSync(created.filePath)).toBe(false);
	});

	it("fails for a missing agent", async () => {
		const cwd = makeTmpDir();
		await expect(deleteAgent({ name: "ghost", cwd, scope: "user" })).rejects.toThrow(/not found/);
	});
});

describe("agentFilePath", () => {
	it("joins dir and name with .md", () => {
		expect(agentFilePath("/agents", "coder")).toBe(path.join("/agents", "coder.md"));
	});
});
