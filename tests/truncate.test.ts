import { describe, it, expect } from "vitest";
import { truncateOutput, truncateChainPrevious } from "../src/index.js";

describe("truncateOutput", () => {
	it("returns short strings unchanged", () => {
		const short = "hello world";
		expect(truncateOutput(short)).toBe(short);
	});

	it("returns strings exactly at the cap unchanged", () => {
		const atCap = "a".repeat(100);
		expect(truncateOutput(atCap, 100)).toBe(atCap);
	});

	it("truncates over-cap strings and appends an omitted-bytes marker", () => {
		const out = truncateOutput("x".repeat(150), 100);
		expect(out).toMatch(/^x{100}\n\n\[Output truncated: 50 bytes omitted\. Full output preserved in tool details\.\]$/);
	});

	it("uses the default cap of 50 KiB", () => {
		const out = truncateOutput("y".repeat(50 * 1024 + 25));
		expect(out).toContain("[Output truncated: 25 bytes omitted");
		const markerStart = out.lastIndexOf("\n\n");
		expect(Buffer.byteLength(out.slice(0, markerStart), "utf8")).toBe(50 * 1024);
	});

	it("never splits a multi-byte UTF-8 character", () => {
		// Korean characters are 3 bytes each in UTF-8.
		const out = truncateOutput("가".repeat(100), 100); // 300 bytes total, cap 100
		const body = out.split("\n\n[")[0];
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(100);
		expect(Buffer.byteLength(body, "utf8") % 3).toBe(0);
		expect(body).toBe("가".repeat(33));
	});
});

describe("truncateChainPrevious", () => {
	it("returns short strings unchanged", () => {
		expect(truncateChainPrevious("short")).toBe("short");
	});

	it("uses the tighter default cap of 32 KiB", () => {
		const out = truncateChainPrevious("z".repeat(32 * 1024 + 10));
		expect(out).toContain("10 bytes omitted");
		const markerStart = out.lastIndexOf("\n\n");
		expect(Buffer.byteLength(out.slice(0, markerStart), "utf8")).toBe(32 * 1024);
	});

	it("tells the next agent to use only the visible part", () => {
		const out = truncateChainPrevious("w".repeat(500), 100);
		expect(out).toContain("[Previous step output truncated: 400 bytes omitted. Use only the part shown above.]");
	});
});
