import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";

/** Shared by lint and autofix; version probes do not need the expensive slot. */
export function oxlintInvocation(
	command: string,
	args: string[],
): [command: string, args: string[]] {
	const boundedArgs = [...args, "--threads=4"];
	if (process.platform !== "linux") return [command, boundedArgs];

	const home = getGlobalPiLensDir();
	fs.mkdirSync(home, { recursive: true });
	// ponytail: one Linux slot per PI_LENS_HOME, not per workspace/Pi process.
	// Batch compatible files here if serial latency becomes a measured problem.
	// Never unlink this inode: flock releases on close/exit, including crashes.
	// safeSpawnAsync owns the total wait+run timeout, abort and process-group kill.
	return [
		"flock",
		[
			"--exclusive",
			"--no-fork",
			"--",
			path.join(home, "oxlint.lock"),
			command,
			...boundedArgs,
		],
	];
}
