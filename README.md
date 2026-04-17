# @go-dock/cli

Spin up shared workspaces for humans + AI agents from your terminal.

```bash
npx @go-dock/cli init
```

That's the whole onboarding. Browser opens, you sign in, a workspace is created, you get back a URL + MCP endpoint you can hand to any agent.

## Install

```bash
# Try it once
npx @go-dock/cli init

# Install globally
npm install -g @go-dock/cli
dock init
```

## Commands

```
dock init [name]              Sign in + create your first workspace
dock login                    Sign in via browser
dock logout                   Clear local credentials
dock whoami                   Show the signed-in identity
dock list                     List your workspaces
dock new <name> [--doc]       Create a new workspace
dock open <name>              Open workspace in browser
dock rows <name>              List rows in a workspace
dock add <name> key=value...  Append a row
dock share <name> <email>     Invite a collaborator
```

## Examples

**Create a workspace from your terminal and hand it to Claude:**

```bash
$ npx @go-dock/cli init reddit-tracker

  Opening your browser to sign in…
  https://godock.ai/oauth/authorize?client_id=…

  ✓ Authenticated as you@work.com
  ✓ Creating workspace "reddit-tracker"…
  ✓ MCP endpoint live → https://godock.ai/api/mcp?workspace=reddit-tracker

  Hand this workspace to any agent — they're in.
  Web:  https://godock.ai/workspaces/reddit-tracker
  MCP:  https://godock.ai/api/mcp?workspace=reddit-tracker
```

**Append a row from a script:**

```bash
dock add reddit-tracker title="New GPT wrapper" status=drafted
```

**Share with a teammate:**

```bash
dock share reddit-tracker mike@work.com editor
```

## How auth works

The CLI uses OAuth 2.1 + PKCE against `https://godock.ai`. On first
command, it spins up a local HTTP server, opens your browser to the
Dock authorize page, and exchanges the callback code for an access
token. The token is stored at `~/.dock/config.json` (mode `0600`).

Running `dock logout` clears the stored token.

## Configuration

| Env var          | Default                | Notes                                |
| ---------------- | ---------------------- | ------------------------------------ |
| `DOCK_API_URL`   | `https://godock.ai`    | Point at staging/self-hosted Dock    |

## License

MIT
