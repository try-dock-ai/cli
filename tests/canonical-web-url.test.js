/**
 * Tests for canonical workspace URLs (support#75, issue #6).
 *
 * Docs and the product UI share `/<owner>/<slug>`. The CLI used to print
 * `/workspaces/<slug>`, which resolves but is the form nobody else uses.
 * The owner in that URL is the workspace's org (`workspace.org.slug` on
 * every Workspace object), not `/api/me`'s org: a shared workspace can
 * belong to a different org than the caller, and slugs are only unique
 * inside one org.
 *
 * The mock API runs in this process, so the CLI is launched with async
 * `spawn` (not `spawnSync`) so the event loop can still answer HTTP.
 * `DOCK_NO_BROWSER=1` keeps `dock open` from launching a real tab.
 *
 * Run: `npm test`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

function startMockApi({
  callerOrg = "guest-org",
  workspaceOrg = "mike",
  workspaceSlug = "shared-ws",
} = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/api/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "user",
          name: "Guest",
          org: { slug: callerOrg, name: callerOrg },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/api/workspaces") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let name = "untitled";
        try {
          name = JSON.parse(body).name || name;
        } catch {
          // keep default
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            workspace: {
              slug: name,
              name,
              mode: "doc",
              org: { slug: workspaceOrg },
            },
          }),
        );
      });
      return;
    }
    const getMatch = /^\/api\/workspaces\/([^/?]+)$/.exec(req.url || "");
    if (req.method === "GET" && getMatch) {
      const slug = decodeURIComponent(getMatch[1]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          workspace: {
            slug,
            name: slug,
            mode: "doc",
            org: { slug: workspaceOrg },
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        workspaceOrg,
        workspaceSlug,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function run(args, { apiBase, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dock-cli-url-test-"));
  mkdirSync(join(home, ".dock"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, ".dock", "config.json"),
    JSON.stringify({ accessToken: "dk_test_token" }),
    { mode: 0o600 },
  );
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "DOCK_API_KEY"),
  );
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        ...baseEnv,
        HOME: home,
        DOCK_API_URL: apiBase,
        DOCK_NO_BROWSER: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, 10_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      cleanup();
      resolve({ status, stdout, stderr, timedOut: false });
    });
  });

  function cleanup() {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Tolerable: tmp dirs get GC'd by the OS.
    }
  }
}

test("dock new uses workspace.org.slug from the create response", async () => {
  const api = await startMockApi({
    callerOrg: "guest-org",
    workspaceOrg: "mike",
  });
  try {
    const r = await run(["new", "cueapi-handover", "--doc"], { apiBase: api.base });
    assert.equal(r.timedOut, false, "CLI timed out talking to the mock API");
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Web:\s+http:\/\/127\.0\.0\.1:\d+\/mike\/cueapi-handover/);
    assert.doesNotMatch(r.stdout, /\/workspaces\/cueapi-handover/);
    // Must not use the caller's org when the workspace belongs to another.
    assert.doesNotMatch(r.stdout, /\/guest-org\/cueapi-handover/);
  } finally {
    await api.close();
  }
});

test("dock open uses the workspace owner, not the caller's org", async () => {
  const api = await startMockApi({
    callerOrg: "guest-org",
    workspaceOrg: "mike",
  });
  try {
    const r = await run(["open", "shared-ws"], { apiBase: api.base });
    assert.equal(r.timedOut, false, "CLI timed out talking to the mock API");
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Opening http:\/\/127\.0\.0\.1:\d+\/mike\/shared-ws/);
    assert.doesNotMatch(r.stdout, /\/guest-org\/shared-ws/);
    assert.doesNotMatch(r.stdout, /\/workspaces\/shared-ws/);
  } finally {
    await api.close();
  }
});

test("dock open falls back to /workspaces/<slug> when org is missing", async () => {
  const server = createServer((req, res) => {
    const getMatch = /^\/api\/workspaces\/([^/?]+)$/.exec(req.url || "");
    if (req.method === "GET" && getMatch) {
      res.writeHead(200, { "content-type": "application/json" });
      // Deliberately omit org: the flat form must still work.
      res.end(
        JSON.stringify({
          workspace: { slug: getMatch[1], name: getMatch[1], mode: "doc" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  const api = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}` });
    });
  });
  try {
    const r = await run(["open", "legacy-ws"], { apiBase: api.base });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Opening http:\/\/127\.0\.0\.1:\d+\/workspaces\/legacy-ws/);
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});
