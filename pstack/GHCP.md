# pstack on GitHub Copilot CLI

This fork runs upstream [pstack](https://github.com/cursor/plugins/tree/main/pstack) under GitHub Copilot CLI. Every change is **additive** — no upstream file is edited, so `git merge upstream/main` stays clean and nothing here blocks contributing back.

## What was added and why

| Addition | Fixes |
|---|---|
| `.claude-plugin/plugin.json` | Copilot reads this manifest; upstream ships `.cursor-plugin/plugin.json` only. Both now coexist. |
| `skills/create-skill/` | 17 references to Cursor's built-in `create-skill`, which Copilot lacks. |
| `skills/deslop/` | 6 references to `/deslop` from the `cursor-team-kit` plugin. |
| `skills/control-ui/`, `skills/control-cli/` | 14 references to `cursor-team-kit`'s control skills, which pstack requires for live verification. |
| `ghcp/pstack-models.example.mdc` | Upstream's default model slugs do not exist on Copilot. |

The shim skills carry the names the upstream references already use, so those references resolve by themselves. That is why no upstream file needed touching.

## Install

```bash
git clone https://github.com/nakul-malhotra/plugins.git ~/Documents/GitHub/cursor-plugins
cd ~/Documents/GitHub/cursor-plugins
git remote add upstream https://github.com/cursor/plugins.git
git checkout ghcp
ln -s "$PWD/pstack" ~/.copilot/local-plugins/pstack
```

Copilot's plugin root is the nested `pstack/` directory, reached by symlink.

## Model configuration

Upstream `/setup-pstack` writes `~/.cursor/rules/pstack-models.mdc`. Copilot never auto-applies `.mdc` rules, but this does not matter: every pstack skill reads the file *explicitly* ("use the `interrogate reviewers` list from `~/.cursor/rules/pstack-models.mdc` when present"). Reading a file works everywhere, so the path is kept unchanged.

What does not survive the port is the slugs. Upstream defaults name `claude-fable-5-thinking-max`, `grok-4.6-fast-xhigh`, and `gpt-5.6-sol-max` — none exist on Copilot, which also splits model from reasoning effort into two separate fields.

Install the Copilot-native config:

```bash
mkdir -p ~/.cursor/rules
cp pstack/ghcp/pstack-models.example.mdc ~/.cursor/rules/pstack-models.mdc
```

Effort lives in a separate table at the bottom of that file, never appended to a slug, so a skill that reads a role line gets a value valid as-is for the `model` field.

Running upstream `/setup-pstack` is safe: its step 4 validates every slug against the models it actually detects, so it self-corrects rather than writing the Cursor defaults. Its step 5 example block still shows Cursor slugs — ignore that block.

## Known differences

- **`/poteto-mode` is not sticky.** Upstream sets `mode: true` in frontmatter for cross-turn persistence. Copilot has no equivalent, so re-invoke it per task.
- **`AskQuestion` maps to `ask_user`.** Same idea, different tool name.
- **Graphite (`gt`) playbooks** — `shipping`, `autopilot-full`, `autopilot-stack`, `babysit`, `orchestrate` — assume Graphite stacks and Cursor cloud agents. On Copilot, prefer GitHub's native stacked PRs (`gh stack`).
- **`automations/benny/`** targets Cursor's automation runner and has no Copilot equivalent. Left in place, unused.

## Overlap with software-factory

`/poteto-mode` and `/software-factory:build` are the same skill in different vocabulary — both route a feature end to end through planning, adversarial verification, and a PR. Running both as routers means two of them arguing over one task.

The recommended split: keep `/software-factory:build` as the build entry point, and use pstack for what it uniquely adds — `/why`, `/how`, `/teach`, `/blast-radius`, `/interrogate`, the 21 `principle-*` leaf skills, and the `create-verification-skill` / `maintain-verification-skill` pair.

## Syncing upstream

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should be rare, since this branch only adds files. If upstream ever ships its own `create-skill`, `deslop`, `control-ui`, or `control-cli`, delete the shim here and take theirs.
