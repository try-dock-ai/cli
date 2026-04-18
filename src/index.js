#!/usr/bin/env node
/**
 * @go-dock/cli — spin up shared workspaces for humans + AI agents.
 *
 * Auth uses OAuth 2.1 + PKCE against the Dock server. The first command
 * on a fresh machine (`dock init` or `dock login`) runs the browser
 * dance; subsequent calls use the stored access token.
 *
 * All args parsing here is deliberately dependency-free so the CLI has
 * a tiny footprint.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

// ─── Config ────────────────────────────────────────────────────────

const DEFAULT_API = "https://godock.ai";
const API_BASE = process.env.DOCK_API_URL || DEFAULT_API;
const CONFIG_DIR = join(homedir(), ".dock");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function clearConfig() {
  if (existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, "{}", { mode: 0o600 });
}

// ─── HTTP helpers ──────────────────────────────────────────────────

async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  const tok = token ?? readConfig().accessToken;
  if (tok) headers.authorization = `Bearer ${tok}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: "parse_error", raw: text };
  }
  if (!res.ok) {
    const msg = data.message || data.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ─── OAuth (PKCE) ──────────────────────────────────────────────────

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Fall back to printing the URL.
  }
}

/**
 * Run the OAuth 2.1 + PKCE flow. Returns an access token.
 *   1. Register a dynamic client (Dynamic Client Registration).
 *   2. Listen on localhost for the redirect.
 *   3. Open browser to /oauth/authorize with code_challenge.
 *   4. On redirect, exchange the code for a token at /oauth/token.
 */
async function oauthFlow() {
  // Ephemeral local HTTP server for the redirect.
  const { port, once } = await ephemeralServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 1. Register the CLI as a dynamic client.
  const reg = await api("/oauth/register", {
    method: "POST",
    body: {
      client_name: "Dock CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
    },
  });
  const clientId = reg.client_id;

  // 2. Build the authorize URL with PKCE.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const authorizeUrl = new URL("/oauth/authorize", API_BASE);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "workspace:read workspace:write");

  console.log("\n  Opening your browser to sign in…");
  console.log(`  ${authorizeUrl.toString()}\n`);
  openBrowser(authorizeUrl.toString());

  // 3. Wait for callback.
  const { query } = await once;
  if (query.state !== state) {
    throw new Error("OAuth state mismatch — aborting");
  }
  if (query.error || !query.code) {
    throw new Error(query.error_description || query.error || "No authorization code returned");
  }

  // 4. Exchange code for token.
  const tokenRes = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }
  const tok = await tokenRes.json();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    clientId,
    expiresAt: tok.expires_in
      ? Date.now() + tok.expires_in * 1000
      : undefined,
  };
}

function ephemeralServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Dock CLI</title>
<style>html,body{margin:0;padding:0;height:100%;background:#0F1722;color:#E8F1F8;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center}
.ok{text-align:center}.ok h1{font-size:22px;font-weight:500;margin:0 0 8px}.ok p{opacity:0.6;font-size:14px;margin:0}</style>
</head><body><div class="ok"><h1>You're signed in</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`
      );
      const query = Object.fromEntries(url.searchParams);
      // Resolve after a tick so the response flushes.
      setTimeout(() => {
        server.close();
        resolvePromise({ query });
      }, 50);
    });
    let resolvePromise;
    const once = new Promise((r) => (resolvePromise = r));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, once });
    });
  });
}

// ─── Command implementations ──────────────────────────────────────

async function ensureAuth() {
  const cfg = readConfig();
  if (cfg.accessToken) return cfg;
  const tok = await oauthFlow();
  const next = { ...cfg, ...tok };
  writeConfig(next);
  return next;
}

const commands = {
  async init(args) {
    const cfg = await ensureAuth();
    // Fetch /api/me to confirm we're signed in.
    let me;
    try {
      me = await api("/api/me", { token: cfg.accessToken });
    } catch (e) {
      console.error("  Couldn't verify session: " + e.message);
      process.exit(1);
    }
    const who = me.type === "user" ? (me.name || me.email) : me.name;
    console.log(`\n  ✓ Authenticated as ${who}`);

    // Check existing workspaces.
    const { workspaces } = await api("/api/workspaces", { token: cfg.accessToken });
    let ws;
    if (workspaces.length === 0) {
      const name = args[0] || "my-workspace";
      console.log(`  ✓ Creating workspace "${name}"…`);
      const res = await api("/api/workspaces", {
        method: "POST",
        token: cfg.accessToken,
        body: { name, mode: "table" },
      });
      ws = res.workspace;
    } else {
      ws = workspaces[0];
      console.log(`  ✓ Workspace ready → ${ws.slug}`);
    }
    console.log(`  ✓ MCP endpoint live → ${mcpUrl(ws.slug)}`);
    console.log();
    console.log("  Hand this workspace to any agent — they're in.");
    console.log(`  Web:  ${webUrl(ws.slug)}`);
    console.log(`  MCP:  ${mcpUrl(ws.slug)}`);
    console.log();
  },

  async login() {
    const tok = await oauthFlow();
    const cfg = { ...readConfig(), ...tok };
    writeConfig(cfg);
    const me = await api("/api/me", { token: tok.accessToken });
    const who = me.type === "user" ? (me.name || me.email) : me.name;
    console.log(`\n  ✓ Signed in as ${who}\n`);
  },

  async logout() {
    clearConfig();
    console.log("  ✓ Signed out. Token removed from ~/.dock/config.json\n");
  },

  async whoami() {
    const cfg = readConfig();
    if (!cfg.accessToken) {
      console.log("  Not signed in. Run `dock login`.\n");
      return;
    }
    const me = await api("/api/me");
    if (me.type === "user") {
      console.log(`\n  ${me.name || me.email} (${me.email})`);
      console.log(`  Org: ${me.org.name}\n`);
    } else {
      console.log(`\n  ${me.name} · agent\n`);
    }
  },

  async list() {
    await ensureAuth();
    const { workspaces } = await api("/api/workspaces");
    if (workspaces.length === 0) {
      console.log("\n  No workspaces yet. Run `dock init` or `dock new <name>`.\n");
      return;
    }
    console.log();
    console.log("  NAME".padEnd(32) + "MODE".padEnd(8) + "ROWS".padEnd(8) + "MEMBERS");
    console.log("  " + "─".repeat(30) + "  " + "─".repeat(6) + "  " + "─".repeat(6) + "  " + "─".repeat(7));
    for (const w of workspaces) {
      console.log(
        "  " +
          w.slug.padEnd(30) +
          "  " +
          w.mode.padEnd(6) +
          "  " +
          String(w.rowCount).padEnd(6) +
          "  " +
          w.memberCount
      );
    }
    console.log();
  },

  async new(args) {
    await ensureAuth();
    const name = args[0];
    if (!name) return usageError("dock new <name> [--doc]");
    const mode = args.includes("--doc") ? "doc" : "table";
    const res = await api("/api/workspaces", {
      method: "POST",
      body: { name, mode },
    });
    const ws = res.workspace;
    console.log(`\n  ✓ Created ${mode} workspace ${ws.slug}`);
    console.log(`  Web:  ${webUrl(ws.slug)}`);
    console.log(`  MCP:  ${mcpUrl(ws.slug)}\n`);
  },

  async open(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock open <workspace>");
    const url = webUrl(slug);
    console.log(`  Opening ${url}…\n`);
    openBrowser(url);
  },

  async rows(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock rows <workspace>");
    const { rows } = await api(`/api/workspaces/${slug}/rows?limit=50`);
    if (rows.length === 0) {
      console.log("\n  (no rows yet)\n");
      return;
    }
    console.log();
    for (const r of rows) {
      const title = r.data?.title || r.data?.name || "(untitled)";
      const status = r.data?.status ? ` · ${r.data.status}` : "";
      console.log(`  ${String(r.position).padStart(3)}  ${title}${status}`);
    }
    console.log();
  },

  async add(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock add <workspace> key=value [key=value...]");
    const data = {};
    for (const kv of args.slice(1)) {
      const idx = kv.indexOf("=");
      if (idx <= 0) continue;
      data[kv.slice(0, idx)] = kv.slice(idx + 1);
    }
    if (Object.keys(data).length === 0) {
      return usageError("dock add <workspace> key=value [key=value...]");
    }
    const row = await api(`/api/workspaces/${slug}/rows`, {
      method: "POST",
      body: { data },
    });
    console.log(`\n  ✓ Added row ${row.id} at position ${row.position}\n`);
  },

  async share(args) {
    await ensureAuth();
    const slug = args[0];
    const email = args[1];
    const role = args[2] || "editor";
    if (!slug || !email) return usageError("dock share <workspace> <email> [role]");
    await api(`/api/workspaces/${slug}/share`, {
      method: "POST",
      body: { email, role },
    });
    console.log(`\n  ✓ Invite sent to ${email} (${role})\n`);
  },

  async help() {
    console.log(`
  dock — open shared workspaces with your agents in seconds

  Usage:
    dock init [name]              Sign in + create your first workspace
    dock login                    Sign in via browser
    dock logout                   Clear local credentials
    dock whoami                   Show the signed-in identity
    dock list                     List your workspaces
    dock new <name> [--doc]       Create a new workspace
    dock open <name>              Open workspace in browser
    dock rows <name>              List rows in a workspace
    dock add <name> key=value ... Append a row
    dock share <name> <email>     Invite a collaborator
    dock help                     Show this help

  Environment:
    DOCK_API_URL                  API base URL (default: https://godock.ai)

  Docs: https://godock.ai/docs
`);
  },
};

function mcpUrl(slug) {
  const base = API_BASE.replace(/\/$/, "");
  return `${base}/api/mcp?workspace=${slug}`;
}
function webUrl(slug) {
  const base = API_BASE.replace(/\/$/, "");
  return `${base}/workspaces/${slug}`;
}
function usageError(msg) {
  console.error(`  Usage: ${msg}`);
  process.exit(1);
}

// ─── Entry ─────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  commands.help();
} else if (commands[command]) {
  commands[command](args).catch((err) => {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  });
} else {
  console.error(`\n  Unknown command: ${command}\n  Run 'dock help' for usage.\n`);
  process.exit(1);
}
