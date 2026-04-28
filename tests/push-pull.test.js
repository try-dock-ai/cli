/**
 * Smoke tests for `dock push` / `dock pull`.
 *
 * The CLI is dependency-free by design, so tests are kept the same:
 * we drive the binary via child_process and assert on stdout/stderr +
 * exit codes, no in-process imports. End-to-end correctness is exercised
 * against staging in the agent-driven onboarding flow; these tests are
 * here to lock the CLI surface (usage strings, help text presence,
 * error messages) so a refactor doesn't silently regress UX.
 *
 * Run: `node --test tests/`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

function dock(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    // Force a config dir that doesn't have a stored token so the
    // commands hit the unauth path predictably. The auth-required
    // commands open a browser if no token is found, but that path
    // is gated by `await ensureAuth()` which fails fast when the
    // OAuth handshake can't bind to localhost in a test env. For
    // the usage-error path we never reach ensureAuth.
    env: { ...process.env, HOME: "/tmp/dock-cli-test-empty-home" },
    ...opts,
  });
}

test("dock help mentions push + pull", () => {
  const r = dock(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock push/);
  assert.match(r.stdout, /dock pull/);
  // The Agent-to-agent transport section header should anchor them
  // together so the help reads as one coherent capability.
  assert.match(r.stdout, /Agent-to-agent transport/);
});

test("dock push with no args prints usage", () => {
  const r = dock(["push"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock push <name>/);
});

test("dock pull with no args prints usage", () => {
  const r = dock(["pull"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock pull <name>/);
});

test("dock push usage message includes --from + --workspace flags", () => {
  const r = dock(["push"]);
  assert.match(r.stderr, /--workspace/);
  assert.match(r.stderr, /--from/);
});

test("dock pull usage message includes --prompt flag", () => {
  const r = dock(["pull"]);
  assert.match(r.stderr, /--prompt/);
});

test("dock push with no auth + nonexistent file errors cleanly", () => {
  // No stdin pipe (TTY-ish), file doesn't exist locally → CLI should
  // surface the "no content" usage error rather than crash. We pass
  // `<` /dev/null to make stdin not a TTY but still empty, which
  // exercises the readStdin path. The empty-stdin branch falls
  // through to the file lookup which errors cleanly.
  const r = spawnSync(
    "node",
    [CLI, "push", "nonexistent-file-${Date.now()}.md"],
    {
      encoding: "utf-8",
      env: { ...process.env, HOME: "/tmp/dock-cli-test-empty-home" },
      input: "", // empty stdin, not a TTY
    }
  );
  assert.equal(r.status, 1);
  // Either the "no content" usage error OR the auth error is
  // acceptable — what we don't want is a crash. Match either.
  const out = r.stderr + r.stdout;
  assert.ok(
    /No content/.test(out) ||
      /Refusing to push empty/.test(out) ||
      /Error/.test(out),
    `expected a graceful error, got: ${out}`
  );
});
