#!/usr/bin/env node
// Real-process regression: independent hosts must share the kernel lock, not a JS semaphore.
// Run after npm run build: PI_LENS_HOME=$PWD/.probe-home node scripts/test-oxlint-memory-bound.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runner from "../clients/dispatch/runners/oxlint.js";
import { FactStore } from "../clients/dispatch/fact-store.js";
import {
	safeSpawnAsync,
	setAmbientAbortSignal,
} from "../clients/safe-spawn.js";

const self = fileURLToPath(import.meta.url);
function context(filePath, cwd) {
	return {
		filePath,
		cwd,
		kind: "jsts",
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

if (process.argv[2] === "--worker") {
	const cwd = process.argv[3];
	const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".ts"));
	const results = await Promise.all(
		files.map((f) => runner.run(context(path.join(cwd, f), cwd))),
	);
	for (const [index, result] of results.entries()) {
		assert.equal(result.status, "succeeded", JSON.stringify(result));
		assert.equal(result.diagnostics[0]?.filePath, path.join(cwd, files[index]));
		assert.equal(result.diagnostics[0]?.message, `${files[index]} (fixture)`);
	}
	process.stdout.write(JSON.stringify({ checked: results.length }));
} else if (process.platform !== "linux") {
	console.log(
		"SKIP: Linux flock regression (other platforms retain direct execution)",
	);
} else {
	assert.ok(
		process.env.PI_LENS_HOME,
		"pin PI_LENS_HOME before running this probe",
	);
	fs.mkdirSync(process.env.PI_LENS_HOME, { recursive: true });
	const root = fs.mkdtempSync(
		path.join(process.env.PI_LENS_HOME, "oxlint-memory-"),
	);
	const home = path.join(root, "state");
	const events = path.join(root, "events.jsonl");
	const env = {
		PI_LENS_HOME: home,
		PILENS_DATA_DIR: path.join(root, "data"),
		HOME: root,
	};
	const originalHome = process.env.PI_LENS_HOME;
	try {
		const workspaces = ["workspace one", "workspace two"].map((name) => {
			const cwd = path.join(root, name);
			fs.mkdirSync(path.join(cwd, "node_modules/.bin"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".oxlintrc.json"), "{}");
			for (let i = 0; i < 7; i++)
				fs.writeFileSync(
					path.join(cwd, `file ${i};literal.ts`),
					"export {};\n",
				);
			// Only the external linter is a double. Real resolution, runner, spawns and locking run.
			fs.writeFileSync(
				path.join(cwd, "node_modules/.bin/oxlint"),
				`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const files = process.argv.filter((a) => a.endsWith('.ts'));
const log = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event, pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2)})+'\\n');
log('start');
setTimeout(() => {
 log('end');
 console.log(JSON.stringify({number_of_files: files.length, diagnostics: files.map((file) => ({filename: file, message: path.basename(file), code: 'eslint(fixture)', severity: 'warning'}))}));
}, 150);
`,
				{ mode: 0o755 },
			);
			return cwd;
		});
		const results = await Promise.all(
			workspaces.map((cwd) =>
				safeSpawnAsync(process.execPath, [self, "--worker", cwd], {
					cwd,
					env,
					timeout: 30000,
				}),
			),
		);
		for (const result of results) assert.equal(result.status, 0, result.stderr);
		const rows = fs
			.readFileSync(events, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		let active = 0;
		let peak = 0;
		for (const row of rows) {
			active += row.event === "start" ? 1 : -1;
			peak = Math.max(peak, active);
		}
		assert.equal(
			rows.length,
			4,
			"14 checks must finish in two per-host batches",
		);
		assert.equal(active, 0);
		assert.equal(peak, 1, "multiple Pi hosts must not run oxlint concurrently");
		for (const row of rows) {
			assert.ok(row.args.includes("--threads=4"));
			assert.equal(row.args.filter((arg) => arg.endsWith(".ts")).length, 7);
		}
		console.log(
			"PASS: 14 checks in 2 batches, 2 hosts, 2 workspaces, peak oxlint concurrency = 1; findings preserved",
		);

		const { oxlintInvocation } =
			await import("../clients/oxlint-invocation.js");
		process.env.PI_LENS_HOME = home;
		const invoke = (code, options = {}) => {
			const [command, args] = oxlintInvocation(process.execPath, [
				"-e",
				code,
				"--",
			]);
			return safeSpawnAsync(command, args, {
				cwd: root,
				timeout: 10000,
				...options,
			});
		};
		const marker = path.join(root, "ready");
		const waitReady = async () => {
			for (let i = 0; i < 500; i++) {
				if (fs.existsSync(marker)) return;
				await new Promise((r) => setTimeout(r, 10));
			}
			throw new Error("holder never became ready");
		};
		const controller = new AbortController();
		const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
		const holder = invoke(
			`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`,
			{ signal: controller.signal },
		);
		try {
			await waitReady();
			const timedOut = await invoke("console.log('must-not-run')", {
				timeout: 100,
			});
			assert.equal(timedOut.failure, "timeout");
			assert.equal(timedOut.stdout, "");
			const waiting = new AbortController();
			const aborted = invoke("console.log('must-not-run')", {
				signal: waiting.signal,
			});
			waiting.abort();
			assert.equal((await aborted).failure, "aborted");
		} finally {
			controller.abort();
			assert.equal((await holder).failure, "aborted");
		}
		const childPid = fs.readFileSync(marker, "utf8");
		let childState = "";
		try {
			childState = fs.readFileSync(`/proc/${childPid}/status`, "utf8");
		} catch {}
		assert.ok(
			!childState || /^State:\s+Z/m.test(childState),
			"grandchild must exit after active abort",
		);
		assert.equal(
			(await invoke("console.log('released')")).stdout.trim(),
			"released",
		);
		assert.equal((await invoke("process.exit(7)")).status, 7);
		assert.equal((await invoke("console.log('after-failure')")).status, 0);
		console.log(
			"PASS: waiting timeout/abort, active abort, exit failure and subsequent lock reuse",
		);
		assert.equal(
			(await invoke("setInterval(() => {}, 1000)", { timeout: 200 })).failure,
			"timeout",
		);
		assert.equal((await invoke("console.log('after-timeout')")).status, 0);

		setAmbientAbortSignal(AbortSignal.abort());
		try {
			const result = await runner.run(
				context(path.join(workspaces[0], "file 0;literal.ts"), workspaces[0]),
			);
			assert.equal(result.status, "failed");
			assert.match(result.diagnostics[0]?.message ?? "", /did not complete/);
		} finally {
			setAmbientAbortSignal(undefined);
		}
		console.log(
			"PASS: incomplete check is a visible warning, never a clean result",
		);
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = "";
			const result = await runner.run(
				context(path.join(workspaces[0], "file 0;literal.ts"), workspaces[0]),
			);
			assert.equal(result.status, "failed");
			assert.match(result.diagnostics[0]?.message ?? "", /did not complete/);
		} finally {
			process.env.PATH = originalPath;
		}
		console.log(
			"PASS: unavailable flock does not fall back to unlocked execution",
		);
	} finally {
		process.env.PI_LENS_HOME = originalHome;
		fs.rmSync(root, { recursive: true, force: true });
	}
}
