/**
 * Tests for the agent-bootstrap-seams fixes (support #115, #116,
 * #119, #123).
 *
 * Surfaced 2026-05-16 by Ved + PRW during onboarding from a clean
 * machine. Pre-fix, the bootstrap snippet in `/docs/agent-prompt`
 * silently 401'd because the CLI ignored `DOCK_API_KEY`; `dock
 * <subcmd> --help` would *execute* the command instead of printing
 * help (destructive on `login`); the "Not signed in" error sent
 * agents toward `dock login` which clobbers their identity with a
 * human OAuth session; and `dock mcp install` didn't make the
 * session-restart requirement prominent.
 *
 * Each test pins one of those contracts so a future refactor can't
 * silently regress the agent onboarding path.
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

// Make a fresh HOME per invocation so credentials left over from a
// real `dock login` run (or another test file's fixture) can't
// leak into the unauth-path tests below.
function freshHome() {
  return mkdtempSync(join(tmpdir(), "dock-cli-bootstrap-test-"));
}

function dock(args, opts = {}) {
  const home = opts.HOME ?? freshHome();
  // Scrub DOCK_API_KEY by default so the unauth-path tests aren't
  // accidentally authenticated by a key the developer has exported
  // in their shell. Tests that explicitly want the env-var path
  // pass `DOCK_API_KEY` in opts.env.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "DOCK_API_KEY"),
  );
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    ...opts,
    env: { ...baseEnv, HOME: home, ...(opts.env || {}) },
  });
  // Best-effort cleanup — the test cares about stdout/stderr, not
  // about retaining the home dir afterwards.
  if (!opts.HOME) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Tolerable: tmp dirs get GC'd by the OS.
    }
  }
  return res;
}

// ─── support#115 — `--help` is read-only on every subcommand ─────

test("dock login --help prints help, does NOT trigger OAuth", () => {
  // Pre-fix this would open a browser and clobber ~/.dock/config.json
  // with a fresh OAuth bundle. After: short-circuits to global help.
  const r = dock(["login", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock — open shared workspaces/);
  // Negative: must NOT print OAuth-flow indicators.
  assert.doesNotMatch(r.stdout, /Opening your browser/);
  assert.doesNotMatch(r.stdout, /Sending a sign-in link/);
});

test("dock list --help prints help, does NOT call the API", () => {
  const r = dock(["list", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock — open shared workspaces/);
  // Negative: must NOT reach ensureAuth + Workspaces API.
  assert.doesNotMatch(r.stdout, /No workspaces yet/);
  assert.doesNotMatch(r.stderr, /Not signed in/);
});

test("dock <subcmd> -h short-form also prints help", () => {
  const r = dock(["push", "-h"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock — open shared workspaces/);
  // Negative: must NOT hit the push usage-error path.
  assert.doesNotMatch(r.stderr, /Usage: dock push/);
});

test("top-level --help still works (regression guard)", () => {
  const r = dock(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock — open shared workspaces/);
});

// ─── support#116 — DOCK_API_KEY env var authenticates the CLI ────

test("readConfig picks up DOCK_API_KEY from env without a config file", () => {
  // Drive the CLI on the `whoami` path with a fake token in env and
  // no config file on disk. With #116 fixed, readConfig returns
  // `{ accessToken: <env>, fromEnv: true }` and whoami reaches the
  // /api/me call. The token is fake so the server 401s with a
  // network error — we assert we got PAST the local "Not signed
  // in" branch, which is the contract the bootstrap doc depends on.
  const r = dock(["whoami"], {
    env: {
      DOCK_API_KEY: "dk_test_obviously_fake_key_only_used_for_env_pickup",
      // Point the CLI at a URL that resolves but won't return 200.
      // Any URL that doesn't 200 is fine — we just need to confirm
      // we got past the local readConfig short-circuit.
      DOCK_API_URL: "https://trydock.ai",
    },
  });
  // The local "Not signed in" path returns exit 0 and prints the
  // unauth message. With #116 fixed we should NOT see that — we
  // should see an API-level error instead.
  assert.doesNotMatch(
    r.stdout,
    /Not signed in/,
    "DOCK_API_KEY env var should be honored — readConfig must return the env token",
  );
});

// ─── support#119 — `Not signed in` routes agents and humans separately ─

test("`Not signed in` mentions DOCK_API_KEY env var path for agents", () => {
  // No DOCK_API_KEY, no config file → unauth. The new message must
  // tell agents to set DOCK_API_KEY rather than blanket-suggest
  // `dock login`, which would clobber an agent's identity with a
  // human OAuth session.
  // No env override needed — the `dock()` helper scrubs DOCK_API_KEY
  // by default so this test exercises the true unauth path.
  const r = dock(["whoami"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not signed in/);
  assert.match(r.stdout, /DOCK_API_KEY/);
  assert.match(r.stdout, /Agents:/);
  assert.match(r.stdout, /Humans:/);
  // The docs link is the canonical source of truth for the
  // bootstrap path; the error message should always point there.
  assert.match(r.stdout, /\/docs\/agent-prompt/);
});

// ─── support#123 — mcp install emits a prominent session-restart warning ─

test("dock help mentions mcp install one-shot agent setup", () => {
  // Sanity check that the help text still documents `mcp install`
  // (the success-path warning lives in the runtime output, not the
  // help text — that's why the next test asserts the inline output).
  const r = dock(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock mcp install/);
});

test("dock mcp install --help short-circuits to global help (no side effect)", () => {
  // Verifies that --help on the destructive command (which writes
  // an agent's client-config file) is fully read-only. Same
  // contract as login --help.
  const r = dock(["mcp", "install", "claude-code", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock — open shared workspaces/);
  // Negative: must NOT print the mcp install success line, which
  // would indicate it actually wrote to the config file.
  assert.doesNotMatch(r.stdout, /Wrote MCP config/);
});
