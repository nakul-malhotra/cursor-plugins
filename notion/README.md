# Notion

A personal Copilot plugin for scoped Notion work across repositories.

| Skill | Job |
|---|---|
| `/notion:gardening` | Review organization and content, with evidence and explicit coverage limits |
| `/notion:todos` | Maintain dated plans, backlogs, completion, and shipped-work logs |
| `/notion:edit` | Make precise page, block, database, data-source, and comment changes |

Each skill accepts natural-language requests. All writes use the same
plan/apply engine; private workspace profiles supply integration identities,
allowed roots, and task conventions.

## Install locally

Node 22.18 or newer is required.

```sh
npm ci
npm run package:local
copilot plugin install ~/.copilot/notion/plugin
```

Set up private profiles and credentials using
[workspace setup](references/workspace-profiles.md), then run:

```sh
node ~/.copilot/notion/plugin/scripts/notion.mjs doctor --all
```

Only allowlisted runtime assets enter the installed package. Credentials,
profiles, and operation records stay outside it in `~/.copilot/notion`.
Local-path Copilot installs are cached: repeat assembly and installation
after changes. The CLI currently warns that direct installs are deprecated;
a future CLI release may require a local marketplace source.
Run `/restart` in Copilot after installation to load the new skills.

## Shared workflow and repository integrations

Use `/notion:gardening`, `/notion:todos`, and `/notion:edit` through the shared
`scripts/notion.mjs` CLI. The package contains these three skills and their
runtime, references, architecture notes, and example profile.

Gantry publishing and KB mirroring keep their existing implementation and
credential sources. User-owned commands such as `startup-sync` remain local:
route their Notion access through `/notion:todos` and retain their Task Master
and Gantry-gap sources.

See [operations](references/operations.md), [todos](references/todos.md),
[recovery](references/safety-and-recovery.md), and the
[architecture decision](docs/adr/0001-scoped-journaled-notion.md).

## Development

`npm test`, `npm run test:integration`, and `npm run test:e2e` use synthetic
Notion boundaries. `npm run lint` and `npm run typecheck` check source contracts.
The opt-in `scripts/live-smoke.mjs` requires
`--workspace NAME --confirm-isolated-writes`; it exercises the assembled runtime
on a uniquely named temporary page and archives that page afterward.
Pass `--database` to include the database-backed task journey. The script records
request metadata privately and confines writes to resources created by that run,
apart from creating its marked scratch page under the selected root. Live tests
are not part of the default suites.

### Request efficiency

Run `npm run benchmark:requests --silent` for a JSON request-count report using
synthetic page moves and icon updates. It covers 100-item API pages and a
two-item pagination stress case, with assertions for page identity, parentage,
icons, and preserved block contents. Synthetic execution time and the theoretical
350ms/request spacing bound are reported separately from live latency.

Measured on 2026-09-06 against baseline `4dcdfe7`, with 100-item API pages:

| Operation | Before: plan + apply requests | After: plan + apply requests |
|---|---|---|
| Move one page with 50 leaf blocks | 221 + 387 = 608 | 21 + 27 = 48 |
| Move one page with five groups of ten leaves | 381 + 637 = 1,018 | 81 + 97 = 178 |
| Move three pages with 175 leaves and update their icons | 737 + 6,309 = 7,046 | 37 + 316 = 353 |

Fresh child listings already contain complete leaf blocks. The engine uses those
blocks after validating their membership and protected-resource boundaries,
instead of fetching every leaf and its ancestors again. Listings are fetched
again for each observation pass; no cache survives between planning, mutations,
or readback. The first mutation also uses one pre-write observation pass rather
than two consecutive passes.

The mixed-operation regression test caps this fixed scenario at 400 requests.
Stale content, corrupted moves, and invalid child membership still stop the
operation. For routine usage, keep document moves separate from lightweight
edits and keep inspections scoped to the requested pages.
