# Supported operations

Use `scripts/notion.mjs --help` for commands. Reads include scoped search,
bounded inspection, data-source queries, and page/block comments.
`garden` returns candidate structural findings; content-quality judgement
requires reading the relevant sources. Coverage gaps remain explicit.

Write requests are an array of operations or `{"operations":[...]}`.
Unknown fields, malformed IDs, credential-shaped content, and unsupported
payloads fail before writes. Use native Notion property and rich-text shapes,
omitting response-only fields such as `plain_text` and `href`.

| `kind` | Required fields | Optional fields |
|---|---|---|
| `append-blocks` | `parentId`, `children` | `position` |
| `update-block` | `id`, `patch` containing exactly the actual block content type | |
| `archive-block` | `id` | |
| `create-page` | `parent`, `properties` | `children`, `icon`, `cover` |
| `update-page` | `id`, `patch` | |
| `move-page` | `id`, `parent` | |
| `archive-page` | `id` | |
| `create-database` | page `parent`, rich-text `title`, schema `properties` | |
| `update-data-source` | `id`, `patch` | `allowDeleteProperties` |
| `update-database` | `id`, `patch` | |
| `create-comment` | page `parentId`, `richText` | |

A parent is `{"kind":"page","id":"..."}` or
`{"kind":"data_source","id":"..."}`. Database creation requires a page parent.
Page moves use Notion's native move endpoint and preserve identity; moving a
page directly into a column or moving arbitrary blocks is unsupported.

Append positions are `{"type":"start"}`, `{"type":"end"}`, or
`{"type":"after_block","after_block":{"id":"..."}}`. An anchor must be an
immediate child of the selected parent. These use API version `2026-03-11`;
do not send the retired `after` field. One append accepts at most 100 direct
children and two nested levels; planners must batch larger additions.

For example, a narrow checked-state change:

```json
[{
  "kind": "update-block",
  "id": "00000000-0000-0000-0000-000000000003",
  "patch": {"to_do": {"checked": true}}
}]
```

Use `todos plan` for task intent so owner, date, section, status, and deduplication
rules are handled by the configured adapter rather than hand-built payloads.

## Schema updates

`update-page.patch` supports `properties`, `icon`, and `cover`.
`update-data-source.patch` supports `properties`, `title`, `description`, and
`icon`. `update-database.patch` supports `title`, `description`, `icon`, `cover`,
and `is_inline`. Unsupported Notion UI features are not silently approximated.

Schema properties omitted from a patch remain unchanged. Existing select
and multi-select options retain their exact IDs, names, and colors; new options
require explicit names and colors. Row updates cannot implicitly create options.
Property deletion requires a `null` patch plus exact `allowDeleteProperties`
names and destructive approval. Title-property deletion, schema type changes,
and changes to existing relation targets are refused. Computed-property or
non-deterministic creation defaults may be unsupported and fail explicitly.

## Prior reads and safe apply

All operations can carry `watches: [{"ref":{"kind":"page","id":"..."},
"children":true}]` to observe resources and membership while planning.
Adapters also attach `preconditions: [{"kind":"children","id":"...",
"hash":"..."}]` for reads made before plan creation. Supported precondition
kinds are `page`, `block`, `database`, `data_source`, `children`, and `query`.
Use the shared `stateFingerprint` export; do not hash raw JSON differently.

Keep returned plan IDs and inspect failures through `journal`. See
`safety-and-recovery.md` for stale state, partial success, uncertain outcomes,
and exact recovery boundaries. There is no arbitrary HTTP write escape hatch.
