# rigup

Set up Claude Code with your skills, agents and commands, from any marketplace repo or local
folder, and keep every machine the same.

> Status: early. `add`, `remove`, `sources`, `doctor` and `setup` work; `update`, `changes`,
> `list` and `search` are next (see [Roadmap](#roadmap)).

## Why

Teams collect skills, agents and commands in a repo, and then nobody uses them the same way:
some people never installed half the plugins, auto-update is off by default for third-party
marketplaces, a skill needs a CLI tool or an MCP connector nobody told you about, and nobody
knows what changed last week.

rigup is not another skill installer. It uses Claude Code's own plugin system (marketplaces,
plugins, scopes, auto-update) and adds what it lacks for a team:

* **One config, every machine converges to it**: `rigup setup` is declarative and idempotent.
* **A doctor**: what is missing on this machine, and the exact command that fixes it, including
  the tools, environment variables and MCP connectors each plugin declares it needs.
* **Local folders as first-class sources**: point at a folder of `SKILL.md`s and rigup wraps it
  as a plugin.

## Install

```bash
pnpm add -g rigup
```

Needs Node 22+ and Claude Code 2.1.292+. macOS and Linux.

## Use

```bash
rigup add acme/claude-skills                     # a GitHub repo that is a marketplace
rigup add acme/big-catalog --plugins review,docs # only some plugins of a big catalog
rigup add https://gitlab.com/acme/skills.git     # any git host
rigup add ~/work/my-skills                       # a local folder
rigup setup                                      # apply it (safe to repeat; --dry-run to preview)
rigup doctor                                     # what is missing, and how to fix it
```

## What `rigup setup` does

It plans from the same facts `doctor` reads, applies the plan in order and stops at the first
step that fails (run it again after fixing it; it picks up where it left off):

1. Stops early, with the fix, if Node or `claude` is too old, the config has errors or there are
   no sources.
2. Skips, with a hint, sources it cannot use (a folder that does not exist, a repo it cannot
   reach without a prompt), and sets up the rest. For GitHub, when `gh` is signed in, it runs
   `gh auth setup-git` instead of skipping.
3. Registers each repo or local marketplace that is not registered yet, at user scope.
4. Rebuilds `rigup-local` for local plugin and skills folders (a symlink to each plugin folder, a
   copy of each skills folder) and registers or refreshes it. Your folders are never modified.
5. Turns on `autoUpdate` for the repos in your user `settings.json` (merged; an invalid file is
   never overwritten), plus `FORCE_AUTOUPDATE_PLUGINS=1` when a variable in your shell turns
   plugin updates off.
6. Installs, at user scope, every wanted plugin this machine does not have.
7. Runs `doctor` again and lists what is left.

## Sources

| Source | What rigup does |
|---|---|
| `owner/repo[@ref]`, `github:owner/repo` | Registers it as a Claude Code marketplace |
| Git URL (`https://…`, `git@…`, `ssh://…`), optional `#ref` | Same, any host |
| Local marketplace folder (`.claude-plugin/marketplace.json`) | Registers it as a directory marketplace |
| Local plugin folder (`skills/`, `agents/`, `commands/` or `.claude-plugin/plugin.json`) | Links it into `rigup-local`, a marketplace rigup generates |
| Local folder of skills (`<name>/SKILL.md`) | Wraps it as a plugin in `rigup-local` |

Claude Code only accepts plugin sources inside the marketplace folder, and it installs a *copy*
of each plugin. So a local folder you edit needs `rigup update` (and a new session) before Claude
sees the change; `rigup doctor` tells you when that is the case.

## Config

`~/.config/rigup/config.json` (`XDG_CONFIG_HOME` respected, `RIGUP_CONFIG` overrides):

```json
{
  "sources": [
    { "source": "acme/claude-skills" },
    { "source": "acme/big-catalog", "plugins": ["review", "docs"] },
    { "source": "/home/me/work/my-skills" }
  ]
}
```

`plugins` defaults to `"*"`, every plugin in the source's catalog.

## Declaring what a plugin needs: `requirements.json`

A plugin may ship a `requirements.json` at its root. `rigup doctor` reads it, so a new skill
never needs a change in rigup.

```json
{
  "tools": [
    { "name": "gh", "why": "pull requests", "install": "brew install gh" },
    { "name": "jq", "optional": true, "usedBy": ["report"] }
  ],
  "env": [
    { "name": "TRACKER_TOKEN", "why": "ticket lookups", "where": "your password manager", "optional": true }
  ],
  "connectors": [
    { "name": "Docs", "alternatives": ["Docs MCP"], "why": "search the docs" }
  ]
}
```

| Field | Meaning |
|---|---|
| `tools[]` | Commands that must be on `PATH`. `install` is the fix shown. |
| `env[]` | Environment variables. `where` says how to get the value. |
| `connectors[]` | MCP servers, by the name `claude mcp list` shows. Found under one of `alternatives` is a warning: tool names (`mcp__<name>__*`) will not match what the skills call. |
| `optional` | `true`: only some skills need it; missing is shown as information, never as an error. |
| `usedBy` | The skills, agents or commands that need an optional item. |

## Roadmap

* `rigup update`: rigup itself, every source and every plugin, then what changed.
* `rigup changes`: new, updated, renamed and removed skills, agents and commands in a window.
* `rigup list` / `rigup search`: what exists across your sources, and how to use it.

## Development

```bash
node rigup.mjs doctor
npm test
```

Plain ESM, no dependencies, no build step. `src/facts.mjs` is the only module that reads the
machine, always through an injected context (`src/context.mjs`); checks are pure functions
tested against a fake machine (`test/helpers.mjs`). Try it without touching your real setup:

```bash
CLAUDE_CONFIG_DIR=/tmp/cc RIGUP_CONFIG=/tmp/rigup.json node rigup.mjs doctor
```

## License

GPL-3.0
