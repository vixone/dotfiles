import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = join(homedir(), ".pi/agent");
const version = readFileSync(join(agent, "install/current-version"), "utf8").trim();
if (!/^[a-zA-Z0-9._+-]+$/.test(version)) throw new Error("Invalid managed Pi version");
const installed = join(agent, "install/releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts");
const scratch = mkdtempSync(join(tmpdir(), "land-runtime-types-"));
try {
	const config = {
		extends: join(repo, "tsconfig.json"),
		compilerOptions: {
			typeRoots: [join(repo, "node_modules/@types")],
			paths: { "@earendil-works/pi-coding-agent": [installed] },
		},
		include: [
			join(repo, "modules/missions/extensions/mission-stack/focus-land.ts"),
			join(repo, "modules/missions/extensions/mission-stack/correction-detector.ts"),
			// Typecheck next.ts session_start/newSession usage against installed SDK types.
			join(repo, "modules/missions/extensions/mission-stack/next.ts"),
		],
	};
	const path = join(scratch, "tsconfig.json");
	writeFileSync(path, JSON.stringify(config));
	execFileSync(join(repo, "node_modules/.bin/tsc"), ["--noEmit", "-p", path], { stdio: "inherit" });
	console.log(`Land runtime hooks typechecked against Pi ${version}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
