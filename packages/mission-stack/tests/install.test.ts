import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync, readdirSync, realpathSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const nodeDir = dirname(process.execPath);

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

function bashCheck(file: string): number {
	return spawnSync("bash", ["-n", join(repo, file)]).status ?? 1;
}

test("install.sh and scripts pass bash syntax checks", () => {
	assert.equal(bashCheck("install.sh"), 0);
	assert.equal(bashCheck("scripts/memory-export"), 0);
	assert.equal(bashCheck("scripts/memory-import"), 0);
});

// A go shim dir prepended to PATH. mode "fail" => build fails; mode "ok" =>
// writes a fake binary to the -o target so install proceeds without a real
// compile.
function goShim(mode: "fail" | "ok"): string {
	const dir = mkdtempSync(join(tmpdir(), `goshim-${mode}-`));
	const body =
		mode === "fail"
			? "#!/bin/sh\nexit 1\n"
			: `#!/bin/sh
# emulate: go build -o OUT .
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
# Fake binary: --validate-domains --domains-file F fails when F contains INVALID.
if [ -n "$out" ]; then
  cat > "$out" <<'BIN'
#!/bin/sh
# FAKE-BINARY
f=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--domains-file" ]; then shift; f="$1"; fi
  shift
done
if [ -n "$f" ] && grep -q INVALID "$f"; then echo "invalid registry" >&2; exit 1; fi
exit 0
BIN
  chmod +x "$out"
fi
exit 0
`;
	writeFileSync(join(dir, "go"), body);
	chmodSync(join(dir, "go"), 0o755);
	return dir;
}

// A cargo shim written into the go shim dir. "ok" writes a fake mx to
// <target-dir>/release/mx that answers `version`; "badbin" writes one whose
// `version` fails; "fail" fails the build; "missing" installs no cargo.
type CargoMode = "ok" | "fail" | "badbin" | "missing";
function cargoShim(dir: string, mode: CargoMode): void {
	if (mode === "missing") return;
	const versionExit = mode === "badbin" ? 1 : 0;
	const body =
		mode === "fail"
			? "#!/bin/sh\nexit 101\n"
			: `#!/bin/sh
# emulate: cargo build --release --manifest-path M --target-dir D
td=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--target-dir" ]; then shift; td="$1"; fi
  shift
done
mkdir -p "$td/release"
cat > "$td/release/mx" <<'BIN'
#!/bin/sh
# FAKE-MX
if [ "$1" = "version" ]; then echo "mx version 0.0.0-fake"; exit ${versionExit}; fi
exit 0
BIN
chmod +x "$td/release/mx"
exit 0
`;
	writeFileSync(join(dir, "cargo"), body);
	chmodSync(join(dir, "cargo"), 0o755);
}

function runInstall(home: string, shimDir: string, cargo: CargoMode = "ok") {
	cargoShim(shimDir, cargo);
	return spawnSync("bash", [join(repo, "install.sh")], {
		cwd: repo,
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: undefined,
			PATH: `${shimDir}:${nodeDir}:/usr/bin:/bin`,
			MX_TARGET_DIR: mkdtempSync(join(tmpdir(), "mx-target-")),
		},
		encoding: "utf8",
	});
}

test("a failed build aborts and leaves the previous install intact", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-home-"));
	mkdirSync(join(home, ".pi", "bin"), { recursive: true });
	const bin = join(home, ".pi", "bin", "memory-server");
	writeFileSync(bin, "OLD-BINARY");

	const res = runInstall(home, goShim("fail"));
	assert.notEqual(res.status, 0, "install must fail when the build fails");
	assert.equal(readFileSync(bin, "utf8"), "OLD-BINARY", "previous binary must be preserved");
	assert.equal(existsSync(join(home, ".pi", "agent", "mission-stack.install.json")), false, "no manifest on failed build");
});

test("successful install is idempotent and preserves an edited protocol", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-ok-"));
	const shim = goShim("ok");

	const first = runInstall(home, shim);
	assert.equal(first.status, 0, `install failed: ${first.stderr}`);
	const bin = join(home, ".pi", "bin", "memory-server");
	assert.match(readFileSync(bin, "utf8"), /FAKE-BINARY/);
	const protocol = join(home, "Missions.md");
	assert.ok(existsSync(protocol), "protocol seeded");
	assert.ok(existsSync(join(home, ".pi", "agent", "mission-stack.install.json")), "manifest written");

	// User edits the protocol; a reinstall must NOT clobber it.
	appendFileSync(protocol, "\n<!-- USER EDIT -->\n");
	const second = runInstall(home, shim);
	assert.equal(second.status, 0);
	assert.match(readFileSync(protocol, "utf8"), /USER EDIT/, "edited protocol preserved across reinstall");
});

test("install seeds the domain registry once and preserves personal edits", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-dom-"));
	const shim = goShim("ok");
	const first = runInstall(home, shim);
	assert.equal(first.status, 0, `install failed: ${first.stderr}`);
	const registry = join(home, ".pi", "agent", "knowledge", "domains.json");
	assert.equal(
		readFileSync(registry, "utf8"),
		readFileSync(join(repo, "modules/missions/memory-server", "domains.json"), "utf8"),
		"registry seeded from bundled defaults",
	);

	const edited = '{"version":1,"domains":[{"prefix":"zz-","domain":"zed"}]}\n';
	writeFileSync(registry, edited);
	const second = runInstall(home, shim);
	assert.equal(second.status, 0, `reinstall failed: ${second.stderr}`);
	assert.equal(readFileSync(registry, "utf8"), edited, "personal registry edits preserved");
});

test("an invalid installed registry aborts before modifying the install", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-baddom-"));
	const knowDir = join(home, ".pi", "agent", "knowledge");
	mkdirSync(knowDir, { recursive: true });
	mkdirSync(join(home, ".pi", "bin"), { recursive: true });
	const bin = join(home, ".pi", "bin", "memory-server");
	writeFileSync(bin, "OLD-BINARY");
	const registry = join(knowDir, "domains.json");
	writeFileSync(registry, "INVALID");

	const res = runInstall(home, goShim("ok"));
	assert.notEqual(res.status, 0, "install must fail on an invalid registry");
	assert.equal(readFileSync(bin, "utf8"), "OLD-BINARY", "previous binary preserved");
	assert.equal(readFileSync(registry, "utf8"), "INVALID", "registry left untouched");
	assert.equal(existsSync(join(home, ".pi", "agent", "extensions")), false, "extensions not installed");
	assert.equal(existsSync(join(home, ".pi", "agent", "mission-stack.install.json")), false, "no manifest");
});

test("install registers the checkout as a pi package once and retires old copies", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-pkg-"));
	const agent = join(home, ".pi", "agent");
	mkdirSync(join(agent, "extensions", "guards"), { recursive: true });
	writeFileSync(join(agent, "extensions", "guards", "index.ts"), "// old copy");
	mkdirSync(join(agent, "skills", "unrelated"), { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:foo"], theme: "x" }));
	const shim = goShim("ok");

	const first = runInstall(home, shim);
	assert.equal(first.status, 0, `install failed: ${first.stderr}`);
	const second = runInstall(home, shim);
	assert.equal(second.status, 0, `reinstall failed: ${second.stderr}`);

	const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
	assert.equal(settings.theme, "x", "other settings preserved");
	assert.deepEqual(settings.packages, ["npm:foo", realpathSync(repo)], "package registered exactly once");
	assert.equal(existsSync(join(agent, "extensions", "guards")), false, "package-provided extension copy retired");
	assert.ok(existsSync(join(agent, "skills", "unrelated")), "unrelated skills untouched");
	const backups = readdirSync(join(agent, "backups"));
	assert.equal(backups.length, 1, "one backup dir (second run had nothing to retire)");
	assert.ok(existsSync(join(agent, "backups", backups[0], "extensions", "guards", "index.ts")), "old copy kept in backup");
});

test("install links pi-sessions to this checkout and keeps regular files", () => {
	const source = join(repo, "modules", "sessions", "bin", "pi-sessions.mjs");

	const fresh = mkdtempSync(join(tmpdir(), "inst-ps-"));
	assert.equal(runInstall(fresh, goShim("ok")).status, 0);
	assert.equal(readlinkSync(join(fresh, ".local", "bin", "pi-sessions")), source);

	// An old symlink (the pre-move ~/sandbox/pi-sessions checkout) is repointed.
	const moved = mkdtempSync(join(tmpdir(), "inst-ps-old-"));
	mkdirSync(join(moved, ".local", "bin"), { recursive: true });
	symlinkSync("/nonexistent/pi-sessions/bin/pi-sessions.mjs", join(moved, ".local", "bin", "pi-sessions"));
	assert.equal(runInstall(moved, goShim("ok")).status, 0);
	assert.equal(readlinkSync(join(moved, ".local", "bin", "pi-sessions")), source);

	// A regular file is someone else's; leave it alone.
	const custom = mkdtempSync(join(tmpdir(), "inst-ps-file-"));
	mkdirSync(join(custom, ".local", "bin"), { recursive: true });
	writeFileSync(join(custom, ".local", "bin", "pi-sessions"), "MINE");
	assert.equal(runInstall(custom, goShim("ok")).status, 0);
	assert.equal(readFileSync(join(custom, ".local", "bin", "pi-sessions"), "utf8"), "MINE");
});

test("install builds mx with cargo and installs it to ~/.local/bin with a .prev backup", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-mx-"));
	const localBin = join(home, ".local", "bin");
	mkdirSync(localBin, { recursive: true });
	writeFileSync(join(localBin, "mx"), "OLD-MX");

	const res = runInstall(home, goShim("ok"));
	assert.equal(res.status, 0, `install failed: ${res.stderr}`);
	assert.match(readFileSync(join(localBin, "mx"), "utf8"), /FAKE-MX/, "new mx installed");
	assert.equal(readFileSync(join(localBin, "mx.prev"), "utf8"), "OLD-MX", "previous mx kept as mx.prev");
	const manifest = JSON.parse(readFileSync(join(home, ".pi", "agent", "mission-stack.install.json"), "utf8"));
	assert.match(manifest.mx_sha256, /^[0-9a-f]{64}$/);

	const src = readFileSync(join(repo, "install.sh"), "utf8");
	assert.match(src, /"\$CARGO_BIN" build --release --locked --manifest-path "\$MISSIONS_DIR\/mx\/Cargo\.toml"/);
	assert.match(src, /mktemp "\$\{TMPDIR:-\/tmp\}\/mx\.XXXXXX"/);
});

test("a missing cargo aborts before touching the install", () => {
	const home = mkdtempSync(join(tmpdir(), "inst-nocargo-"));
	mkdirSync(join(home, ".pi", "bin"), { recursive: true });
	writeFileSync(join(home, ".pi", "bin", "memory-server"), "OLD-BINARY");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(join(home, ".local", "bin", "mx"), "OLD-MX");

	const res = runInstall(home, goShim("ok"), "missing");
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /Cargo toolchain not found/);
	assert.equal(readFileSync(join(home, ".pi", "bin", "memory-server"), "utf8"), "OLD-BINARY");
	assert.equal(readFileSync(join(home, ".local", "bin", "mx"), "utf8"), "OLD-MX");
	assert.equal(existsSync(join(home, ".pi", "agent", "mission-stack.install.json")), false);
});

test("a failed mx build or a broken mx binary leaves the previous mx intact", () => {
	for (const mode of ["fail", "badbin"] as const) {
		const home = mkdtempSync(join(tmpdir(), `inst-mx-${mode}-`));
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(join(home, ".local", "bin", "mx"), "OLD-MX");
		const res = runInstall(home, goShim("ok"), mode);
		assert.notEqual(res.status, 0, `${mode}: install must fail`);
		assert.equal(readFileSync(join(home, ".local", "bin", "mx"), "utf8"), "OLD-MX", `${mode}: old mx kept`);
		assert.equal(existsSync(join(home, ".pi", "agent", "mission-stack.install.json")), false);
	}
});
