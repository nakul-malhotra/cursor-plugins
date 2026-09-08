# Todo requests

The todo adapter reads one workspace profile, inspects its configured task container or data
source, and returns a plan. It never writes to Notion directly.

This reference documents the request and output contract. It does not establish that the plugin
is installed or that any live workspace matches a profile.

## Workflow

Use `/notion:todos` with the shared installed CLI in three steps:

```sh
node <plugin-root>/scripts/notion.mjs todos list --workspace gantry --owner Nakul
node <plugin-root>/scripts/notion.mjs todos plan --workspace gantry --file /private/path/request.json
node <plugin-root>/scripts/notion.mjs apply <plan-id> --workspace gantry
```

`list` is read-only. `plan` parses the request, reads the live task structure, and passes the
adapter's operations to the shared plan engine. `apply` executes a previously reviewed plan.
If Notion changed after planning, the operation preconditions make apply stop as stale instead
of silently replanning.

Request files can contain only the fields documented below. Empty text, unknown fields,
impossible dates, title-only completion, and requests without work are errors.

## Add pending plans

```json
{
  "intent": "plan",
  "owner": "Nakul",
  "date": "tomorrow",
  "items": [
    {
      "text": "Review the allocation run",
      "subitems": ["Check rollover quantities", "Confirm the final container"]
    }
  ]
}
```

Plans create unchecked tasks. In a dated block layout, an omitted date resolves to today in the
profile timezone. Existing date headings can be date mentions or legacy plain `YYYY-MM-DD`
paragraphs; newly created headings always use Notion date mentions.

## Add backlog items

```json
{
  "intent": "backlog",
  "owner": "Nakul",
  "section": "Nakul",
  "items": [{ "text": "Evaluate a bulk-import flow" }]
}
```

Backlog tasks are unchecked. The profile selects the owner-specific backlog container when one
is configured. Section matching is exact after whitespace and case normalization, so `Nakul`
does not match a longer heading. Configured section labels bound the insertion range; a paragraph
divider such as `back-back log` is preserved and is not treated as part of the preceding section.
A standing section also ends when dated history begins, so backlog additions do not land under
an old date.

## Log shipped work

Workspaces with configured log buckets use each item as a bucket and require at least one
subitem:

```json
{
  "intent": "log",
  "owner": "Nakul",
  "date": "today",
  "items": [
    {
      "text": "infra updates",
      "subitems": ["Added stale-plan preconditions", "Recorded uncertain writes"]
    }
  ]
}
```

The adapter reuses one exact matching bucket in the selected date, adds only missing checked
children, and refuses ambiguous duplicate buckets. Workspaces without configured buckets create
flat checked shipped entries instead.

## Complete or update an exact task

Completion requires the exact block or database-row page ID:

```json
{
  "intent": "complete",
  "id": "00000000-0000-4000-8000-000000000123"
}
```

```json
{
  "intent": "update",
  "id": "00000000-0000-4000-8000-000000000123",
  "text": "Review and publish the allocation run",
  "checked": false
}
```

`complete` marks the exact task checked unless `checked` is supplied explicitly. `update`
requires `text`, `checked`, or both. The ID must resolve to a `to_do` block under the configured
todo page, or to a row whose parent is the configured data source. A generic document page is
not a task, and task titles are never used to select a completion target.

## Date values

`date` accepts `today`, `tomorrow`, or a real calendar date in `YYYY-MM-DD` form. Relative dates
use the profile timezone rather than the computer's local timezone. Impossible dates such as
`2026-02-30` are rejected.

Preserve-order layouts retain historical disorder and duplicate old dates. An unrelated old
duplicate does not block a new date; selecting a date that itself has multiple headings is
ambiguous and is refused. Validation failures return `TODO_VALIDATION` with a redacted,
actionable message.

## List output

Block-backed profiles return the selected section or date band, retaining the actual heading
and the unmodified blocks inside that band:

```json
{
  "layout": "blocks",
  "container": {
    "key": "Nakul",
    "id": "00000000-0000-4000-8000-000000000010",
    "layout": "dated",
    "owner": "Nakul",
    "section": "Todos",
    "date": "2026-09-05"
  },
  "blocks": []
}
```

`section` and `date` are omitted when they were not selected. Without either selector or a
configured section, the complete container is returned. A missing requested date returns an
empty block list. Separators, page mentions, checked state, and other blocks inside the selected
band are preserved.

Database-backed profiles return the source rows matching the selected owner/date without
dropping properties:

```json
{
  "layout": "database",
  "dataSourceId": "00000000-0000-4000-8000-000000000020",
  "owner": "Nakul",
  "date": "2026-09-05",
  "rows": []
}
```

`owner` and `date` are omitted when they were not selected. List metadata does not include
credential references. The CLI redacts configured credentials and token-shaped text in output.

## Request shape

```ts
type TodoRequest = {
  intent: 'plan' | 'backlog' | 'log' | 'complete' | 'update';
  owner?: string;
  container?: string;
  section?: string;
  date?: string;
  items?: { text: string; subitems?: string[] }[];
  id?: string;
  text?: string;
  checked?: boolean;
};
```

`plan`, `backlog`, and `log` require a nonempty `items` array and do not accept `id`, `text`, or
`checked`. `complete` requires `id` and accepts only an optional `checked` override. `update`
requires `id` plus at least one of `text` or `checked`. Owner, container, section, and date
selectors apply only to collection intents.

Task titles and subitems deduplicate by exact text. Similar titles remain separate tasks.
The explicit intent selects unchecked plans, unchecked backlog entries, or checked shipped-work
logs.

Block-backed profiles support owner, container, section, and date selectors according to their
configured layout. Database-backed profiles support owner and date only when matching properties
are configured; container and section selectors are errors. Todo text is limited to 2,000
characters per title or subitem to match Notion's rich-text boundary.

Completed deliverables and page organization are editing requests, not todo intents.
