import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oxlintInvocation } from "../../clients/oxlint-invocation.js";
import { setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("oxlint memory bound", () => {
	it("uses a machine-state lock, not a workspace or process-specific slot", () => {
		const env = setupTestEnvironment("pi-lens-oxlint-invocation-");
		try {
			vi.spyOn(process, "platform", "get").mockReturnValue("linux");
			const home = path.join(env.tmpDir, "state with spaces");
			vi.stubEnv("PI_LENS_HOME", home);
			expect(
				oxlintInvocation("/tool path/vp", [
					"lint",
					"--format",
					"json",
					"a;b.ts",
				]),
			).toEqual([
				"flock",
				[
					"--exclusive",
					"--no-fork",
					"--",
					path.join(home, "oxlint.lock"),
					"/tool path/vp",
					"lint",
					"--format",
					"json",
					"a;b.ts",
					"--threads=4",
				],
			]);
			expect(fs.statSync(home).isDirectory()).toBe(true);
			// A failed lock setup must not return an unlocked command.
			const badHome = path.join(env.tmpDir, "not-a-directory");
			fs.writeFileSync(badHome, "blocked");
			vi.stubEnv("PI_LENS_HOME", badHome);
			expect(() => oxlintInvocation("oxlint", ["--fix", "a.ts"])).toThrow();
		} finally {
			env.cleanup();
		}
	});

	it.each(["darwin", "win32"] as const)(
		"preserves direct execution on %s without requiring flock",
		(platform) => {
			vi.spyOn(process, "platform", "get").mockReturnValue(platform);
			expect(oxlintInvocation("oxlint", ["--fix", "a.ts"])).toEqual([
				"oxlint",
				["--fix", "a.ts", "--threads=4"],
			]);
		},
	);
});
