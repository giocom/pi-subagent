import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, formatAgentList } from "../src/agents.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("discoverAgents", () => {
	it("finds no project agents when no .pi/agents directory exists", () => {
		const cwd = makeTmpDir();
		const result = discoverAgents(cwd, "project");
		expect(result.agents).toEqual([]);
		expect(result.projectAgentsDir).toBeNull();
	});

	it("discovers project agents from the nearest .pi/agents directory", () => {
		const cwd = makeTmpDir();
		const nested = path.join(cwd, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		const agentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "coder.md"),
			[
				"---",
				"name: coder",
				"description: Writes code",
				"tools: [read, bash]",
				"---",
				"You are a coder.",
			].join("\n"),
		);

		const result = discoverAgents(nested, "project");
		expect(result.projectAgentsDir).toBe(agentsDir);
		expect(result.agents).toHaveLength(1);
		const agent = result.agents[0];
		expect(agent.name).toBe("coder");
		expect(agent.source).toBe("project");
		expect(agent.tools).toEqual(["read", "bash"]);
		expect(agent.systemPrompt).toContain("You are a coder.");
	});

	it("accepts tools as a comma-separated string", () => {
		const cwd = makeTmpDir();
		const agentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "reviewer.md"),
			["---", "name: reviewer", "description: Reviews code", "tools: read, grep", "---", "body"].join("\n"),
		);

		const result = discoverAgents(cwd, "project");
		expect(result.agents[0].tools).toEqual(["read", "grep"]);
	});

	it("skips files missing name or description frontmatter", () => {
		const cwd = makeTmpDir();
		const agentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "broken.md"), "no frontmatter here");

		const result = discoverAgents(cwd, "project");
		expect(result.agents).toEqual([]);
	});

	it("user scope ignores project agents", () => {
		const cwd = makeTmpDir();
		const agentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "proj.md"),
			["---", "name: proj", "description: project agent", "---", "body"].join("\n"),
		);

		const result = discoverAgents(cwd, "user");
		expect(result.agents.every((a) => a.source !== "project")).toBe(true);
	});
});

describe("formatAgentList", () => {
	it("returns 'none' for an empty list", () => {
		expect(formatAgentList([], 5)).toEqual({ text: "none", remaining: 0 });
	});

	it("truncates long lists and reports remaining count", () => {
		const agents = [1, 2, 3, 4, 5].map((i) => ({
			name: `agent${i}`,
			description: `desc${i}`,
			systemPrompt: "",
			source: "user" as const,
			filePath: `/tmp/agent${i}.md`,
		}));
		const { text, remaining } = formatAgentList(agents, 3);
		expect(text).toContain("agent1");
		expect(text).not.toContain("agent4");
		expect(remaining).toBe(2);
	});
});
