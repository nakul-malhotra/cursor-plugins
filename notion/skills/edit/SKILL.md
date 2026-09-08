---
name: edit
description: Read and make guarded Notion API changes to pages, blocks, databases, data sources, properties, and comments. Use for Notion page creation, precise edits, native page moves, or explicitly authorized archival and schema changes.
---

# Notion editing

Read `../../references/common-workflow.md` and `../../references/operations.md`. Resolve the plugin root two directories above this skill directory; `<cli>` means `node <plugin-root>/scripts/notion.mjs`.

1. Resolve the workspace and exact resource IDs. Inspect source and destination with `<cli> inspect --workspace <name> --id <id> --kind <kind>`.
2. Confirm the intended change against live content and parentage. Follow actual page mentions; similar titles are insufficient.
3. Write the operations JSON described in the shared reference. Run `<cli> plan --workspace <name> --file <operations.json>`.
4. Review the plan's exact targets, proposed changes, no-ops, and destructive classification. An advice-only request stops here.
5. Apply authorized changes with `<cli> apply <plan-id> --workspace <name>`. Destructive changes need the specific authorization described in the reference.
6. Use the journal and readback result as the outcome. Stop on stale state, rejected scope, or ambiguous results. Never retry a creation by producing a fresh plan after an uncertain response.

Prefer native page moves and incremental updates. Never recreate a page to simulate moving it. Preserve database properties and existing select-option colors. Unsupported endpoints fail explicitly; do not bypass the client with token-reading scripts or direct HTTP mutations.
