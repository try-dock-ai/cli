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
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

// ─── Config ────────────────────────────────────────────────────────

const DEFAULT_API = "https://trydock.ai";
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
async function oauthFlow({ ref } = {}) {
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

async function ensureAuth({ ref } = {}) {
  const cfg = readConfig();
  if (cfg.accessToken) return cfg;
  const tok = await oauthFlow({ ref });
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
    const cfg = await ensureAuth({ ref });
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
    const tok = await oauthFlow({ ref });
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
      out(`    ${m.role.padEnd(10)} ${name}\n`);
    }
    if (invites?.length) {
      out("\n  Pending invites\n");
      for (const i of invites) out(`    ${i.role.padEnd(10)} ${i.email}\n`);
    }
    out("\n");
  },

  // ─── Doc body ──────────────────────────────────────────────────

  async doc(args) {
    await ensureAuth();
    const [slug] = args;
    if (!slug) return usageError("dock doc <workspace>");
    const r = await api(`/api/workspaces/${slug}/doc`);
    if (JSON_MODE) return out(r);
    out(JSON.stringify(r.content, null, 2) + "\n");
  },

  // ─── Webhooks (org-scoped) ─────────────────────────────────────

  async webhook(args) {
    const sub = args[0];
    const rest = args.slice(1);
    // Validate arg shape before hitting the network so a missing flag
    // doesn't surface as "fetch failed".
    if (!sub) {
      return usageError(
        "dock webhook <list|add|pause|resume|rm|deliveries> [args]"
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
      default:
        return usageError(
          "dock webhook <list|add|pause|resume|rm|deliveries> [args]"
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
        if (!flags.name) {
          return usageError(
            "dock key new --name <name> [--workspace <slug>] [--scopes ...]"
          );
        }
        const body = { name: flags.name };
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
      default:
        return usageError("dock key <new|revoke> [args]");
    }
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
    if (sub === "set") {
      const { flags } = parseFlags(args.slice(1));
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

    return usageError(
      "dock support [list|new|show]  (see 'dock help' for details)"
    );
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
    dock init [name] [--ref <code|url>]    Sign in + create first workspace
    dock login [--ref <code|url>]          Sign in via browser
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
    dock delete <name>                     Delete (irreversible)
    dock share <name> <email> [role]       Invite a collaborator
    dock members <name>                    List members + pending invites
    dock columns <name>                    List columns

  Rows
    dock rows <name>                       List rows
    dock add <name> key=value ...          Append a row
    dock get <name> <row-id>               Print row data
    dock set <name> <row-id> key=val ...   Update fields
    dock remove <name> <row-id>            Delete a row
    dock history <name> <row-id>           Recent change events

  Doc-mode workspaces
    dock doc <name>                        Print the rich-text doc body

  Webhooks (one endpoint per org)
    dock webhook list
    dock webhook add --url <url> [--events "row.created,row.updated"]
    dock webhook pause <id>
    dock webhook resume <id>
    dock webhook rm <id>
    dock webhook deliveries <id>           Recent delivery attempts

  API keys
    dock keys                              List keys
    dock key new --name <n> [--workspace <slug>]
    dock key revoke <id>

  Profile / Org
    dock profile                           Show profile
    dock profile set --name <name>
    dock org                               Show org settings
    dock org set --name <name> [--visibility private|org]

  Billing
    dock billing                           Show plan + usage
    dock billing upgrade <pro|scale> [--annual]
    dock billing downgrade
    dock billing portal                    Open Stripe portal

  Support
    dock support                           List your tickets
    dock support new --kind <bug|feature|billing|question|other> --title "..." --body "..."
    dock support show <ticket-id>

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
