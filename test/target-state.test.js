import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { State, targetStateDir } from "../src/state.js";
import { surfaceState } from "../src/target.js";

/**
 * Per-target state (`surfaceState` in `src/target.js`, `targetStateDir` in `src/state.js`).
 *
 * Evidence is cached one record per transcript, keyed to the memory hash. Before each
 * named root file had its own state directory, training two files in turn with
 * `--memory-file` overwrote one file's evidence (and proposal) with the other's, so
 * switching back re-analyzed every transcript though nothing changed. These drive the
 * real CLI against a fake acpx whose quotes are real session text.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  process.stdout.write(JSON.stringify({
    positive: [{ instruction: "AG-001", moment: "start", effect: "followed it", quote: "Ran make build as instructed." }],
    negative: [],
    gaps: [{ mistake: "skipped lint", proposedInstruction: "Always run lint before pushing.", recurrenceRisk: "high", quote: "Now run the tests too." }],
  }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

function writeSession(home, id, cwd) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: "Please build the project." } },
    { type: "message", message: { role: "assistant", content: "Ran make build as instructed." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  fs.writeFileSync(
    path.join(dir, `${Date.now()}_${id}.jsonl`),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

function cli(dir, home, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      BACKPASS_ACPX_BIN: fakeAcpx,
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 20000,
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function analyze(dir, home, extra = []) {
  const result = cli(dir, home, [
    "analyze",
    "--harness",
    "pi",
    "--since",
    "all",
    "--analysis-agent",
    "pi",
    "--jobs",
    "1",
    "--json",
    ...extra,
  ]);
  assert.equal(result.status, 0, result.output);
  const { summary } = JSON.parse(result.stdout);
  return [summary.analyzed, summary.cached];
}

const AGENTS = "# Agent instructions\n\n- Run `make build` before every push.\n";
const CLAUDE = "# Claude instructions\n\n- Run `make build` before every push.\n- Keep commits small.\n";

test("training two root files in turn reuses each one's evidence: A, then B, then A analyzes nothing again", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-home-"));
  const dir = initRepo({ "AGENTS.md": AGENTS, "CLAUDE.md": CLAUDE });
  writeSession(home, "session-a", dir);
  writeSession(home, "session-b", dir);

  assert.deepEqual(analyze(dir, home, ["--memory-file", "AGENTS.md"]), [2, 0], "A: first pass");
  assert.deepEqual(analyze(dir, home, ["--memory-file", "CLAUDE.md"]), [2, 0], "B: first pass");
  assert.deepEqual(
    analyze(dir, home, ["--memory-file", "AGENTS.md"]),
    [0, 2],
    "A again: B's analysis must not have replaced A's evidence",
  );
  assert.deepEqual(analyze(dir, home, ["--memory-file", "CLAUDE.md"]), [0, 2], "B again");
  // A memory target and --memory-file naming the same file share one state directory.
  assert.deepEqual(analyze(dir, home, ["--target", "CLAUDE.md"]), [0, 2], "--target B");

  const stateDir = path.join(dir, ".backpass");
  const claudeDir = targetStateDir({ root: stateDir }, "CLAUDE.md");
  assert.equal(fs.readdirSync(path.join(claudeDir, "evidence")).length, 2);
  for (const file of fs.readdirSync(path.join(claudeDir, "evidence"))) {
    const record = JSON.parse(fs.readFileSync(path.join(claudeDir, "evidence", file), "utf8"));
    assert.equal(record.memoryPath, "CLAUDE.md");
  }
  // AGENTS.md is the default file here, so its evidence stays where a default run keeps it.
  for (const file of fs.readdirSync(path.join(stateDir, "evidence"))) {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, "evidence", file), "utf8"));
    assert.equal(record.memoryPath, "AGENTS.md");
  }
  // Scope-level files stay shared in the scope root.
  assert.equal(fs.existsSync(path.join(claudeDir, "scan-cache.json")), false);
});

test("a default run keeps .backpass/ exactly as before, and naming the default file changes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-home-"));
  const dir = initRepo({ "AGENTS.md": AGENTS });
  writeSession(home, "session-a", dir);

  assert.deepEqual(analyze(dir, home), [1, 0]);
  const stateDir = path.join(dir, ".backpass");
  const layout = () => fs.readdirSync(stateDir).sort();
  assert.deepEqual(layout(), ["apply", "evidence", "prompts", "scan-cache.json"]);
  assert.equal(fs.readdirSync(path.join(stateDir, "evidence")).length, 1);

  assert.deepEqual(analyze(dir, home, ["--memory-file", "AGENTS.md"]), [0, 1], "the default file is the default state");
  assert.deepEqual(analyze(dir, home, ["--target", "AGENTS.md"]), [0, 1]);
  assert.equal(fs.existsSync(path.join(stateDir, "targets")), false);
});

test("apply reads the named file's proposal, and a bare apply names the proposals it is not reading", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-home-"));
  const dir = initRepo({ "AGENTS.md": AGENTS, "CLAUDE.md": CLAUDE });
  const claudeDir = targetStateDir({ root: path.join(dir, ".backpass") }, "CLAUDE.md");
  fs.mkdirSync(claudeDir, { recursive: true });
  const proposal = {
    scope: "project",
    memoryFile: { path: "CLAUDE.md" },
    edits: [{ id: "e1", kind: "add", file: "CLAUDE.md", title: "t" }],
    stats: {},
    appliedAt: "2026-01-01T00:00:00.000Z",
    appliedBy: "the CLAUDE.md marker",
  };
  fs.writeFileSync(path.join(claudeDir, "proposal.json"), JSON.stringify(proposal));

  const named = cli(dir, home, ["apply", "--memory-file", "CLAUDE.md", "--no-ui"]);
  assert.equal(named.status, 1, named.output);
  assert.match(named.stderr, /already applied by the CLAUDE\.md marker/);

  delete proposal.appliedAt;
  fs.writeFileSync(path.join(claudeDir, "proposal.json"), JSON.stringify(proposal));
  const bare = cli(dir, home, ["apply", "--no-ui"]);
  assert.equal(bare.status, 1, bare.output);
  assert.match(bare.stderr, /no proposal to apply/);
  assert.match(bare.stderr, /`backpass apply --memory-file CLAUDE\.md`/);
});

test("a target state shares the scope-level files and lives under the scope's own state root", () => {
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-user-state-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-target-user-home-"));
  fs.writeFileSync(path.join(home, "AGENTS.md"), AGENTS);
  fs.writeFileSync(path.join(home, "OTHER.md"), CLAUDE);
  const rootState = new State(home, { stateDir: userRoot, mode: 0o700, exclude: false }).ensure();
  const run = { root: home, user: true, defaultMemoryFiles: ["AGENTS.md", "OTHER.md"] };

  assert.equal(surfaceState(rootState, { ...run, memoryFiles: ["AGENTS.md"] }), rootState);
  const other = surfaceState(rootState, { ...run, memoryFiles: ["OTHER.md"] });
  assert.equal(other.root, targetStateDir(rootState, "OTHER.md"));
  assert.ok(other.root.startsWith(`${userRoot}${path.sep}`), "user-scope target state stays in the user state dir");
  assert.equal(fs.existsSync(path.join(home, ".backpass")), false);
  assert.equal(other.scopeRoot, rootState.root);
  for (const key of ["rejectionsPath", "gapLedgerPath", "scanCachePath", "probeCachePath"]) {
    assert.equal(other[key], rootState[key], key);
  }
  assert.notEqual(other.proposalPath, rootState.proposalPath);
  assert.notEqual(other.evidenceDir, rootState.evidenceDir);
  if (process.platform !== "win32") assert.equal(fs.statSync(userRoot).mode & 0o777, 0o700);
});
