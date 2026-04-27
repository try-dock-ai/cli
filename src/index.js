#!/usr/bin/env node
/**
 * @trydock/cli — spin up shared workspaces for humans + AI agents.
 *
 * Auth uses OAuth 2.1 + PKCE against the Dock server. The first command
 * on a fresh machine (`dock init` or `dock login`) runs the browser
 * dance; subsequent calls use the stored access token.
 *
 * All args parsing here is deliberately dependency-free so the CLI has
 * a tiny footprint.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

// ─── Config ────────────────────────────────────────────────────────

const DEFAULT_API = "https://trydock.ai";
const API_BASE = process.env.DOCK_API_URL || DEFAULT_API;
const CONFIG_DIR = join(homedir(), ".dock");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ─── MCP client config writer table ────────────────────────────────
//
// `dock mcp install <client>` reads from this table to know which
// file to edit and how to merge a `dock` server entry into the
// existing JSON. Same paths as the @trydock/mcp README.
//
// `snippet(token)` returns just the dock entry — used in the error
// path when we can't parse existing config and have to print it for
// manual paste. `merge(existing, token)` does the full merge into
// whatever shape the client expects (mcpServers vs context_servers
// for Zed). Both keep the entry idempotent — running this twice
// just overwrites the dock server with a fresh key.

const DOCK_MCP_CMD = { command: "npx", args: ["-y", "@trydock/mcp"] };

function dockMcpEntry(token) {
  return { ...DOCK_MCP_CMD, env: { DOCK_API_KEY: token } };
}

const MCP_CLIENTS = {
  "claude-code": {
    path: "~/.claude/mcp.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
  "claude-desktop": {
    // macOS path. Linux/Windows users will need to symlink or copy
    // — the @trydock/mcp README documents the cross-OS variants.
    path: "~/Library/Application Support/Claude/claude_desktop_config.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
  cursor: {
    path: "~/.cursor/mcp.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
  windsurf: {
    path: "~/.codeium/windsurf/mcp_config.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
  zed: {
    // Zed uses `context_servers` inside the global settings file.
    // Settings file is JSONC in the wild but most installs work
    // with strict JSON; we write strict JSON and trust the editor
    // to round-trip it. If the user has comments, parsing will
    // fail and we fall through to print-the-snippet.
    path: "~/.config/zed/settings.json",
    snippet: (t) => ({ context_servers: { dock: DOCK_MCP_CMD } }),
    merge: (cur, t) => ({
      ...cur,
      context_servers: { ...(cur.context_servers || {}), dock: dockMcpEntry(t) },
    }),
  },
  cline: {
    // Cline (VS Code extension) reads from a settings JSON the user
    // has to point us at. We default to the macOS user settings;
    // override with --path on the (future) flag.
    path: "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
  continue: {
    path: "~/.continue/config.json",
    snippet: (t) => ({ mcpServers: { dock: dockMcpEntry(t) } }),
    merge: (cur, t) => ({
      ...cur,
      mcpServers: { ...(cur.mcpServers || {}), dock: dockMcpEntry(t) },
    }),
  },
};

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
async function oauthFlow({ ref, email } = {}) {
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
  // Carry a referral code through the OAuth handoff. The authorize page
  // forwards it to /login?ref=… for new-account signups against the
  // invite-only gate; harmless for sign-in of existing accounts.
  if (ref) authorizeUrl.searchParams.set("ref", ref);
  // Pre-supply the email so the customer doesn't have to type it in the
  // browser form. Authorize page reads ?email= and skips straight to
  // "we sent you a sign-in link" — agent-friendly because the customer
  // just clicks the email link, no in-browser typing.
  if (email) authorizeUrl.searchParams.set("email", email);

  if (email) {
    console.log(`\n  Sending a sign-in link to ${email}…`);
    console.log(`  Click the link from your inbox; this terminal continues automatically.`);
    console.log(`  ${authorizeUrl.toString()}\n`);
  } else {
    console.log("\n  Opening your browser to sign in…");
    console.log(`  ${authorizeUrl.toString()}\n`);
  }
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

// ─── Output helpers ───────────────────────────────────────────────

// Set by the entry point if `--json` is present anywhere in argv.
let JSON_MODE = false;

function out(human, jsonValue) {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(jsonValue ?? human, null, 2) + "\n");
  } else if (typeof human === "string") {
    process.stdout.write(human);
  } else {
    process.stdout.write(JSON.stringify(human, null, 2) + "\n");
  }
}

/** Pull `--key value` and `--flag` out of args. Returns { positional, flags }. */
function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      flags.json = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function confirm(prompt) {
  // Crude but dependency-free yes/no.
  process.stdout.write(`  ${prompt} [y/N]: `);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(chunk.toString().trim().toLowerCase().startsWith("y"));
    });
  });
}

// ─── Command implementations ──────────────────────────────────────

async function ensureAuth({ ref, email } = {}) {
  const cfg = readConfig();
  if (cfg.accessToken) return cfg;
  const tok = await oauthFlow({ ref, email });
  const next = { ...cfg, ...tok };
  writeConfig(next);
  return next;
}

/**
 * Pull a referral code out of either a bare code or a full
 * `https://trydock.ai/invite/<code>` URL — whichever a user pastes
 * after `--ref`. Returns null if the input doesn't look like either.
 */
function parseRefArg(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  // Full URL form.
  try {
    const u = new URL(trimmed);
    const m = u.pathname.match(/\/invite\/([A-Za-z0-9_-]{1,64})\/?$/);
    if (m) return m[1];
  } catch {
    // Not a URL — fall through to treat as a bare code.
  }
  // Bare code: alphanumeric/underscore/hyphen, ≤64 chars.
  if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
  return null;
}

/** Lazy-fetch and cache the caller's org slug. Used by every org-scoped
 *  command (webhooks, billing, support, etc.). */
let _meCache = null;
async function getMe() {
  if (_meCache) return _meCache;
  await ensureAuth();
  _meCache = await api("/api/me");
  return _meCache;
}

async function getOrgSlug() {
  const me = await getMe();
  if (!me?.org?.slug) {
    throw new Error("Couldn't resolve your org. Try `dock logout` and `dock login` again.");
  }
  return me.org.slug;
}

/** Parse `key=value` args (with `=` allowed in the value) into a record. */
function parseKv(parts) {
  const data = {};
  for (const kv of parts) {
    const idx = kv.indexOf("=");
    if (idx <= 0) continue;
    data[kv.slice(0, idx)] = kv.slice(idx + 1);
  }
  return data;
}

/** Read all of stdin as a string. Returns "" if stdin is a TTY (no pipe). */
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf.trim()));
    process.stdin.on("error", reject);
  });
}

const commands = {
  async init(args) {
    const { positional, flags } = parseFlags(args);
    let ref = null;
    if (flags.ref) {
      ref = parseRefArg(flags.ref);
      if (!ref) {
        console.error(
          "  --ref expects a code (e.g. abc123) or a full referral URL\n" +
            "  like https://trydock.ai/invite/abc123."
        );
        process.exit(1);
      }
    }
    // `--email` lets the agent driving this CLI pre-supply the email so
    // the customer doesn't have to type it in the OAuth browser form. The
    // authorize page reads ?email= and skips the form, going straight to
    // "we sent you a sign-in link" while the localhost listener waits.
    // See dock-app/src/app/oauth/authorize/page.tsx for the server side.
    const email = typeof flags.email === "string" ? flags.email : undefined;
    const cfg = await ensureAuth({ ref, email });
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
      const name = positional[0] || "my-workspace";
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

  async login(args) {
    const { flags } = parseFlags(args || []);
    let ref = null;
    if (flags.ref) {
      ref = parseRefArg(flags.ref);
      if (!ref) {
        console.error(
          "  --ref expects a code (e.g. abc123) or a full referral URL\n" +
            "  like https://trydock.ai/invite/abc123."
        );
        process.exit(1);
      }
    }
    const email = typeof flags.email === "string" ? flags.email : undefined;
    const tok = await oauthFlow({ ref, email });
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

  // ─── Workspaces (additions) ────────────────────────────────────

  async rename(args) {
    await ensureAuth();
    const [slug, ...rest] = args;
    const newName = rest.join(" ").trim();
    if (!slug || !newName) return usageError("dock rename <workspace> <new-name>");
    const r = await api(`/api/workspaces/${slug}`, {
      method: "PATCH",
      body: { name: newName },
    });
    out(`\n  ✓ Renamed → ${r.workspace?.slug || slug}\n`, r);
  },

  async visibility(args) {
    await ensureAuth();
    const [slug, value] = args;
    if (!slug || !value) {
      return usageError("dock visibility <workspace> <private|org|unlisted|public>");
    }
    const r = await api(`/api/workspaces/${slug}`, {
      method: "PATCH",
      body: { visibility: value },
    });
    out(`\n  ✓ Visibility set to ${value}\n`, r);
  },

  async delete(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock delete <workspace>");
    if (!JSON_MODE) {
      const ok = await confirm(`Delete workspace "${slug}"? This is irreversible.`);
      if (!ok) {
        out("  Cancelled.\n", { cancelled: true });
        return;
      }
    }
    await api(`/api/workspaces/${slug}`, { method: "DELETE" });
    out(`\n  ✓ Deleted ${slug}\n`, { deleted: slug });
  },

  // `archive` is an alias for `delete` — same soft-archive semantics,
  // restorable via `dock unarchive`. Reads more naturally in scripts.
  async archive(args) {
    return commands.delete(args);
  },

  async unarchive(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock unarchive <workspace>");
    const r = await api(`/api/workspaces/${slug}/unarchive`, { method: "POST" });
    out(`\n  ✓ Restored ${slug}\n`, r);
  },

  async pin(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock pin <workspace>");
    const r = await api(`/api/workspaces/${slug}/pin`, { method: "POST" });
    out(`\n  ✓ Pinned ${slug}\n`, r);
  },

  async unpin(args) {
    await ensureAuth();
    const slug = args[0];
    if (!slug) return usageError("dock unpin <workspace>");
    const r = await api(`/api/workspaces/${slug}/pin`, { method: "DELETE" });
    out(`\n  ✓ Unpinned ${slug}\n`, r);
  },

  // ─── Rows (additions) ──────────────────────────────────────────

  async get(args) {
    await ensureAuth();
    const [slug, id] = args;
    if (!slug || !id) return usageError("dock get <workspace> <row-id>");
    const { rows } = await api(`/api/workspaces/${slug}/rows?limit=1000`);
    const row = rows.find((r) => r.id === id);
    if (!row) {
      throw new Error(`Row ${id} not found in ${slug}`);
    }
    out(JSON.stringify(row.data, null, 2) + "\n", row);
  },

  async set(args) {
    await ensureAuth();
    const [slug, id, ...kv] = args;
    if (!slug || !id || kv.length === 0) {
      return usageError("dock set <workspace> <row-id> key=value [key=value ...]");
    }
    const data = parseKv(kv);
    const r = await api(`/api/workspaces/${slug}/rows/${id}`, {
      method: "PATCH",
      body: { data },
    });
    out(`\n  ✓ Updated row ${id}\n`, r);
  },

  async remove(args) {
    await ensureAuth();
    const [slug, id] = args;
    if (!slug || !id) return usageError("dock remove <workspace> <row-id>");
    await api(`/api/workspaces/${slug}/rows/${id}`, { method: "DELETE" });
    out(`\n  ✓ Removed row ${id}\n`, { deleted: id });
  },

  async history(args) {
    await ensureAuth();
    const [slug, id] = args;
    if (!slug || !id) return usageError("dock history <workspace> <row-id>");
    const { history } = await api(`/api/workspaces/${slug}/rows/${id}/history`);
    if (JSON_MODE) return out(history);
    if (!history?.length) {
      out("\n  (no history)\n");
      return;
    }
    out("\n");
    for (const h of history) {
      const when = new Date(h.createdAt).toISOString().slice(0, 19).replace("T", " ");
      out(`  ${when}  ${h.action}\n`);
    }
    out("\n");
  },

  // Bulk update rows. Reads an updates array from --file <path> or
  // stdin so a script can paste-fill a range without firing one PATCH
  // per cell. Body shape: { updates: [{ id, data }, ...] } — each
  // row's data is merged into the existing JSONB blob.
  async bulk(args) {
    await ensureAuth();
    const sub = args[0];
    if (sub !== "update") return usageError("dock bulk update <workspace> [--file path] [--stdin]");
    const slug = args[1];
    if (!slug) return usageError("dock bulk update <workspace> [--file path] [--stdin]");
    const { flags } = parseFlags(args.slice(2));
    let payload;
    if (flags.file) {
      payload = JSON.parse(readFileSync(String(flags.file), "utf-8"));
    } else {
      const raw = await readStdin();
      if (!raw) return usageError("dock bulk update <workspace> [--file path] [--stdin]");
      payload = JSON.parse(raw);
    }
    const body = Array.isArray(payload) ? { updates: payload } : payload;
    const r = await api(`/api/workspaces/${slug}/rows/bulk`, {
      method: "PATCH",
      body,
    });
    out(`\n  ✓ Updated ${r.updated} row(s)\n`, r);
  },

  // Row comments. `dock comment <list|add> <workspace> <row-id> [body]`.
  async comment(args) {
    await ensureAuth();
    const sub = args[0];
    const [slug, id, ...rest] = args.slice(1);
    if (!sub || !slug || !id) {
      return usageError("dock comment <list|add> <workspace> <row-id> [body]");
    }
    if (sub === "list" || sub === "ls") {
      const { comments } = await api(
        `/api/workspaces/${slug}/rows/${id}/comments`
      );
      if (JSON_MODE) return out(comments);
      if (!comments.length) {
        out("\n  (no comments)\n");
        return;
      }
      out("\n");
      for (const c of comments) {
        const when = new Date(c.createdAt).toISOString().slice(0, 19).replace("T", " ");
        out(`  ${when}  ${c.principalName}: ${c.body}\n`);
      }
      out("\n");
      return;
    }
    if (sub === "add") {
      const body = rest.join(" ").trim();
      if (!body) return usageError("dock comment add <workspace> <row-id> <body>");
      const r = await api(`/api/workspaces/${slug}/rows/${id}/comments`, {
        method: "POST",
        body: { body },
      });
      out(`\n  ✓ Comment added\n`, r);
      return;
    }
    return usageError("dock comment <list|add> <workspace> <row-id> [body]");
  },

  // ─── Columns ───────────────────────────────────────────────────

  async columns(args) {
    await ensureAuth();
    const [slug] = args;
    if (!slug) return usageError("dock columns <workspace>");
    const { columns } = await api(`/api/workspaces/${slug}/columns`);
    if (JSON_MODE) return out(columns);
    out("\n");
    for (const c of columns) {
      out(`  ${c.key.padEnd(20)} ${c.type.padEnd(10)} ${c.label}\n`);
    }
    out("\n");
  },

  // ─── Members ───────────────────────────────────────────────────

  async members(args) {
    await ensureAuth();
    const [slug] = args;
    if (!slug) return usageError("dock members <workspace>");
    const { members, invites } = await api(`/api/workspaces/${slug}/members`);
    if (JSON_MODE) return out({ members, invites });
    out("\n  Members\n");
    for (const m of members) {
      const name = m.user?.name || m.user?.email || m.agent?.name || "unknown";
      out(`    ${m.role.padEnd(10)} ${name}  ${m.id}\n`);
    }
    if (invites?.length) {
      out("\n  Pending invites\n");
      for (const i of invites) out(`    ${i.role.padEnd(10)} ${i.email}\n`);
    }
    out("\n");
  },

  // Per-workspace member admin (role change, removal). For org-wide
  // membership see `dock team`.
  async member(args) {
    const sub = args[0];
    const slug = args[1];
    const memberId = args[2];
    if (!sub || !slug || !memberId) {
      return usageError(
        "dock member <role|remove> <workspace> <member-id> [role]"
      );
    }
    await ensureAuth();
    if (sub === "role") {
      const role = args[3];
      if (!role) {
        return usageError(
          "dock member role <workspace> <member-id> <owner|editor|commenter|viewer>"
        );
      }
      const r = await api(
        `/api/workspaces/${slug}/members/${memberId}`,
        { method: "PATCH", body: { role } }
      );
      out(`\n  ✓ Role set to ${role}\n`, r);
      return;
    }
    if (sub === "rm" || sub === "remove" || sub === "delete") {
      if (!JSON_MODE) {
        const ok = await confirm(`Remove member ${memberId} from ${slug}?`);
        if (!ok) {
          out("  Cancelled.\n", { cancelled: true });
          return;
        }
      }
      await api(`/api/workspaces/${slug}/members/${memberId}`, {
        method: "DELETE",
      });
      out(`\n  ✓ Removed ${memberId}\n`, { removed: memberId });
      return;
    }
    return usageError("dock member <role|remove> <workspace> <member-id> [role]");
  },

  // ─── Org members + invites (Teams) ─────────────────────────────

  // `dock team list`, `dock team invite [--email <e>] [--role member|admin]`,
  // `dock team role <user-id> <member|admin>`, `dock team remove <user-id>`,
  // `dock team resend <invite-id>`, `dock team revoke <invite-id>`.
  async team(args) {
    const sub = args[0] || "list";
    const rest = args.slice(1);
    await ensureAuth();
    const slug = await getOrgSlug();

    if (sub === "list" || sub === "ls") {
      const r = await api(`/api/orgs/${slug}/members`);
      if (JSON_MODE) return out(r);
      out("\n  Members\n");
      for (const m of r.members || []) {
        const name = m.user?.name || m.user?.email || m.user?.id || "?";
        out(`    ${String(m.role).padEnd(8)} ${name}  ${m.user?.id || ""}\n`);
      }
      if (r.invites?.length) {
        out("\n  Pending invites\n");
        for (const i of r.invites) {
          const tag = i.email ? i.email : "(open link)";
          out(`    ${String(i.role).padEnd(8)} ${tag}  ${i.id}\n`);
        }
      }
      out("\n");
      return;
    }

    if (sub === "invite") {
      const { flags } = parseFlags(rest);
      const body = {};
      if (flags.email) body.email = String(flags.email);
      if (flags.role) body.role = String(flags.role);
      if (flags.expiresInDays) body.expiresInDays = Number(flags.expiresInDays);
      if (flags["max-uses"]) body.maxUses = Number(flags["max-uses"]);
      const r = await api(`/api/orgs/${slug}/invites`, {
        method: "POST",
        body,
      });
      if (JSON_MODE) return out(r);
      const invite = r.invite || r;
      if (invite.email) {
        out(`\n  ✓ Invite emailed to ${invite.email}\n`);
      } else {
        const link = `${API_BASE}/join/${invite.token || invite.id}`;
        out(`\n  ✓ Open-link invite created\n  ${link}\n`);
      }
      out("\n");
      return;
    }

    if (sub === "role") {
      const userId = rest[0];
      const role = rest[1];
      if (!userId || !role) {
        return usageError("dock team role <user-id> <member|admin>");
      }
      const r = await api(`/api/orgs/${slug}/members/${userId}`, {
        method: "PATCH",
        body: { role },
      });
      out(`\n  ✓ Role set to ${role}\n`, r);
      return;
    }

    if (sub === "rm" || sub === "remove") {
      const userId = rest[0];
      if (!userId) return usageError("dock team remove <user-id>");
      if (!JSON_MODE) {
        const ok = await confirm(`Remove ${userId} from org ${slug}?`);
        if (!ok) {
          out("  Cancelled.\n", { cancelled: true });
          return;
        }
      }
      await api(`/api/orgs/${slug}/members/${userId}`, { method: "DELETE" });
      out(`\n  ✓ Removed ${userId}\n`, { removed: userId });
      return;
    }

    if (sub === "resend") {
      const id = rest[0];
      if (!id) return usageError("dock team resend <invite-id>");
      const r = await api(`/api/orgs/${slug}/invites/${id}/resend`, {
        method: "POST",
      });
      out(`\n  ✓ Invite resent\n`, r);
      return;
    }

    if (sub === "revoke") {
      const id = rest[0];
      if (!id) return usageError("dock team revoke <invite-id>");
      await api(`/api/orgs/${slug}/invites/${id}`, { method: "DELETE" });
      out(`\n  ✓ Revoked ${id}\n`, { revoked: id });
      return;
    }

    return usageError(
      "dock team <list|invite|role|remove|resend|revoke> ..."
    );
  },

  // Accept a team invite by token (open-link or email-scoped). For
  // newly-signed-up users the token will already have been consumed
  // during signup, so this is mostly for users joining an additional
  // org from an existing account.
  async accept(args) {
    await ensureAuth();
    const token = args[0];
    if (!token) return usageError("dock accept <invite-token>");
    const r = await api(`/api/org-invites/${token}`, { method: "POST" });
    out(`\n  ✓ Joined ${r.org?.slug || "org"}\n`, r);
  },

  // ─── Agents (signed agents in the caller's org) ────────────────

  // `dock agents` — list. `dock agent <show|rename|archive|unarchive|invite|invites|revoke>`.
  async agents() {
    await ensureAuth();
    const r = await api("/api/agents/overview");
    if (JSON_MODE) return out(r);
    if (!r.agents?.length) {
      out("\n  No agents yet. Mint one in Settings · Agents.\n");
      return;
    }
    out("\n  NAME".padEnd(28) + "MODEL".padEnd(20) + "OWNER\n");
    out("  " + "─".repeat(26) + "  " + "─".repeat(18) + "  " + "─".repeat(20) + "\n");
    for (const a of r.agents) {
      const owner = a.creator?.name || a.creator?.email || "";
      out(
        "  " +
          (a.name || "(unnamed)").padEnd(26) +
          "  " +
          String(a.modelHint || "").padEnd(18) +
          "  " +
          owner +
          "  " +
          a.id +
          "\n"
      );
    }
    out("\n");
  },

  async agent(args) {
    const sub = args[0];
    const id = args[1];
    if (!sub) return usageError("dock agent <show|rename|archive|invite|invites|revoke> <id>");
    await ensureAuth();

    if (sub === "show" || sub === "get") {
      // No GET /api/agents/[id] — derive from /agents/overview which
      // returns the full per-agent snapshot the UI uses anyway.
      if (!id) return usageError("dock agent show <id>");
      const r = await api("/api/agents/overview");
      const agent = (r.agents || []).find((a) => a.id === id);
      if (!agent) {
        throw new Error(`Agent ${id} not found in your org`);
      }
      return out(agent);
    }
    if (sub === "rename") {
      const name = args.slice(2).join(" ").trim();
      if (!id || !name) return usageError("dock agent rename <id> <new-name>");
      const r = await api(`/api/agents/${id}`, {
        method: "PATCH",
        body: { name },
      });
      out(`\n  ✓ Renamed to ${name}\n`, r);
      return;
    }
    if (sub === "archive" || sub === "rm" || sub === "delete") {
      if (!id) return usageError("dock agent archive <id>");
      if (!JSON_MODE) {
        const ok = await confirm(
          `Archive agent ${id}? This revokes its keys + OAuth tokens.`
        );
        if (!ok) {
          out("  Cancelled.\n", { cancelled: true });
          return;
        }
      }
      const r = await api(`/api/agents/${id}`, { method: "DELETE" });
      out(`\n  ✓ Archived ${id}\n`, r);
      return;
    }
    if (sub === "invite") {
      if (!id) return usageError("dock agent invite <id> [--workspace <ws-id>] [--expires-in-minutes N]");
      const { flags } = parseFlags(args.slice(2));
      const body = {};
      if (flags.workspace) body.workspaceId = String(flags.workspace);
      if (flags["expires-in-minutes"]) {
        body.expiresInMinutes = Number(flags["expires-in-minutes"]);
      }
      const r = await api(`/api/agents/${id}/invites`, {
        method: "POST",
        body,
      });
      if (JSON_MODE) return out(r);
      out(`\n  ✓ Agent invite minted\n`);
      if (r.claimUrl || r.url) out(`  ${r.claimUrl || r.url}\n`);
      if (r.token) out(`  Token (shown once): ${r.token}\n`);
      out("\n");
      return;
    }
    if (sub === "invites" || sub === "list-invites") {
      if (!id) return usageError("dock agent invites <id>");
      const r = await api(`/api/agents/${id}/invites`);
      return out(r);
    }
    if (sub === "revoke") {
      const inviteId = args[2];
      if (!id || !inviteId) {
        return usageError("dock agent revoke <agent-id> <invite-id>");
      }
      await api(`/api/agents/${id}/invites/${inviteId}`, { method: "DELETE" });
      out(`\n  ✓ Revoked ${inviteId}\n`, { revoked: inviteId });
      return;
    }
    return usageError(
      "dock agent <show|rename|archive|invite|invites|revoke> <id>"
    );
  },

  // ─── Doc body ──────────────────────────────────────────────────

  // Read or write the rich-text doc body. Write reads ProseMirror JSON
  // from --file or stdin; the server validates shape via doc-guard
  // before writing. Last-write-wins (no CRDT yet).
  //
  //   dock doc <workspace>                     read JSON
  //   dock doc <workspace> --markdown          read as markdown
  //   dock doc <workspace> --text              read as plain text
  //   dock doc set <workspace> --file body.json
  //   cat body.json | dock doc set <workspace>
  async doc(args) {
    await ensureAuth();
    if (args[0] === "set" || args[0] === "write" || args[0] === "update") {
      const slug = args[1];
      if (!slug) return usageError("dock doc set <workspace> [--file path]");
      const { flags } = parseFlags(args.slice(2));
      let payload;
      if (flags.file) {
        payload = JSON.parse(readFileSync(String(flags.file), "utf-8"));
      } else {
        const raw = await readStdin();
        if (!raw) return usageError("dock doc set <workspace> [--file path]");
        payload = JSON.parse(raw);
      }
      // Accept either a bare ProseMirror doc or `{ content: ... }`.
      const body = payload && payload.content ? payload : { content: payload };
      const r = await api(`/api/workspaces/${slug}/doc`, {
        method: "PUT",
        body,
      });
      out(`\n  ✓ Doc updated\n`, r);
      return;
    }
    const [slug] = args;
    if (!slug) return usageError("dock doc <workspace> [set] [--markdown|--text]");
    const { flags } = parseFlags(args.slice(1));
    let qs = "";
    if (flags.markdown) qs = "?format=markdown";
    else if (flags.text) qs = "?format=text";
    const r = await api(`/api/workspaces/${slug}/doc${qs}`);
    if (JSON_MODE) return out(r);
    if (flags.markdown) out(r.markdown + "\n");
    else if (flags.text) out(r.text + "\n");
    else out(JSON.stringify(r.content, null, 2) + "\n");
  },

  // ─── Column schema mutations ───────────────────────────────────

  // `dock column add <workspace> <key> <type> [--label "..."] [--options "a,b,c"]`
  // `dock column rm <workspace> <key>` (drops via PUT-rebuild)
  // `dock column rename <workspace> <key> <new-label>` (PUT-rebuild)
  async column(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (!sub) {
      return usageError(
        "dock column <add|rm|rename> <workspace> ... (see 'dock help')"
      );
    }
    await ensureAuth();
    if (sub === "add" || sub === "create") {
      const slug = rest[0];
      const key = rest[1];
      const type = rest[2];
      if (!slug || !key || !type) {
        return usageError(
          'dock column add <workspace> <key> <type> [--label "..."] [--options "a,b,c"]'
        );
      }
      const { flags } = parseFlags(rest.slice(3));
      const column = {
        key,
        type,
        label: flags.label ? String(flags.label) : key,
      };
      if (flags.options) {
        column.options = String(flags.options)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (flags.description) column.description = String(flags.description);
      if (flags.width) column.width = Number(flags.width);
      const r = await api(`/api/workspaces/${slug}/columns`, {
        method: "POST",
        body: { column },
      });
      out(`\n  ✓ Added column "${key}" (${type})\n`, r);
      return;
    }
    if (sub === "rm" || sub === "delete" || sub === "remove") {
      const slug = rest[0];
      const key = rest[1];
      if (!slug || !key) return usageError("dock column rm <workspace> <key>");
      const { columns } = await api(`/api/workspaces/${slug}/columns`);
      const next = columns
        .filter((c) => c.key !== key)
        // Renumber positions to stay contiguous (PUT requires it).
        .map((c, i) => ({ ...c, position: i }));
      if (next.length === columns.length) {
        return usageError(`Column "${key}" not found in ${slug}`);
      }
      if (!JSON_MODE) {
        const ok = await confirm(`Drop column "${key}" from ${slug}? Cell data is lost.`);
        if (!ok) {
          out("  Cancelled.\n", { cancelled: true });
          return;
        }
      }
      const r = await api(`/api/workspaces/${slug}/columns`, {
        method: "PUT",
        body: { columns: next },
      });
      out(`\n  ✓ Dropped column "${key}"\n`, r);
      return;
    }
    if (sub === "rename" || sub === "update") {
      const slug = rest[0];
      const key = rest[1];
      const newLabel = rest.slice(2).join(" ").trim();
      if (!slug || !key || !newLabel) {
        return usageError("dock column rename <workspace> <key> <new-label>");
      }
      const { columns } = await api(`/api/workspaces/${slug}/columns`);
      const next = columns.map((c) =>
        c.key === key ? { ...c, label: newLabel } : c
      );
      if (!next.some((c) => c.key === key)) {
        return usageError(`Column "${key}" not found in ${slug}`);
      }
      const r = await api(`/api/workspaces/${slug}/columns`, {
        method: "PUT",
        body: { columns: next },
      });
      out(`\n  ✓ Renamed column "${key}" to "${newLabel}"\n`, r);
      return;
    }
    return usageError("dock column <add|rm|rename> <workspace> ...");
  },

  // ─── Webhooks (org-scoped) ─────────────────────────────────────

  async webhook(args) {
    const sub = args[0];
    const rest = args.slice(1);
    // Validate arg shape before hitting the network so a missing flag
    // doesn't surface as "fetch failed".
    if (!sub) {
      return usageError(
        "dock webhook <list|add|update|pause|resume|rm|deliveries|retry|rotate-secret> [args]"
      );
    }
    if (sub === "add") {
      const { flags } = parseFlags(rest);
      if (!flags.url) {
        return usageError(
          'dock webhook add --url <https://…> [--events "row.created,row.updated"]'
        );
      }
    }
    const slug = await getOrgSlug();
    switch (sub) {
      case "list": {
        const { webhooks } = await api(`/api/orgs/${slug}/webhooks`);
        if (JSON_MODE) return out(webhooks);
        if (!webhooks.length) {
          out("\n  No webhooks. Add one with `dock webhook add --url ...`\n");
          return;
        }
        out("\n");
        for (const w of webhooks) {
          const events = Array.isArray(w.events) ? w.events.join(",") : "";
          out(
            `  ${w.id}  ${w.active ? "ACTIVE " : "PAUSED "}  ${w.url}\n`
          );
          out(`    events: ${events}\n`);
        }
        out("\n");
        return;
      }
      case "add": {
        const { flags } = parseFlags(rest);
        if (!flags.url) {
          return usageError(
            'dock webhook add --url <https://…> [--events "row.created,row.updated"]'
          );
        }
        const events = flags.events
          ? String(flags.events).split(",").map((s) => s.trim()).filter(Boolean)
          : ["row.created", "row.updated", "row.deleted"];
        const r = await api(`/api/orgs/${slug}/webhooks`, {
          method: "POST",
          body: { url: flags.url, events },
        });
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Created ${r.webhook.id}\n`);
        out(`  Secret (shown once, store it now):\n  ${r.webhook.secret}\n\n`);
        return;
      }
      case "pause":
      case "resume": {
        const id = rest[0];
        if (!id) return usageError(`dock webhook ${sub} <webhook-id>`);
        const r = await api(`/api/orgs/${slug}/webhooks/${id}`, {
          method: "PATCH",
          body: { active: sub === "resume" },
        });
        out(`\n  ✓ ${sub === "resume" ? "Resumed" : "Paused"} ${id}\n`, r);
        return;
      }
      case "rm":
      case "delete":
      case "remove": {
        const id = rest[0];
        if (!id) return usageError("dock webhook rm <webhook-id>");
        await api(`/api/orgs/${slug}/webhooks/${id}`, { method: "DELETE" });
        out(`\n  ✓ Removed ${id}\n`, { deleted: id });
        return;
      }
      case "deliveries":
      case "logs": {
        const id = rest[0];
        if (!id) return usageError("dock webhook deliveries <webhook-id>");
        const { deliveries } = await api(
          `/api/orgs/${slug}/webhooks/${id}/deliveries`
        );
        if (JSON_MODE) return out(deliveries);
        if (!deliveries.length) {
          out("\n  No deliveries yet.\n");
          return;
        }
        out("\n");
        for (const d of deliveries) {
          const when = new Date(d.createdAt).toISOString().slice(0, 19).replace("T", " ");
          out(
            `  ${when}  ${String(d.status).padEnd(10)} ${d.event.padEnd(28)} ${
              d.lastResponseCode ?? ""
            }\n`
          );
          if (d.lastError) out(`    error: ${d.lastError}\n`);
        }
        out("\n");
        return;
      }
      case "update": {
        // Update a webhook's URL or events list. Use `pause`/`resume`
        // for the active flag (legible verbs win over `--active=true`).
        const id = rest[0];
        if (!id) {
          return usageError(
            'dock webhook update <id> [--url <https://…>] [--events "row.created,..."]'
          );
        }
        const { flags } = parseFlags(rest.slice(1));
        const body = {};
        if (flags.url) body.url = String(flags.url);
        if (flags.events) {
          body.events = String(flags.events)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (Object.keys(body).length === 0) {
          return usageError(
            'dock webhook update <id> [--url <https://…>] [--events "..."]'
          );
        }
        const r = await api(`/api/orgs/${slug}/webhooks/${id}`, {
          method: "PATCH",
          body,
        });
        out(`\n  ✓ Updated ${id}\n`, r);
        return;
      }
      case "retry": {
        // Retry a single delivery by its delivery id (NOT webhook id).
        // The cron retry loop handles automatic retries; this is the
        // manual escape hatch for "I just fixed my server, push it now".
        const deliveryId = rest[0];
        if (!deliveryId) {
          return usageError("dock webhook retry <delivery-id>");
        }
        const r = await api(`/api/webhook-deliveries/${deliveryId}/retry`, {
          method: "POST",
        });
        out(`\n  ✓ Retry scheduled\n`, r);
        return;
      }
      case "rotate-secret":
      case "rotate": {
        const id = rest[0];
        if (!id) return usageError("dock webhook rotate-secret <webhook-id>");
        if (!JSON_MODE) {
          const ok = await confirm(
            `Rotate secret for ${id}? Old secret stops verifying immediately.`
          );
          if (!ok) {
            out("  Cancelled.\n", { cancelled: true });
            return;
          }
        }
        const r = await api(
          `/api/orgs/${slug}/webhooks/${id}/rotate-secret`,
          { method: "POST" }
        );
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Secret rotated for ${id}\n`);
        out(`  New secret (shown once, store it now):\n  ${r.webhook.secret}\n\n`);
        return;
      }
      default:
        return usageError(
          "dock webhook <list|add|update|pause|resume|rm|deliveries|retry|rotate-secret> [args]"
        );
    }
  },

  // ─── Surfaces (tabs inside a workspace) ────────────────────────

  async surface(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (!sub) {
      return usageError(
        "dock surface <list|new|rename|reorder|rm> <workspace> [args]"
      );
    }
    await ensureAuth();
    switch (sub) {
      case "list": {
        const wsName = rest[0];
        if (!wsName) return usageError("dock surface list <workspace>");
        const { flags } = parseFlags(rest.slice(1));
        const qs = flags.archived ? "?archived=1" : "";
        const { surfaces } = await api(
          `/api/workspaces/${wsName}/surfaces${qs}`
        );
        if (JSON_MODE) return out(surfaces);
        if (!surfaces.length) {
          out("\n  No surfaces.\n");
          return;
        }
        out("\n");
        out(
          "  SLUG".padEnd(28) +
            "KIND".padEnd(8) +
            "POS".padEnd(6) +
            "NAME"
        );
        out("\n  " + "─".repeat(26) + "  " + "─".repeat(6) + "  " + "─".repeat(4) + "  " + "─".repeat(4));
        for (const s of surfaces) {
          out(
            "\n  " +
              String(s.slug).padEnd(26) +
              "  " +
              String(s.kind).padEnd(6) +
              "  " +
              String(s.position).padEnd(4) +
              "  " +
              s.name +
              (s.archivedAt ? "  (archived)" : "")
          );
        }
        out("\n\n");
        return;
      }
      case "new":
      case "create": {
        const wsName = rest[0];
        const name = rest[1];
        if (!wsName || !name) {
          return usageError(
            "dock surface new <workspace> <name> [--doc] [--slug <s>]"
          );
        }
        const { flags } = parseFlags(rest.slice(2));
        const kind = flags.doc ? "doc" : "table";
        const body = { kind, name };
        if (flags.slug) body.slug = String(flags.slug);
        const r = await api(`/api/workspaces/${wsName}/surfaces`, {
          method: "POST",
          body,
        });
        if (JSON_MODE) return out(r);
        out(
          `\n  ✓ Created ${r.surface.kind} surface "${r.surface.name}" → ${r.surface.slug}\n`
        );
        out(`  Open: ${webUrl(wsName)}?surface=${r.surface.slug}\n\n`);
        return;
      }
      case "rename": {
        const wsName = rest[0];
        const surfSlug = rest[1];
        const newName = rest.slice(2).join(" ");
        if (!wsName || !surfSlug || !newName) {
          return usageError(
            "dock surface rename <workspace> <surface-slug> <new-name>"
          );
        }
        const r = await api(
          `/api/workspaces/${wsName}/surfaces/${surfSlug}`,
          { method: "PATCH", body: { name: newName } }
        );
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Renamed to "${r.surface.name}"\n\n`);
        return;
      }
      case "reorder":
      case "move": {
        const wsName = rest[0];
        const surfSlug = rest[1];
        const position = Number(rest[2]);
        if (!wsName || !surfSlug || Number.isNaN(position)) {
          return usageError(
            "dock surface reorder <workspace> <surface-slug> <position>"
          );
        }
        const r = await api(
          `/api/workspaces/${wsName}/surfaces/${surfSlug}`,
          { method: "PATCH", body: { position } }
        );
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Moved "${r.surface.slug}" to position ${r.surface.position}\n\n`);
        return;
      }
      case "rm":
      case "delete":
      case "remove":
      case "archive": {
        const wsName = rest[0];
        const surfSlug = rest[1];
        if (!wsName || !surfSlug) {
          return usageError("dock surface rm <workspace> <surface-slug>");
        }
        if (!JSON_MODE && !confirm(`  Archive surface "${surfSlug}"? (y/N) `)) {
          out("  Aborted.\n");
          return;
        }
        const r = await api(
          `/api/workspaces/${wsName}/surfaces/${surfSlug}`,
          { method: "DELETE" }
        );
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Archived ${surfSlug}\n\n`);
        return;
      }
      default:
        return usageError(
          "dock surface <list|new|rename|reorder|rm> <workspace> [args]"
        );
    }
  },

  // ─── API keys ──────────────────────────────────────────────────

  async keys(_args) {
    await ensureAuth();
    const { keys } = await api("/api/keys");
    if (JSON_MODE) return out(keys);
    if (!keys?.length) {
      out("\n  No keys yet. `dock key new --name <name>` to create one.\n");
      return;
    }
    out("\n");
    for (const k of keys) {
      const status = k.revokedAt ? "revoked" : "active";
      const last = k.lastUsedAt
        ? new Date(k.lastUsedAt).toISOString().slice(0, 10)
        : "never";
      out(`  ${k.id}  ${k.keyPrefix}…  ${status.padEnd(8)} last:${last}  ${k.name || ""}\n`);
    }
    out("\n");
  },

  async key(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const { flags } = parseFlags(rest);
    await ensureAuth();
    switch (sub) {
      case "new":
      case "create": {
        // Default the name when omitted so an agent driving the CLI
        // (Claude Code, etc.) doesn't error out on the marketing
        // snippet `dock key new`. Falls back to `agent-<host>-<ts>` so
        // the key is identifiable in `dock key list` later.
        const name =
          (typeof flags.name === "string" && flags.name) ||
          `agent-${(process.env.HOSTNAME || hostname() || "key").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}-${Date.now().toString(36)}`;
        const body = { name };
        if (flags.workspace) body.workspaceId = flags.workspace;
        if (flags.scopes) body.scopes = String(flags.scopes).split(",");
        const r = await api("/api/keys", { method: "POST", body });
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Created key ${r.key.id}\n`);
        out(`  Token (shown once, store it now):\n  ${r.key.token}\n\n`);
        return;
      }
      case "revoke":
      case "rm":
      case "delete": {
        const id = rest[0];
        if (!id) return usageError("dock key revoke <key-id>");
        await api(`/api/keys/${id}`, { method: "DELETE" });
        out(`\n  ✓ Revoked ${id}\n`, { revoked: id });
        return;
      }
      case "rotate": {
        const id = rest[0];
        if (!id) return usageError("dock key rotate <key-id>");
        if (!JSON_MODE) {
          const ok = await confirm(
            `Rotate ${id}? Old key stops working immediately.`
          );
          if (!ok) {
            out("  Cancelled.\n", { cancelled: true });
            return;
          }
        }
        const r = await api(`/api/keys/${id}/rotate`, { method: "POST" });
        if (JSON_MODE) return out(r);
        out(`\n  ✓ Rotated ${id} → ${r.id}\n`);
        out(`  New token (shown once, store it now):\n  ${r.key}\n\n`);
        return;
      }
      default:
        return usageError("dock key <new|rotate|revoke> [args]");
    }
  },

  // ─── MCP install — writes an `@trydock/mcp` config block to the
  //  right path for the named agent client + inlines a fresh API key.
  //  Closes the loop on the agent-onboarding flow so a Claude Code /
  //  Cursor / Claude Desktop session goes from `npx -y @trydock/cli
  //  mcp install <client>` straight to a working tool surface.
  //  Supported clients map to the file paths already documented in
  //  the @trydock/mcp README.
  async mcp(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const { flags } = parseFlags(rest);
    if (sub !== "install" && sub !== "setup") {
      return usageError("dock mcp install <client> [--name <key-name>] [--key <existing-token>]");
    }
    const client = rest[0];
    if (!client || client.startsWith("--")) {
      return usageError(
        `dock mcp install <client> — supported: ${Object.keys(MCP_CLIENTS).join(", ")}`
      );
    }
    const cfg = MCP_CLIENTS[client];
    if (!cfg) {
      return usageError(
        `Unknown client "${client}". Supported: ${Object.keys(MCP_CLIENTS).join(", ")}`
      );
    }
    await ensureAuth();

    // Either accept an already-minted key (`--key dk_...`) or mint a
    // fresh one named for this client.
    let token = typeof flags.key === "string" ? flags.key : null;
    if (!token) {
      const name =
        (typeof flags.name === "string" && flags.name) || `${client}-${Date.now().toString(36)}`;
      const r = await api("/api/keys", { method: "POST", body: { name } });
      token = r.key.token;
      if (!JSON_MODE) out(`\n  ✓ Minted key "${name}" → ${r.key.id}\n`);
    }

    // Compute the absolute config path for this client. `~` is
    // expanded against the current user's homedir.
    const path = cfg.path.startsWith("~")
      ? join(homedir(), cfg.path.slice(2))
      : cfg.path;

    // Read existing config (if any) and merge our entry. If the file
    // doesn't exist yet, start with an empty object. If it exists but
    // is unparseable, refuse to clobber — print the snippet and ask
    // the user to add it manually.
    let existing = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        if (JSON_MODE) {
          return out({
            error: "config_unparseable",
            path,
            snippet: cfg.snippet(token),
          });
        }
        out(
          `\n  ! Couldn't parse existing config at ${path} (${e.message}).\n` +
            `  Skipping write to avoid clobbering. Add this block manually:\n\n` +
            JSON.stringify(cfg.snippet(token), null, 2) +
            "\n\n"
        );
        return;
      }
    }

    // Merge under the client's mcpServers (or context_servers, etc)
    // root key. If a `dock` entry already exists, replace it — that's
    // the rotate-key flow.
    const merged = cfg.merge(existing, token);

    // Ensure parent dir exists. Some configs live at deep paths
    // (~/.config/zed/) that the user may not have created yet.
    const dir = path.replace(/\/[^/]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");

    if (JSON_MODE) {
      return out({ ok: true, client, path, configured: true });
    }
    out(
      `\n  ✓ Wrote MCP config for ${client} → ${path}\n` +
        `  Restart your agent. Dock's tools (8) will appear in the next session.\n\n`
    );
  },

  // ─── Profile / Org ────────────────────────────────────────────

  async profile(args) {
    await ensureAuth();
    const sub = args[0];
    if (sub === "set") {
      const { flags } = parseFlags(args.slice(1));
      if (!flags.name) return usageError("dock profile set --name <name>");
      const r = await api("/api/me", { method: "PUT", body: { name: flags.name } });
      out(`\n  ✓ Profile updated\n`, r);
      return;
    }
    if (sub === "avatar") {
      // Upload an image file as the user avatar. The REST endpoint
      // expects multipart form-data; the api() helper here is JSON-only
      // so we build a fetch by hand.
      const file = args[1];
      if (!file) return usageError("dock profile avatar <path-to-image>");
      const buf = readFileSync(file);
      const ext = (file.split(".").pop() || "png").toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
      const cfg = readConfig();
      const form = new FormData();
      form.set("file", new Blob([buf], { type: mime }), file.split("/").pop());
      const res = await fetch(`${API_BASE}/api/me/avatar`, {
        method: "POST",
        headers: cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {},
        body: form,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      out(`\n  ✓ Avatar updated\n`, data);
      return;
    }
    const me = await api("/api/me");
    if (JSON_MODE) return out(me);
    out("\n");
    if (me.type === "user") {
      out(`  ${me.name || me.email}\n`);
      out(`  ${me.email}\n`);
    } else {
      out(`  ${me.name} · agent\n`);
    }
    out(`  org: ${me.org.name} (${me.org.slug})\n\n`);
  },

  async org(args) {
    await ensureAuth();
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === "set") {
      const { flags } = parseFlags(rest);
      const body = {};
      if (flags.name) body.name = flags.name;
      if (flags.visibility) body.defaultWorkspaceVisibility = flags.visibility;
      if (Object.keys(body).length === 0) {
        return usageError("dock org set --name <name> [--visibility <private|org>]");
      }
      const r = await api("/api/me/org", { method: "PATCH", body });
      out(`\n  ✓ Org updated\n`, r);
      return;
    }
    if (sub === "switch") {
      const target = rest[0];
      if (!target) return usageError("dock org switch <org-slug-or-id>");
      // Endpoint accepts orgId; if the caller passed a slug, look up
      // its id from /api/me first.
      let orgId = target;
      if (!/^[a-z0-9]{20,}$/i.test(target)) {
        const me = await api("/api/me");
        const orgs = me.orgs || (me.org ? [me.org] : []);
        const found = orgs.find((o) => o.slug === target);
        if (!found) {
          return usageError(`Org "${target}" not found in your account`);
        }
        orgId = found.id;
      }
      const r = await api("/api/me/active-org", {
        method: "PATCH",
        body: { orgId },
      });
      out(`\n  ✓ Active org set\n`, r);
      // Bust the lazy cache so subsequent commands resolve to the
      // newly-active org.
      _meCache = null;
      return;
    }
    if (sub === "view-mode") {
      const mode = rest[0];
      if (mode !== "single" && mode !== "all") {
        return usageError("dock org view-mode <single|all>");
      }
      const r = await api("/api/me/view-mode", {
        method: "PATCH",
        body: { mode },
      });
      out(`\n  ✓ View mode set to ${mode}\n`, r);
      return;
    }
    if (sub === "logo") {
      const slug = await getOrgSlug();
      const file = rest[0];
      if (!file) return usageError("dock org logo <path-to-image>");
      const buf = readFileSync(file);
      const ext = (file.split(".").pop() || "png").toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
      const cfg = readConfig();
      const form = new FormData();
      form.set("file", new Blob([buf], { type: mime }), file.split("/").pop());
      const res = await fetch(`${API_BASE}/api/orgs/${slug}/logo`, {
        method: "POST",
        headers: cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {},
        body: form,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      out(`\n  ✓ Logo updated\n`, data);
      return;
    }
    if (sub === "branding") {
      const slug = await getOrgSlug();
      const { flags } = parseFlags(rest);
      const body = {};
      if (flags["primary-color"]) body.primaryColor = String(flags["primary-color"]);
      if (flags["accent-color"]) body.accentColor = String(flags["accent-color"]);
      if (flags["logo-url"]) body.logoUrl = String(flags["logo-url"]);
      if (Object.keys(body).length === 0) {
        return usageError(
          "dock org branding [--primary-color #hex] [--accent-color #hex] [--logo-url url]"
        );
      }
      const r = await api(`/api/orgs/${slug}/branding`, {
        method: "PATCH",
        body,
      });
      out(`\n  ✓ Branding updated\n`, r);
      return;
    }
    if (sub === "slug-check" || sub === "check-slug") {
      const candidate = rest[0];
      if (!candidate) return usageError("dock org slug-check <candidate>");
      const r = await api(
        `/api/orgs/slug-availability?slug=${encodeURIComponent(candidate)}`
      );
      if (JSON_MODE) return out(r);
      out(r.available ? `\n  ✓ "${candidate}" is available\n\n` : `\n  ✗ "${candidate}" is taken\n\n`);
      return;
    }
    const { org } = await api("/api/me/org");
    if (JSON_MODE) return out(org);
    out(`\n  ${org.name}  (${org.slug})\n  default visibility: ${org.defaultWorkspaceVisibility}\n\n`);
  },

  // ─── Billing ──────────────────────────────────────────────────

  async billing(args) {
    await ensureAuth();
    const sub = args[0];
    const rest = args.slice(1);
    const { flags } = parseFlags(rest);
    if (sub === "upgrade") {
      const plan = rest.find((a) => !a.startsWith("--")) || "pro";
      const interval = flags.annual ? "year" : "month";
      const r = await api("/api/billing/checkout", {
        method: "POST",
        body: { plan, interval },
      });
      out(`\n  Continue checkout in your browser:\n  ${r.url}\n\n`, r);
      openBrowser(r.url);
      return;
    }
    if (sub === "downgrade") {
      await api("/api/billing/downgrade", { method: "POST" });
      out("\n  ✓ Downgrade scheduled. Falls back to Free at the next renewal.\n", { ok: true });
      return;
    }
    if (sub === "portal") {
      const r = await api("/api/billing/portal", { method: "POST" });
      out(`\n  Stripe portal:\n  ${r.url}\n\n`, r);
      openBrowser(r.url);
      return;
    }
    if (sub === "limit-increase" || sub === "increase") {
      // Ask for a cap past Scale without filing a support ticket.
      // kind: agents / workspaces / rows / other.
      const kind = flags.kind || rest[0];
      if (!kind) {
        return usageError(
          'dock billing limit-increase --kind <agents|workspaces|rows|other> [--desired N] [--reason "..."]'
        );
      }
      const body = { kind };
      if (flags.desired) body.desiredValue = Number(flags.desired);
      if (flags.reason) body.reason = String(flags.reason);
      const r = await api("/api/billing/request-limit-increase", {
        method: "POST",
        body,
      });
      out(`\n  ✓ Limit increase requested. We'll be in touch.\n`, r);
      return;
    }
    const b = await api("/api/billing");
    if (JSON_MODE) return out(b);
    out(`\n  Plan: ${b.plan}`);
    if (b.interval) out(`  (${b.interval})`);
    out(`\n`);
    if (b.usage) {
      out(`  Agents: ${b.usage.agents}/${b.caps?.agents}\n`);
      out(`  Members: ${b.usage.members}/${b.caps?.members}\n`);
      out(`  Workspaces: ${b.usage.workspaces}/${b.caps?.workspaces}\n`);
    }
    out("\n");
  },

  // ─── Misc ─────────────────────────────────────────────────────

  async export(args) {
    await ensureAuth();
    const { flags } = parseFlags(args);
    const data = await api("/api/me/export");
    const json = JSON.stringify(data, null, 2);
    if (flags.out) {
      writeFileSync(String(flags.out), json);
      out(`\n  ✓ Wrote ${flags.out}\n`, { path: flags.out });
    } else {
      process.stdout.write(json + "\n");
    }
  },

  async sessions(args) {
    await ensureAuth();
    const sub = args[0];
    if (sub === "logout-all" || sub === "signout-all") {
      await api("/api/me/sessions", { method: "DELETE" });
      out("\n  ✓ Signed out of every session.\n", { ok: true });
      return;
    }
    return usageError("dock sessions logout-all");
  },

  async support(args) {
    await ensureAuth();
    const sub = args[0];
    const rest = args.slice(1);

    if (!sub || sub === "list") {
      const r = await api("/api/support");
      const tickets = r.tickets || r;
      if (JSON_MODE) return out(tickets);
      if (!tickets?.length) {
        out("\n  No tickets yet.\n");
        return;
      }
      for (const t of tickets) {
        const github = t.githubUrl ? ` · ${t.githubUrl}` : "";
        out(`  [${t.kind}] ${t.title}  (${t.status})${github}\n`);
      }
      return;
    }

    if (sub === "new" || sub === "file" || sub === "create") {
      const { flags, positional } = parseFlags(rest);
      const kind = flags.kind || positional[0];
      const title = flags.title || positional[1];
      const body = flags.body || positional[2];
      if (!kind || !title || !body) {
        return usageError(
          'dock support new --kind <bug|feature|billing|question|other> --title "..." --body "..."'
        );
      }
      const context = flags.context ? safeJson(flags.context) : undefined;
      const r = await api("/api/support", {
        method: "POST",
        body: { kind, title, body, context },
      });
      if (JSON_MODE) return out(r);
      out(`\n  ✓ Ticket filed${r.githubUrl ? ` → ${r.githubUrl}` : ""}\n`);
      return;
    }

    if (sub === "show" || sub === "get") {
      const id = rest[0];
      if (!id) return usageError("dock support show <ticket-id>");
      const r = await api(`/api/support/${id}`);
      return out(r);
    }

    if (sub === "upload") {
      const file = rest[0];
      if (!file) return usageError("dock support upload <path-to-file>");
      const buf = readFileSync(file);
      // The endpoint accepts any content type the user might attach to
      // a ticket — guess from extension, default to octet-stream.
      const ext = (file.split(".").pop() || "").toLowerCase();
      const mimeMap = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        txt: "text/plain",
        log: "text/plain",
        json: "application/json",
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      const cfg = readConfig();
      const form = new FormData();
      form.set("file", new Blob([buf], { type: mime }), file.split("/").pop());
      const res = await fetch(`${API_BASE}/api/support/upload`, {
        method: "POST",
        headers: cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {},
        body: form,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      if (JSON_MODE) return out(data);
      out(`\n  ✓ Uploaded\n  ${data.url || data.attachmentUrl || ""}\n\n`);
      return;
    }

    return usageError(
      "dock support [list|new|show|upload]  (see 'dock help' for details)"
    );
  },

  // Full-text search across workspaces / rows / doc-sections.
  //   dock search "query"
  //   dock search "query" --kind workspace  # or row | doc-section
  //   dock search "query" --limit 20 --offset 0
  async search(args) {
    await ensureAuth();
    const { positional, flags } = parseFlags(args);
    const q = positional.join(" ").trim();
    if (!q) return usageError('dock search "query" [--kind workspace|row|doc-section] [--limit N]');
    const params = new URLSearchParams({ q });
    if (flags.kind) params.set("kind", String(flags.kind));
    if (flags.limit) params.set("limit", String(flags.limit));
    if (flags.offset) params.set("offset", String(flags.offset));
    const r = await api(`/api/search?${params}`);
    if (JSON_MODE) return out(r);
    if (!r.results?.length) {
      out("\n  No matches.\n");
      return;
    }
    out("\n");
    for (const hit of r.results) {
      const tag = String(hit.kind || "?").padEnd(12);
      const title = hit.title || hit.snippet || hit.id;
      out(`  ${tag} ${title}\n`);
      if (hit.workspaceSlug) out(`               ${webUrl(hit.workspaceSlug)}\n`);
    }
    out("\n");
  },

  async referrals(args) {
    await ensureAuth();
    const sub = args[0];

    if (!sub || sub === "me" || sub === "status") {
      const r = await api("/api/referrals/me");
      if (JSON_MODE) return out(r);
      const link = r.code ? `${API_BASE}/invite/${r.code}` : "(none yet)";
      out(`\n  Your referral link: ${link}\n`);
      out(`  Signed up: ${r.signedUp || 0}\n`);
      out(`  Activated: ${r.activated || 0}\n`);
      out(`  Months earned: ${r.scaleMonthsEarned || 0} / ${r.rewardsCap || 3}\n`);
      if (r.scaleUntil) {
        const days = Math.max(
          0,
          Math.ceil((new Date(r.scaleUntil) - Date.now()) / (24 * 60 * 60 * 1000))
        );
        out(`  Scale active for ~${days} more days\n`);
      }
      return;
    }

    if (sub === "link" || sub === "share") {
      const r = await api("/api/referrals/me");
      if (!r.code) {
        out("\n  Generating your referral code...\n");
      }
      const link = `${API_BASE}/invite/${r.code}`;
      if (JSON_MODE) return out({ link, code: r.code });
      out(`\n  ${link}\n`);
      return;
    }

    return usageError(
      "dock referrals [me|link]  (see 'dock help' for details)"
    );
  },

  async help() {
    console.log(`
  dock — open shared workspaces with your agents in seconds

  Auth
    dock init [name] [--email <e>] [--ref <code|url>]
                                           Sign in + create first workspace.
                                           --email pre-supplies the email so
                                           the OAuth browser skips the form;
                                           customer just clicks the link in
                                           their inbox. Agent-friendly.
    dock login [--email <e>] [--ref <code|url>]
                                           Sign in via browser
    dock logout                            Clear local credentials
    dock whoami                            Show signed-in identity
    dock sessions logout-all               Sign out of every session

    --ref carries a friend's referral code (or full
      https://trydock.ai/invite/<code> URL) into the OAuth handoff so
      a brand-new email can sign up against the invite-only beta gate.

  Workspaces
    dock list                              List your workspaces
    dock new <name> [--doc]                Create a new workspace
    dock open <name>                       Open in browser
    dock rename <name> <new-name>          Rename a workspace
    dock visibility <name> <p|o|u|p>       private|org|unlisted|public
    dock pin <name>                        Pin to your sidebar
    dock unpin <name>                      Unpin from your sidebar
    dock archive <name>                    Soft-archive (alias: delete)
    dock unarchive <name>                  Restore an archived workspace
    dock share <name> <email> [role]       Invite a collaborator (workspace-scoped)
    dock members <name>                    List members + pending invites
    dock member role <ws> <member-id> <role>
    dock member remove <ws> <member-id>

  Surfaces (tabs inside a workspace)
    dock surface list <name> [--archived]
    dock surface new <name> <surface-name> [--doc] [--slug <s>]
    dock surface rename <name> <surface-slug> <new-name>
    dock surface reorder <name> <surface-slug> <position>
    dock surface rm <name> <surface-slug>

  Rows
    dock rows <name>                       List rows
    dock add <name> key=value ...          Append a row
    dock get <name> <row-id>               Print row data
    dock set <name> <row-id> key=val ...   Update fields
    dock bulk update <name> [--file p|--stdin]   Batch update (PATCH /rows/bulk)
    dock remove <name> <row-id>            Delete a row
    dock history <name> <row-id>           Recent change events
    dock comment list <name> <row-id>      List comments on a row
    dock comment add <name> <row-id> <body>

  Columns
    dock columns <name>                    List columns
    dock column add <name> <key> <type> [--label "..."] [--options "a,b,c"]
    dock column rename <name> <key> <new-label>
    dock column rm <name> <key>            Drop a column (cell data lost)

  Docs (rich-text body — every workspace has one)
    dock doc <name> [--markdown|--text]    Print the doc body
    dock doc set <name> [--file p|--stdin] Replace the body (ProseMirror JSON)

  Teams (org membership)
    dock team list                         List org members + pending invites
    dock team invite [--email e] [--role member|admin] [--max-uses N] [--expires-in-days N]
    dock team role <user-id> <member|admin>
    dock team remove <user-id>
    dock team resend <invite-id>
    dock team revoke <invite-id>
    dock accept <invite-token>             Accept a team invite

  Agents (signed agents in your org)
    dock agents                            List agents with usage
    dock agent show <id>
    dock agent rename <id> <new-name>
    dock agent archive <id>                Revokes keys + OAuth tokens
    dock agent invite <id> [--workspace <ws-id>] [--expires-in-minutes N]
    dock agent invites <id>                List outstanding invites
    dock agent revoke <id> <invite-id>

  Webhooks (one endpoint per org)
    dock webhook list
    dock webhook add --url <url> [--events "row.created,row.updated"]
    dock webhook update <id> [--url u] [--events "..."]
    dock webhook pause <id>
    dock webhook resume <id>
    dock webhook rm <id>
    dock webhook deliveries <id>           Recent delivery attempts
    dock webhook retry <delivery-id>       Manually retry one delivery
    dock webhook rotate-secret <id>        Mint a fresh signing secret

  API keys
    dock keys                              List keys
    dock key new [--name <n>] [--workspace <slug>]
    dock key rotate <id>                   Atomic mint-new + revoke-old
    dock key revoke <id>

  MCP install (one-shot agent setup)
    dock mcp install <client>              Mints a key + writes the right MCP
                                           config for that client. Supported:
                                           claude-code, claude-desktop, cursor,
                                           windsurf, zed, cline, continue.
                                           Use --key <existing> to skip the mint.

  Profile
    dock profile                           Show profile
    dock profile set --name <name>
    dock profile avatar <path-to-image>    Upload a new avatar

  Org
    dock org                               Show active org settings
    dock org set --name <name> [--visibility private|org]
    dock org switch <slug-or-id>           Switch your active org
    dock org view-mode <single|all>        Sidebar: one org or all orgs
    dock org logo <path-to-image>          Upload an org logo
    dock org branding [--primary-color #hex] [--accent-color #hex] [--logo-url u]
    dock org slug-check <candidate>        Is this org slug taken?

  Billing
    dock billing                           Show plan + usage
    dock billing upgrade <pro|scale> [--annual]
    dock billing downgrade
    dock billing portal                    Open Stripe portal
    dock billing limit-increase --kind <agents|workspaces|rows|other> [--desired N] [--reason "..."]

  Support
    dock support                           List your tickets
    dock support new --kind <bug|feature|billing|question|other> --title "..." --body "..."
    dock support show <ticket-id>
    dock support upload <path-to-file>     Attach a screenshot or log

  Search
    dock search "query" [--kind workspace|row|doc-section] [--limit N]

  Referrals
    dock referrals                         Your code, progress, months earned
    dock referrals link                    Print your shareable invite URL

  Data
    dock export [--out FILE]               Full GDPR JSON export

  Common
    dock help                              Show this help
    --json                                 Machine-readable output (every command)

  Environment
    DOCK_API_URL                           API base URL (default: https://trydock.ai)

  Docs: https://trydock.ai/docs
`);
  },
};

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

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

// Pull --json off anywhere in argv before dispatching, so commands can
// opt into a machine-readable output without each one having to parse
// it themselves.
const rawArgs = process.argv.slice(2);
const filtered = rawArgs.filter((a) => {
  if (a === "--json") {
    JSON_MODE = true;
    return false;
  }
  return true;
});

const [command, ...args] = filtered;

if (!command || command === "help" || command === "--help" || command === "-h") {
  commands.help();
} else if (commands[command]) {
  commands[command](args).catch((err) => {
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({ error: err.message, status: err.status, data: err.data }, null, 2) + "\n");
    } else {
      console.error(`\n  Error: ${err.message}\n`);
    }
    process.exit(1);
  });
} else {
  console.error(`\n  Unknown command: ${command}\n  Run 'dock help' for usage.\n`);
  process.exit(1);
}
