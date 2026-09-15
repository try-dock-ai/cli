/**
 * Tests for `dock mcp install` key selection (support#85, issue #8).
 *
 * Minting goes through `POST /api/keys`, which needs a user session
 * cookie. An agent following the onboarding prompt exports
 * `DOCK_API_KEY` and then runs `dock mcp install claude-code`, so it
 * has no cookie and the command died with "Only users can mint API
 * keys via session" on exactly the documented path. The agent already
 * holds a valid key and wiring it into the MCP host is what this
 * command is for, so there is nothing to mint.
 *
 * These pin the precedence (`--key` > `DOCK_API_KEY` > mint) and the
 * fact that the env path writes a config without touching the network.
 *
 * Run: `npm test`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

const ENV_KEY = "dk_test_agent_env_key";
const FLAG_KEY = "dk_test_explicit_flag_key";

// A closed port. Any code path that tries to reach the API fails here
// instead of leaving the machine, so a regression that reintroduces the
// mint shows up as a missing config file rather than a live request.
const DEAD_API = "http://127.0.0.1:9";

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "dock-cli-mcp-test-"));
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, HOME: home, DOCK_API_URL: DEAD_API, ...env },
  });
  const configPath = join(home, ".claude.json");
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : null;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Tolerable: tmp dirs get GC'd by the OS.
  }
  return { ...res, config };
}

function keyInConfig(config) {
  return config?.mcpServers?.dock?.env?.DOCK_API_KEY;
}

test("an agent's DOCK_API_KEY is wired up instead of minting a new key", () => {
  const r = run(["mcp", "install", "claude-code"], { DOCK_API_KEY: ENV_KEY });
  assert.match(r.stdout, /Using the key already set in DOCK_API_KEY/);
  assert.equal(keyInConfig(r.config), ENV_KEY);
});

test("the env path never reaches the mint endpoint", () => {
  // The API base is a closed port, so a surviving mint call would fail
  // and no config would be written at all.
  const r = run(["mcp", "install", "claude-code"], { DOCK_API_KEY: ENV_KEY });
  assert.doesNotMatch(r.stdout, /Minted key/);
  assert.doesNotMatch(r.stdout + r.stderr, /Only users can mint/);
  assert.notEqual(r.config, null);
});

test("--key still wins over DOCK_API_KEY", () => {
  const r = run(["mcp", "install", "claude-code", "--key", FLAG_KEY], {
    DOCK_API_KEY: ENV_KEY,
  });
  assert.equal(keyInConfig(r.config), FLAG_KEY);
  assert.doesNotMatch(r.stdout, /Using the key already set in DOCK_API_KEY/);
});

test("the restart warning still prints on the env path", () => {
  // The whole point of the command is a working tool surface, and the
  // MCP server only loads on the next session start.
  const r = run(["mcp", "install", "claude-code"], { DOCK_API_KEY: ENV_KEY });
  assert.match(r.stdout, /Restart your agent/);
});
