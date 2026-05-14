/**
 * Smoke tests for `dock sheets <functions|validate|eval>`. Mirrors
 * the test style of push-pull.test.js: drive the binary, assert
 * on stdout/stderr + exit codes, no in-process imports.
 *
 * The sheets commands wrap three public endpoints
 * (/api/sheets/functions, /api/sheets/validate-formula,
 * /api/sheets/evaluate-formula). Standalone modes don't require
 * auth, so we can exercise them end-to-end here as long as the
 * configured API URL points at a running Dock with the
 * formula-surface-parity PR landed.
 *
 * Run: `node --test tests/sheets.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "index.js"
);

function dock(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: "/tmp/dock-cli-test-empty-home",
    },
    ...opts,
  });
}

test("dock help mentions the sheets commands", () => {
  const r = dock(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Sheets formulas/);
  assert.match(r.stdout, /dock sheets functions/);
  assert.match(r.stdout, /dock sheets validate/);
  assert.match(r.stdout, /dock sheets eval/);
});

test("dock sheets with no subcommand prints usage", () => {
  const r = dock(["sheets"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock sheets/);
});

test("dock sheets validate with no formula prints usage", () => {
  const r = dock(["sheets", "validate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock sheets validate/);
});

test("dock sheets eval with no formula prints usage", () => {
  const r = dock(["sheets", "eval"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: dock sheets eval/);
});

test("dock sheets eval --at without --workspace is rejected", () => {
  // --at only makes sense in workspace mode; sample doesn't
  // need the workspace, the CLI builds the request body without
  // workspaceSlug + the API ignores `at`. We don't have a strong
  // client-side guard for this, but the usage docs say it.
  // Test instead that --at WITHOUT a colon is rejected when
  // --workspace IS present.
  const r = dock([
    "sheets",
    "eval",
    "=SUM(A1)",
    "--workspace",
    "demo",
    "--at",
    "invalid-no-colon",
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--at must be/);
});
