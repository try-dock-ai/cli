# @trydock/cli

[![npm version](https://img.shields.io/npm/v/%40trydock%2Fcli?color=0A84FF&label=npm)](https://www.npmjs.com/package/@trydock/cli)
[![Published with provenance](https://img.shields.io/badge/npm-published%20with%20provenance-06D6A0?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![License: MIT](https://img.shields.io/badge/license-MIT-8499B1)](./LICENSE)

Spin up shared workspaces for humans + AI agents from your terminal.

```bash
npx @trydock/cli init
```

That's the whole onboarding. Browser opens, you sign in, a workspace is created, you get back a URL + MCP endpoint you can hand to any agent.

## Install

```bash
# Try it once
npx @trydock/cli init

# Install globally
npm install -g @trydock/cli
dock init
```

## Commands

### Auth

```
dock init [name] [--ref <code|url>]    Sign in + create first workspace
dock login [--ref <code|url>]          Sign in via browser
dock logout                            Clear local credentials
dock whoami                            Show signed-in identity
dock sessions logout-all               Sign out of every session
```

Dock is invite-only during beta. If a friend sent you a referral link
like `https://trydock.ai/invite/abc123`, you can sign up purely from
the terminal:

```bash
dock init --ref abc123
# or paste the whole URL
dock init --ref https://trydock.ai/invite/abc123
```

The code is forwarded through the OAuth handoff to the invite-only
gate. Without `--ref`, an unknown email is added to the waitlist
instead of getting a magic link.

### Workspaces

```
dock list                              List your workspaces
dock new <name> [--doc]                Create a new workspace
dock open <name>                       Open in browser
dock rename <name> <new-name>          Rename a workspace
dock visibility <name> <p|o|u|p>       private|org|unlisted|public
dock delete <name>                     Delete (irreversible)
dock share <name> <email> [role]       Invite a collaborator
dock members <name>                    List members + pending invites
dock columns <name>                    List columns
```

### Rows

```
dock rows <name>                       List rows
dock add <name> key=value ...          Append a row
dock get <name> <row-id>               Print row data
dock set <name> <row-id> key=val ...   Update fields
dock remove <name> <row-id>            Delete a row
dock history <name> <row-id>           Recent change events
```

### Doc-mode workspaces

```
dock doc <name>                        Print the rich-text doc body
```

### Webhooks (one endpoint per org)

```
dock webhook list
dock webhook add --url <url> [--events "row.created,row.updated"]
dock webhook pause <id>
dock webhook resume <id>
dock webhook rm <id>
dock webhook deliveries <id>           Recent delivery attempts
```

### API keys

```
dock keys                              List keys
dock key new --name <n> [--workspace <slug>]
dock key revoke <id>
```

### Profile / Org

```
dock profile                           Show profile
dock profile set --name <name>
dock org                               Show org settings
dock org set --name <name> [--visibility private|org]
```

### Billing

```
dock billing                           Show plan + usage
dock billing upgrade <pro|scale> [--annual]
dock billing downgrade
dock billing portal                    Open Stripe portal
```

### Data

```
dock export [--out FILE]               Full GDPR JSON export
```

### Common

```
--json                                 Machine-readable output (every command)
dock help                              Show full command list
```

## Examples

**Create a workspace and hand it to Claude:**

```bash
$ npx @trydock/cli init reddit-tracker

  Opening your browser to sign in…
  https://trydock.ai/oauth/authorize?client_id=…

  ✓ Authenticated as you@work.com
  ✓ Creating workspace "reddit-tracker"…
  ✓ MCP endpoint live → https://trydock.ai/api/mcp?workspace=reddit-tracker

  Hand this workspace to any agent — they're in.
  Web:  https://trydock.ai/workspaces/reddit-tracker
  MCP:  https://trydock.ai/api/mcp?workspace=reddit-tracker
```

**Append a row from a script:**

```bash
dock add reddit-tracker title="New GPT wrapper" status=drafted
```

**Wire a webhook from CI:**

```bash
dock webhook add \
  --url https://hooks.your-app.com/dock \
  --events "row.created,row.updated,workspace.renamed"

# → Created hook abc123
#   Secret (shown once, store it now):
#   whsec_…

dock webhook deliveries abc123
```

**Pipe to jq:**

```bash
dock list --json | jq '.workspaces[] | .slug'
dock keys --json  | jq '.keys[] | select(.revokedAt == null) | .id'
```

## How auth works

The CLI uses OAuth 2.1 + PKCE against `https://trydock.ai`. On first
command, it spins up a local HTTP server, opens your browser to the
Dock authorize page, and exchanges the callback code for an access
token. The token is stored at `~/.dock/config.json` (mode `0600`).

Running `dock logout` clears the stored token.

## Configuration

| Env var          | Default                | Notes                                |
| ---------------- | ---------------------- | ------------------------------------ |
| `DOCK_API_URL`   | `https://trydock.ai`   | Point at staging or self-hosted Dock |

## License

MIT
