/**
 * Smoke tests for `dock comment <subcommand>`.
 *
 * Parity build (2026-06-09, per dock/parity-audit-2026-06-09-2) added
 * five new sub-commands on top of the existing list + add:
 *   thread, reply, react, resolve, unresolve.
 *
 * Same shape as push-pull.test.js — drive the binary via child_process
 * and assert on stdout/stderr + exit codes. The five new verbs all wrap
 * REST endpoints that require auth; the tests stop at the usage-error
 * boundary so we don't need a live server. End-to-end correctness is
 * exercised in staging against the real endpoints.
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
    env: { ...process.env, HOME: "/tmp/dock-cli-test-empty-home" },
    ...opts,
  });
}

// ─── help text mentions every verb ────────────────────────────────

test("dock help mentions all comment sub-commands", () => {
  const r = dock(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dock comment list/);
  assert.match(r.stdout, /dock comment add/);
  assert.match(r.stdout, /dock comment thread/);
  assert.match(r.stdout, /dock comment reply/);
  assert.match(r.stdout, /dock comment react/);
  assert.match(r.stdout, /dock comment resolve/);
  assert.match(r.stdout, /dock comment unresolve/);
});

// ─── bare `dock comment` prints the multi-line usage ───────────────

test("dock comment with no sub-command prints multi-line usage", () => {
  const r = dock(["comment"]);
  assert.equal(r.status, 1);
  // The expanded usage block lists each verb on its own line.
  assert.match(r.stderr, /dock comment <subcommand>/);
  assert.match(r.stderr, /dock comment list/);
  assert.match(r.stderr, /dock comment thread/);
  assert.match(r.stderr, /dock comment reply/);
  assert.match(r.stderr, /dock comment react/);
  assert.match(r.stderr, /dock comment resolve/);
  assert.match(r.stderr, /dock comment unresolve/);
});

// ─── thread ────────────────────────────────────────────────────────

test("dock comment thread with no comment-id prints usage", () => {
  const r = dock(["comment", "thread"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment thread <comment-id>/);
});

test("dock comment get (alias for thread) prints usage with no id", () => {
  const r = dock(["comment", "get"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment thread <comment-id>/);
});

// ─── reply ─────────────────────────────────────────────────────────

test("dock comment reply with no comment-id prints usage", () => {
  const r = dock(["comment", "reply"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment reply <comment-id> <body>/);
});

test("dock comment reply with comment-id but no body prints usage", () => {
  const r = dock(["comment", "reply", "abc123"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment reply <comment-id> <body>/);
});

// ─── react ─────────────────────────────────────────────────────────

test("dock comment react with no comment-id prints usage", () => {
  const r = dock(["comment", "react"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment react <comment-id> <emoji>/);
});

test("dock comment react with comment-id but no emoji prints usage", () => {
  const r = dock(["comment", "react", "abc123"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment react <comment-id> <emoji>/);
});

test("dock comment react with bad action prints usage", () => {
  const r = dock(["comment", "react", "abc123", "👍", "toggle"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment react <comment-id> <emoji> \[add\|remove\]/);
});

// ─── resolve / unresolve ───────────────────────────────────────────

test("dock comment resolve with no comment-id prints usage", () => {
  const r = dock(["comment", "resolve"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment resolve <comment-id>/);
});

test("dock comment unresolve with no comment-id prints usage", () => {
  const r = dock(["comment", "unresolve"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment unresolve <comment-id>/);
});

// ─── unknown sub-command falls through to commentUsage ────────────

test("dock comment bogus-sub falls through to multi-line usage", () => {
  const r = dock(["comment", "bogus-sub"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dock comment <subcommand>/);
  // The expanded usage block lists every recognized verb.
  assert.match(r.stderr, /dock comment thread/);
});

// ─── legacy verbs still work (no regression) ───────────────────────

test("dock comment list with no args still prints its usage", () => {
  const r = dock(["comment", "list"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment list <workspace> <row-id>/);
});

test("dock comment add with no args still prints its usage", () => {
  const r = dock(["comment", "add"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock comment add <workspace> <row-id> <body>/);
});
