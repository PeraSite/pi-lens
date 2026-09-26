import * as path from "node:path";
import { advisoryFileHash } from "./advisory-provenance.js";
import { logLatency } from "./latency-logger.js";
import { oxlintInvocation } from "./oxlint-invocation.js";
import { findNearestContaining, pathsEqual } from "./path-utils.js";
import { safeSpawnAsync, type SpawnResult } from "./safe-spawn.js";
import { OXLINT_CONFIGS } from "./tool-policy.js";

interface Request {
	command: string;
	cwd: string;
	projectRoot: string;
	filePath: string;
	prefix: string[];
	signal: AbortSignal | undefined;
	turnId: string;
}
interface Pending extends Request {
	key: string;
	hash: string;
	deadlineAt: number;
	resolve: (result: SpawnResult) => void;
	reject: (error: unknown) => void;
}

// ponytail: one short, bounded collection per module; no cross-process broker
// or in-flight/result cache. Duplicate module loads may make smaller batches,
// but the kernel slot still bounds concurrency across all of them.
let pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const MAX_BATCH = 32;
const WINDOW_MS = 50;
const OUTPUT_CAP = 8 * 1024 * 1024;
const CONFIG_BOUNDARIES = [...OXLINT_CONFIGS, "oxlint.config.js", ".git"];

function invoke(request: Request, files: string[], deadlineAt: number) {
	const [command, args] = oxlintInvocation(request.command, [
		...request.prefix,
		...files,
	]);
	return safeSpawnAsync(command, args, {
		cwd: request.cwd,
		resourceLabel: "oxlint",
		timeout: 30000,
		deadlineAt,
		maxOutputBytes: OUTPUT_CAP,
		signal: request.signal,
		// An undefined captured signal must not adopt a later turn's signal.
		ignoreAmbientSignal: true,
	});
}

/** Partition only a complete, canonical batch report, never a partial clean. */
function partition(
	result: SpawnResult,
	files: string[],
	cwd: string,
): SpawnResult[] | undefined {
	if (result.stderr?.trim() || ![0, 1].includes(result.status ?? -1)) return;
	let report: { diagnostics?: unknown; number_of_files?: unknown } | null;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		return;
	}
	if (
		!report ||
		report.number_of_files !== files.length ||
		!Array.isArray(report.diagnostics)
	)
		return;
	const perFile: Array<Array<Record<string, unknown>>> = files.map(() => []);
	let hasError = false;
	for (const diagnostic of report.diagnostics) {
		if (
			!diagnostic ||
			typeof diagnostic.filename !== "string" ||
			typeof diagnostic.message !== "string" ||
			!["error", "warning"].includes(diagnostic.severity)
		)
			return;
		const index = files.findIndex((file) =>
			pathsEqual(path.resolve(cwd, diagnostic.filename), file),
		);
		if (index < 0) return; // Unattributed/project-level failure needs a per-file run.
		perFile[index].push(diagnostic);
		hasError ||= diagnostic.severity === "error";
	}
	if (result.status !== (hasError ? 1 : 0)) return;
	return perFile.map((diagnostics) => ({
		...result,
		// The raw exit belonged to ALL files. A clean sibling must not become
		// finishParsedRun's nonzero/empty parse-error warning.
		status: diagnostics.some((d) => d.severity === "error") ? 1 : 0,
		stdout: JSON.stringify({ ...report, diagnostics, number_of_files: 1 }),
	}));
}

async function execute(batch: Pending[]): Promise<SpawnResult[]> {
	const first = batch[0];
	const files = batch.map((entry) => entry.filePath);
	const started = Date.now();
	let outcome = "incomplete";
	try {
		const result = await invoke(first, files, first.deadlineAt);
		// Process-control evidence outranks all report bytes. Never retry a
		// truncated, timed-out or cancelled child under a fresh budget.
		if (
			result.error ||
			result.failure ||
			result.signal ||
			result.outputTruncated ||
			result.spawnFailure
		)
			return batch.map(() => result);
		let results =
			batch.length === 1 ? [result] : partition(result, files, first.cwd);
		outcome = results ? "shared" : "individual-fallback";
		if (!results) {
			// Ignored files have no individual coverage marker in JSON. Preserve
			// their existing no-files/legacy parser semantics via bounded singles.
			results = await Promise.all(
				batch.map((entry) => invoke(entry, [entry.filePath], entry.deadlineAt)),
			);
		}
		// No late-result cache: changing ANY requested input invalidates the
		// batch (it may be a type dependency of a sibling). A later edit gets
		// its own invocation, never this already-running result.
		if (
			batch.some((entry) => entry.hash !== advisoryFileHash(entry.filePath))
		) {
			outcome = "source-changed";
			return batch.map(() => ({
				stdout: "",
				stderr: "",
				status: null,
				error: new Error(
					"oxlint batch input changed while queued or running; retry the check",
				),
			}));
		}
		return results;
	} finally {
		logLatency({
			type: "phase",
			phase: "oxlint_batch",
			filePath: first.cwd,
			durationMs: Date.now() - started,
			metadata: { files: batch.length, outcome },
		});
	}
}

function flush(): void {
	clearTimeout(timer);
	timer = undefined;
	const entries = pending;
	pending = []; // Detach BEFORE execution: new edits cannot join old work.
	const groups: Pending[][] = [];
	for (const entry of entries) {
		const group = groups.find(
			(items) =>
				items[0].key === entry.key &&
				items[0].signal === entry.signal &&
				!items.some((item) => pathsEqual(item.filePath, entry.filePath)),
		);
		if (group) group.push(entry);
		else groups.push([entry]);
	}
	for (const group of groups) {
		void execute(group).then(
			(results) =>
				group.forEach((entry, index) => entry.resolve(results[index])),
			(error) => group.forEach((entry) => entry.reject(error)),
		);
	}
}

/** Read-only oxlint diagnostics only; autofix never passes through this queue. */
export function runOxlintBatched(request: Request): Promise<SpawnResult> {
	const deadlineAt = Date.now() + 30000;
	// Vite+ is a different launcher contract: keep its already-tested single
	// invocation (and the same flock) until its batching contract is measured.
	if (request.prefix[0] === "lint")
		return invoke(request, [request.filePath], deadlineAt);
	const hash = advisoryFileHash(request.filePath);
	if (hash === "missing" || hash.startsWith("unreadable:"))
		return invoke(request, [request.filePath], deadlineAt);
	const key = JSON.stringify([
		request.command,
		request.cwd,
		request.projectRoot,
		request.turnId,
		findNearestContaining(path.dirname(request.filePath), CONFIG_BOUNDARIES),
	]);
	return new Promise((resolve, reject) => {
		pending.push({ ...request, key, hash, deadlineAt, resolve, reject });
		if (pending.length >= MAX_BATCH) flush();
		else if (!timer) {
			timer = setTimeout(flush, WINDOW_MS);
			// Keep this 50ms timer referenced until flush clears it: CLI consumers
			// awaiting the batch must not exit with an unsettled top-level await.
		}
	});
}
