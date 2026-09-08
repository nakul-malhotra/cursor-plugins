# Local setup and profiles

The runtime reads `NOTION_HOME`, defaulting to `~/.copilot/notion`. This directory,
its `profiles/` directory, and `.state/` must be owned by the current user with
mode `700`. Registry, profile, and credential files require mode `600`.
Symlinked private files/directories are rejected. Do not print credentials into
a conversation or put them in a repository.

The registry is `.workspaces.json`:

```json
{"version":1,"profiles":["example"]}
```

Each slug identifies `profiles/<slug>.json`. Start with
`assets/workspace.example.json` and replace the example IDs with verified
integration and root IDs. Roots may be pages, blocks, databases, or data sources.
Protected resources are excluded even when a broader root is allowed.
`canonical` maps names such as `todos`, `kb`, or `gtm` to resource references.
Todo mappings are described in `todos.md`.

The private `.credentials.json` structure is:

```json
{
  "version": 1,
  "connections": {
    "example-integration": {"token": "<enter the token locally>"}
  }
}
```

Create files with restrictive permissions from the outset, for example by
setting `umask 077` before using a local editor. Never put tokens in shell
arguments or export them for this helper. Credential references select exactly
one integration; there is no fallback to legacy markdown or another token.

Workspace keys and aliases are exact selectors. Explicit `--workspace` wins;
otherwise registered repository paths resolve the current directory. An absent
or ambiguous association fails. A shared physical Notion workspace does not make
separate startup roots interchangeable: the integration identity and ancestry
must both match.

Run the installed entry point:

```sh
node ~/.copilot/notion/plugin/scripts/notion.mjs workspaces
node ~/.copilot/notion/plugin/scripts/notion.mjs doctor --workspace example
node ~/.copilot/notion/plugin/scripts/notion.mjs profile --workspace example
```

`workspaces` and `profile` do not read the credential file. `doctor` verifies the
selected bot identity and root access. Discover unfamiliar layouts read-only,
then update the private profile. Do not create a new todo page merely because
a mapping is missing.

## Assembly, registration, and refresh

From the source checkout, run:

```sh
npm run package:local
copilot plugin install ~/.copilot/notion/plugin
copilot plugin list
```

Assembly copies only runtime assets into content-addressed releases beneath
`NOTION_HOME/.releases/` and atomically switches `NOTION_HOME/plugin`. Credentials,
profiles, journals, tests, and development dependencies stay outside the package.
Existing unrelated plugin directories are never replaced.

The allowlist includes the three Notion skills, shared CLI, current library
modules, references, architecture notes, and `assets/workspace.example.json`.
User-owned commands and separate repository publishing/mirror integrations stay
outside the plugin; keep their credentials and profiles in place.

Local-path Copilot installations are cached. Repeat both assembly and
`copilot plugin install` after source changes. Confirm `notion` and its three
skills in `/plugin list` and `/skills list` in a refreshed session. Installation
does not restart a running session.

Previous releases remain available for rollback: after stopping concurrent
updates, atomically repoint the owned `plugin` symlink to a reviewed prior
`.releases/<hash>` directory, then reinstall that path. Do not roll code back
by changing private state or credential files. `copilot plugin uninstall notion`
removes the cached plugin, not the private Notion home.

Hidden files are plaintext protected by OS permissions. They are accessible
to other processes running as the same user; this is not encryption or a
sandbox.
