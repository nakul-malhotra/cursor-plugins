---
name: todos
description: Read and update Notion tasks, dated plans, backlogs, completion, and shipped-work logs using each workspace's own layout. Use for Notion todo updates, today/tomorrow planning, logging shipped work, or reconciling tasks with PRs across Gantry, Medicus, Praetor, and configured aliases.
---

# Notion todos

Read `../../references/common-workflow.md` and `../../references/todos.md`. Resolve the plugin root two directories above this skill directory; `<cli>` means `node <plugin-root>/scripts/notion.mjs`.

Default to concise, plain-English prose in task titles, subitems, shipped-work logs, and replies. Lead with the action or outcome a teammate can understand without reading the code. Keep technical detail only when it is necessary to explain the task, distinguish its scope, or preserve an important constraint. Include the relevant PR links for PR-related work; follow the writing and link examples in `references/todos.md`.

1. Resolve the workspace and load its profile. Run `<cli> todos list --workspace <name> --owner <owner>` before changing existing tasks.
2. Distinguish `plan`, `backlog`, `log`, `complete`, and `update`. Pending plans remain pending; a date does not imply completion. Organizing completed documents belongs to editing, not task scheduling.
3. For PR-derived work, refresh the actual repository's PR state and dependencies. Draft/open PRs are pending. A merged PR is evidence to interpret, not permission to check off every related task.
4. Write the selected intent and exact task text to a local request JSON file using the schema in `references/todos.md`. Use the profile's owner, section, date, and bucket conventions.
5. Run `<cli> todos plan --workspace <name> --file <request.json>`. Inspect the resulting plan, resolved anchor, intended checked states, and no-ops.
6. If the user authorized the changes, run `<cli> apply <plan-id> --workspace <name>`. Report the readback outcome; an uncertain or partial result is unfinished work.

Reuse existing tasks and shipped buckets. Preserve unrelated blocks, dates, page mentions, PR references, task completion, and nesting. Do not flatten the page, rename buckets opportunistically, or infer an owner from a matching task title. A request to read or summarize tasks does not authorize rewriting their wording in Notion.
