import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAgents } from "../src/agents.js";
import { DEFAULT_AGENT_NAMES, installDefaultAgents } from "../src/default-agents.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-defaults-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("installDefaultAgents", () => {
	it("creates all four default agent files", () => {
		const agentDir = makeTmpDir();
		const created = installDefaultAgents(agentDir);

		expect(created).toEqual([...DEFAULT_AGENT_NAMES]);
		for (const name of DEFAULT_AGENT_NAMES) {
			const file = path.join(agentDir, "agents", `${name}.md`);
			expect(fs.existsSync(file)).toBe(true);
		}
	});

	it("is idempotent (second call creates nothing)", () => {
		const agentDir = makeTmpDir();
		installDefaultAgents(agentDir);
		expect(installDefaultAgents(agentDir)).toEqual([]);
	});

	it("does not overwrite existing files", () => {
		const agentDir = makeTmpDir();
		installDefaultAgents(agentDir);

		const file = path.join(agentDir, "agents", "planner.md");
		fs.writeFileSync(file, "# customized by user\n");
		installDefaultAgents(agentDir);

		expect(fs.readFileSync(file, "utf-8")).toBe("# customized by user\n");
	});

	it("skips installation when PI_SUBAGENT_NO_DEFAULT_AGENTS=1", () => {
		const agentDir = makeTmpDir();
		vi.stubEnv("PI_SUBAGENT_NO_DEFAULT_AGENTS", "1");

		expect(installDefaultAgents(agentDir)).toEqual([]);
		expect(fs.existsSync(path.join(agentDir, "agents"))).toBe(false);
	});

	it("produces files that discoverAgents can parse", () => {
		const agentDir = makeTmpDir();
		installDefaultAgents(agentDir);

		// discoverAgents resolves the user agents dir via getAgentDir(),
		// which honors PI_CODING_AGENT_DIR.
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const cwd = makeTmpDir();
		const result = discoverAgents(cwd, "user");
		const names = result.agents.map((a) => a.name).sort();

		expect(names).toEqual([...DEFAULT_AGENT_NAMES].sort());
		for (const agent of result.agents) {
			expect(agent.tools).toBeDefined();
			expect(agent.systemPrompt.trim().length).toBeGreaterThan(0);
		}
	});

	it("matches the locally installed agent files byte-for-byte (when present)", () => {
		const localDir = path.join(os.homedir(), ".pi", "agent", "agents");
		if (!fs.existsSync(localDir)) return; // skip on machines without the originals

		const agentDir = makeTmpDir();
		installDefaultAgents(agentDir);

		for (const name of DEFAULT_AGENT_NAMES) {
			const localFile = path.join(localDir, `${name}.md`);
			if (!fs.existsSync(localFile)) continue;
			const installed = fs.readFileSync(path.join(agentDir, "agents", `${name}.md`), "utf-8");
			expect(installed, `${name}.md drifted from the locally installed version`).toBe(
				fs.readFileSync(localFile, "utf-8"),
			);
		}
	});
});
