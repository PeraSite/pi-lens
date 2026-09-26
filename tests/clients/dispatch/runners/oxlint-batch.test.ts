import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";
import { suspendAt } from "../../interleaving-kit.js";
import type { SpawnResult } from "../../../../clients/safe-spawn.js";

// Only the external linter is replaced. The runner, queue, parser, stores and
// latency sink are real; fake time makes the collection window deterministic.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", async (original) => ({
	...(await original<typeof import("../../../../clients/safe-spawn.js")>()),
	safeSpawnAsync: spawn,
}));

import runner from "../../../../clients/dispatch/runners/oxlint.js";
import { setAmbientAbortSignal } from "../../../../clients/safe-spawn.js";
import {
	beginTurnContext,
	runWithTurnContext,
} from "../../../../clients/turn-context.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../../clients/latency-logger.js";

function report(files: string[], errors: string[] = []): SpawnResult {
	return {
		status: errors.length ? 1 : 0,
		stdout: JSON.stringify({
			diagnostics: errors.map((filename) => ({
				filename,
				message: `broken ${path.basename(filename)}`,
				code: "typescript(TS2322)",
				severity: "error",
				labels: [{ span: { line: 2, column: 3 } }],
			})),
			number_of_files: files.length,
		}),
		stderr: "",
	};
}

function targets(args: string[]): string[] {
	return args.filter((arg) => arg.endsWith(".ts"));
}

describe("oxlint diagnostic batching", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let files: string[];
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		env = setupTestEnvironment("pi-lens-oxlint-batch-");
		fs.writeFileSync(path.join(env.tmpDir, ".oxlintrc.json"), "{}");
		fs.mkdirSync(path.join(env.tmpDir, "node_modules/.bin"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(env.tmpDir, "node_modules/.bin/oxlint"),
			"fixture",
		);
		files = Array.from({ length: 14 }, (_, i) => {
			const file = path.join(env.tmpDir, `file ${i};literal.ts`);
			fs.writeFileSync(file, "export {};\n");
			return file;
		});
		spawn.mockReset();
		spawn.mockImplementation(async (_command: string, args: string[]) =>
			report(targets(args)),
		);
	});
	afterEach(async () => {
		setAmbientAbortSignal(undefined);
		await flushLatencyLog();
		vi.unstubAllEnvs();
		vi.useRealTimers();
		env.cleanup();
	});
	function run(file: string) {
		const ctx = makeRunnerCtx(file, env.tmpDir);
		ctx.hasTool = async () => true;
		return runner.run(ctx);
	}
	async function flush() {
		await vi.advanceTimersByTimeAsync(50);
	}

	it("replaces fourteen per-file type analyses with one without contaminating clean siblings", async () => {
		spawn.mockImplementation(async (_command: string, args: string[]) =>
			report(
				targets(args),
				[files[0], files[7]].filter((f) => targets(args).includes(f)),
			),
		);
		const pending = Promise.all(files.map(run));
		await flush();
		const results = await pending;
		expect(results[0].diagnostics[0]).toMatchObject({
			filePath: files[0],
			rule: "TS2322",
			line: 2,
			column: 3,
			severity: "error",
		});
		expect(results[7].diagnostics[0]?.filePath).toBe(files[7]);
		for (const i of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
			expect(results[i]).toMatchObject({
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
			});
		}
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(targets(spawn.mock.calls[0][1])).toEqual(files);
		expect(spawn.mock.calls[0][1]).toContain("--threads=4");
		expect(spawn.mock.calls[0][2]).toMatchObject({
			cwd: env.tmpDir,
			maxOutputBytes: 8 * 1024 * 1024,
		});
	});

	it("retains warnings, suggestions and relative filename attribution", async () => {
		spawn.mockResolvedValue({
			status: 0,
			stderr: "",
			stdout: JSON.stringify({
				number_of_files: 2,
				diagnostics: [
					{
						filename: path.basename(files[0]),
						message: "remove debugger",
						code: "eslint(no-debugger)",
						severity: "warning",
						help: "Remove it",
						labels: [{ span: { line: 4 } }],
					},
				],
			}),
		});
		const pending = Promise.all(files.slice(0, 2).map(run));
		await flush();
		const results = await pending;
		expect(results[0]).toMatchObject({
			status: "succeeded",
			semantic: "warning",
			diagnostics: [
				{ filePath: files[0], line: 4, fixSuggestion: "Remove it" },
			],
		});
		expect(results[1].diagnostics).toEqual([]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it.each([
		".oxlintrc.json",
		".oxlintrc.jsonc",
		"oxlint.config.ts",
		"oxlint.config.mts",
		"oxlint.json",
		"oxlint.config.js",
		".git",
	])("keeps a nested %s boundary out of the parent's batch", async (marker) => {
		const nested = path.join(env.tmpDir, "nested");
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, marker), "{}");
		const file = path.join(nested, "nested.ts");
		fs.writeFileSync(file, "export {};\n");
		const pending = Promise.all([run(files[0]), run(file)]);
		await flush();
		expect((await pending).every((r) => r.status === "succeeded")).toBe(true);
		expect(spawn.mock.calls.map((call) => targets(call[1]))).toEqual([
			[files[0]],
			[file],
		]);
	});

	it("does not combine projects even when their tool cwd matches", async () => {
		const a = makeRunnerCtx(files[0], env.tmpDir);
		const b = makeRunnerCtx(files[1], env.tmpDir);
		const pending = Promise.all([
			runner.run({
				...a,
				hasTool: async () => true,
				projectRoot: path.join(env.tmpDir, "worktree-a"),
			}),
			runner.run({
				...b,
				hasTool: async () => true,
				projectRoot: path.join(env.tmpDir, "worktree-b"),
			}),
		]);
		await flush();
		await pending;
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("preserves ignored-file skip rather than reporting partial batch coverage as clean", async () => {
		spawn.mockImplementation(async (_command: string, args: string[]) => {
			const selected = targets(args);
			if (selected.length > 1) return report([files[0]]);
			if (selected[0] === files[0]) return report(selected);
			return {
				status: 1,
				stderr: "",
				stdout:
					"No files found to lint. Please check your paths and ignore patterns.\n" +
					JSON.stringify({
						diagnostics: [],
						number_of_files: 0,
						number_of_rules: 96,
						threads_count: 4,
						start_time: 0.01,
					}),
			};
		});
		const pending = Promise.all(files.slice(0, 2).map(run));
		await flush();
		const results = await pending;
		expect(results[0].status).toBe("succeeded");
		expect(results[1]).toMatchObject({
			status: "skipped",
			skipReason: "no-files-matched",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
		await flushLatencyLog();
		const records = fs
			.readFileSync(getLatencyLogPath(), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toContainEqual(
			expect.objectContaining({
				phase: "oxlint_batch",
				filePath: expect.stringContaining(path.basename(env.tmpDir)),
				metadata: { files: 2, outcome: "individual-fallback" },
			}),
		);
	});

	it.each([
		["malformed", "broken json", 0, ""],
		["null", "null", 0, ""],
		[
			"unknown filename",
			JSON.stringify({
				number_of_files: 2,
				diagnostics: [
					{ filename: "other.ts", message: "broken", severity: "error" },
				],
			}),
			1,
			"",
		],
		[
			"missing filename",
			JSON.stringify({
				number_of_files: 2,
				diagnostics: [{ message: "broken", severity: "error" }],
			}),
			1,
			"",
		],
		[
			"unknown severity",
			JSON.stringify({
				number_of_files: 2,
				diagnostics: [
					{ filename: "x.ts", message: "broken", severity: "surprise" },
				],
			}),
			0,
			"",
		],
		[
			"missing message",
			JSON.stringify({
				number_of_files: 2,
				diagnostics: [{ filename: "x.ts", severity: "error" }],
			}),
			1,
			"",
		],
		[
			"null diagnostic",
			JSON.stringify({ number_of_files: 2, diagnostics: [null] }),
			0,
			"",
		],
		["missing diagnostic list", JSON.stringify({ number_of_files: 2 }), 0, ""],
		[
			"exit mismatch",
			JSON.stringify({ number_of_files: 2, diagnostics: [] }),
			1,
			"",
		],
		[
			"unsupported exit",
			JSON.stringify({ number_of_files: 2, diagnostics: [] }),
			2,
			"",
		],
		[
			"stderr",
			JSON.stringify({ number_of_files: 2, diagnostics: [] }),
			0,
			"custom rule failed",
		],
	] as const)(
		"rechecks individually after an ambiguous %s report",
		async (_name, stdout, status, stderr) => {
			spawn.mockImplementation(async (_command: string, args: string[]) =>
				targets(args).length > 1
					? {
							stdout: stdout.replace('"x.ts"', JSON.stringify(files[0])),
							status,
							stderr,
						}
					: report(targets(args), targets(args)),
			);
			const pending = Promise.all(files.slice(0, 2).map(run));
			await flush();
			const results = await pending;
			expect(results.map((r) => r.diagnostics[0]?.filePath)).toEqual(
				files.slice(0, 2),
			);
			expect(spawn).toHaveBeenCalledTimes(3);
		},
	);

	it.each([
		{ failure: "timeout", status: null, error: new Error("timeout") },
		{ failure: "aborted", status: null, error: new Error("cancelled") },
		{ failure: "spawn", status: null, error: new Error("ENOENT") },
		{ signal: "SIGKILL", status: null },
		{ outputTruncated: true, status: 0 },
	])(
		"fans out incomplete process evidence without retry: %j",
		async (evidence) => {
			// Even an ambiguous report must not trigger fresh work after failure.
			spawn.mockResolvedValue({ ...report([files[0]]), ...evidence });
			const pending = Promise.all(files.slice(0, 2).map(run));
			await flush();
			for (const result of await pending) {
				expect(result.status).toBe("failed");
				expect(result.diagnostics[0]?.id).toMatch(
					/^oxlint:(incomplete|no-files-unconfirmed:process-truncated)$/,
				);
			}
			expect(spawn).toHaveBeenCalledTimes(1);
		},
	);

	it("does not reset the thirty-second budget for collection or individual fallback", async () => {
		const started = Date.now();
		const suspension = suspendAt(
			spawn,
			async (_cmd, args, options) => {
				if (targets(args).length > 1) return report([files[0]]);
				return options.deadlineAt <= Date.now()
					? { stdout: "", stderr: "", status: null, failure: "timeout" }
					: report(targets(args));
			},
			{ calls: 1 },
		);
		const pending = Promise.all(files.slice(0, 2).map(run));
		try {
			await flush();
			await suspension.admitted;
			expect(spawn.mock.calls[0][2].deadlineAt).toBe(started + 30000);
			await vi.advanceTimersByTimeAsync(30000);
			suspension.release();
			for (const result of await pending)
				expect(result.diagnostics[0]?.id).toBe("oxlint:incomplete");
			for (const call of spawn.mock.calls)
				expect(call[2].deadlineAt).toBe(started + 30000);
		} finally {
			suspension.restore();
		}
	});

	it("captures cancellation before availability awaits and keeps unrelated signals separate", async () => {
		const a = new AbortController();
		const b = new AbortController();
		setAmbientAbortSignal(a.signal);
		const first = run(files[0]);
		setAmbientAbortSignal(b.signal);
		const second = run(files[1]);
		setAmbientAbortSignal(undefined);
		await flush();
		await Promise.all([first, second]);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(spawn.mock.calls[0][2]).toMatchObject({
			signal: a.signal,
			ignoreAmbientSignal: true,
		});
		expect(spawn.mock.calls[1][2].signal).toBe(b.signal);
	});

	it("does not attach a later ambient abort to a request that had none", async () => {
		const pending = run(files[0]);
		setAmbientAbortSignal(AbortSignal.abort());
		await flush();
		await pending;
		expect(spawn.mock.calls[0][2]).toMatchObject({
			signal: undefined,
			ignoreAmbientSignal: true,
		});
	});

	it("keeps sessions and turns separate even without a signal", async () => {
		const first = runWithTurnContext("batch-a", () => run(files[0]));
		beginTurnContext("batch-a");
		const second = runWithTurnContext("batch-a", () => run(files[1]));
		const third = runWithTurnContext("batch-b", () => run(files[2]));
		await flush();
		await Promise.all([first, second, third]);
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it.each([1, 2])(
		"rejects queued source drift for %i request(s)",
		async (count) => {
			const pending = Promise.all(files.slice(0, count).map(run));
			await vi.advanceTimersByTimeAsync(1);
			fs.writeFileSync(files[0], "export const changed = 1;\n");
			await flush();
			for (const result of await pending) {
				expect(result.status).toBe("failed");
				expect(result.failureMessage).toContain("input changed");
			}
		},
	);

	it("new edits never join an already-running batch, whose stale results are rejected", async () => {
		const suspension = suspendAt(
			spawn,
			async (_cmd, args) => report(targets(args)),
			{ calls: 1 },
		);
		const old = Promise.all(files.slice(0, 2).map(run));
		try {
			await flush();
			await suspension.admitted;
			fs.writeFileSync(files[0], "export const changed = 2;\n");
			const fresh = Promise.all(files.slice(0, 2).map(run));
			await flush();
			expect(
				(await fresh).every((result) => result.status === "succeeded"),
			).toBe(true);
			suspension.release();
			expect(
				(await old).every((result) =>
					result.failureMessage?.includes("input changed"),
				),
			).toBe(true);
			expect(spawn).toHaveBeenCalledTimes(2);
		} finally {
			suspension.restore();
		}
	});

	it("does not collapse repeat requests for one path into one coverage count", async () => {
		const pending = Promise.all([run(files[0]), run(files[0]), run(files[1])]);
		await flush();
		expect(
			(await pending).every((result) => result.status === "succeeded"),
		).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(
			spawn.mock.calls.map((call) => targets(call[1]).length).sort(),
		).toEqual([1, 2]);
	});

	it("flushes at thirty-two requests without extending the original collection window", async () => {
		const more = Array.from({ length: 19 }, (_, i) => {
			const file = path.join(env.tmpDir, `more-${i}.ts`);
			fs.writeFileSync(file, "export {};\n");
			return file;
		});
		const pending = Promise.all([...files, ...more].map(run));
		await vi.advanceTimersByTimeAsync(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(targets(spawn.mock.calls[0][1])).toHaveLength(32);
		await flush();
		expect((await pending).every((r) => r.status === "succeeded")).toBe(true);
		expect(targets(spawn.mock.calls[1][1])).toHaveLength(1);
	});

	it("a late arrival does not postpone the first request", async () => {
		const first = run(files[0]);
		await vi.advanceTimersByTimeAsync(40);
		const second = run(files[1]);
		await vi.advanceTimersByTimeAsync(10);
		await Promise.all([first, second]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("settles all waiters after a thrown spawn and leaves the next batch usable", async () => {
		spawn.mockRejectedValueOnce(new Error("spawn fixture throw"));
		const failed = Promise.allSettled(files.slice(0, 2).map(run));
		await flush();
		expect((await failed).every((r) => r.status === "rejected")).toBe(true);
		const fresh = Promise.all(files.slice(0, 2).map(run));
		await flush();
		expect((await fresh).every((r) => r.status === "succeeded")).toBe(true);
	});

	it("missing targets still reach the existing per-file failure classifier", async () => {
		fs.unlinkSync(files[0]);
		spawn.mockResolvedValue({
			status: 2,
			stdout: "missing file",
			stderr: "",
		});
		const pending = run(files[0]);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).status).toBe("failed");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("rejects source drift during individual fallback too", async () => {
		spawn.mockImplementation(async (_cmd: string, args: string[]) => {
			if (targets(args).length > 1) return report([files[0]]);
			fs.writeFileSync(files[0], "export const changed = 3;\n");
			return report(targets(args));
		});
		const pending = Promise.all(files.slice(0, 2).map(run));
		await flush();
		expect(
			(await pending).every((r) => r.failureMessage?.includes("input changed")),
		).toBe(true);
	});

	it("keeps Vite+ single-file while retaining the shared lock and thread bound", async () => {
		fs.writeFileSync(path.join(env.tmpDir, "vite-plus.json"), "{}");
		fs.writeFileSync(path.join(env.tmpDir, "node_modules/.bin/vp"), "fixture");
		const pending = Promise.all(files.slice(0, 2).map(run));
		await flush();
		await pending;
		expect(spawn).toHaveBeenCalledTimes(2);
		for (const call of spawn.mock.calls) {
			expect(call[1]).toContain("lint");
			expect(call[1]).toContain("--threads=4");
			expect(targets(call[1])).toHaveLength(1);
		}
	});
});
