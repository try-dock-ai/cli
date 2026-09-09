/**
 * Tests for the `dock archive` / `dock delete` confirmation prompt
 * (support#77, issue #7).
 *
 * `delete` is a soft archive: the server keeps the workspace and
 * `dock unarchive` restores it, which the alias comment in
 * `src/index.js` already states. The prompt nevertheless called the
 * operation an irreversible delete, which stalled a cleanup pass
 * across 17 workspaces because the operator could not tell whether
 * the work was recoverable.
 *
 * These pin the wording and the non-interactive escape hatch so a
 * later edit cannot quietly reintroduce destructive language on a
 * reversible command.
 *
 * Run: `npm test`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

function freshHome() {
  return mkdtempSync(join(tmpdir(), "dock-cli-archive-test-"));
}

// An obviously fake key. It gets past `ensureAuth` so the prompt is
// reachable, and every test here answers "n" or never reaches the
// network, so the key is never actually presented to the API.
const FAKE_KEY = "dk_test_not_a_real_key";

function dock(args, opts = {}) {
  const home = freshHome();
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    // A prompt with nothing on stdin blocks forever. Without a timeout a
    // regression that reintroduces the confirmation would hang the suite
    // instead of failing it, which is a much worse way to find out.
    timeout: 15_000,
    ...opts,
    env: { ...process.env, HOME: home, DOCK_API_KEY: FAKE_KEY, ...(opts.env || {}) },
  });
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Tolerable: tmp dirs get GC'd by the OS.
  }
  return res;
}

test("the archive prompt names the operation and the way back", () => {
  const r = dock(["archive", "my-workspace"], { input: "n\n" });
  assert.match(r.stdout, /Soft-archive workspace "my-workspace"\?/);
  assert.match(r.stdout, /dock unarchive my-workspace/);
  assert.match(r.stdout, /Cancelled/);
});

test("the archive prompt does not call a reversible operation irreversible", () => {
  const r = dock(["archive", "my-workspace"], { input: "n\n" });
  assert.doesNotMatch(r.stdout, /irreversible/i);
  assert.doesNotMatch(r.stdout, /Delete workspace/i);
});

test("`delete` is an alias and gets the same prompt", () => {
  const r = dock(["delete", "my-workspace"], { input: "n\n" });
  assert.match(r.stdout, /Soft-archive workspace "my-workspace"\?/);
  assert.doesNotMatch(r.stdout, /irreversible/i);
});

test("answering n cancels without calling the API", () => {
  const r = dock(["archive", "my-workspace"], { input: "n\n" });
  assert.match(r.stdout, /Cancelled/);
  // Negative: the fake key would come back Unauthorized if the request
  // had gone out, so its absence is what proves the early return.
  assert.doesNotMatch(r.stdout + r.stderr, /Unauthorized/);
});

test("--yes skips the prompt for non-interactive callers", () => {
  // Pre-fix the only way to archive 17 workspaces in a row was to pipe
  // `yes |` into each one.
  //
  // This is the one case that reaches the API call, so it is pointed at a
  // closed local port: the suite must not depend on the network, and the
  // assertion is about the prompt being absent, not about the response.
  const r = dock(["archive", "my-workspace", "--yes"], {
    env: { DOCK_API_URL: "http://127.0.0.1:9" },
  });
  assert.doesNotMatch(r.stdout, /Soft-archive workspace/);
  assert.doesNotMatch(r.stdout, /\[y\/N\]/);
});

test("the flag is documented in help", () => {
  const r = dock(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock archive <name> \[-y\|--yes\]/);
});

test("-y is the short form and is not read as a workspace name", () => {
  // parseFlags only understands `--` flags, so a bare `-y` would otherwise
  // fall through to the positionals and archive a workspace called "-y".
  const r = dock(["archive", "-y", "my-workspace"], {
    env: { DOCK_API_URL: "http://127.0.0.1:9" },
  });
  assert.doesNotMatch(r.stdout, /Soft-archive workspace/);
  assert.doesNotMatch(r.stdout, /"-y"/);
});
