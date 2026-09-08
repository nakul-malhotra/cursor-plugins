# ADR: Keep Notion credentials local and mutations behind reviewed plans

## Status

Accepted.

## Context

Several local workflows use different Notion clients and layout assumptions. A dated task can be a future plan or a completed log. Similar page titles do not establish page identity. Notion has no multi-request transaction, and retrying a timed-out creation can duplicate content.

The user chose a hidden local credential file and a plugin with three namespaced skills. Live onboarding established that the three startup connections have different bot identities and root pages inside the same physical Notion workspace. Workspace ID alone therefore cannot authorize an operation.

## Decision

Keep credentials, profiles, and operation records in a private local Notion home, outside the installable plugin subtree. Files containing credentials use mode 600; this is plaintext protected by the local account, not encrypted secret storage.

Bind every operation to both the connection identity and the configured root scope. Keep transport and ancestry validation in shared infrastructure. Pure todo planners describe changes; a single mutation engine owns planning, relevant-state fingerprints, write coordination, execution, readback, and recovery records.

Scoped read methods include comment listing. A scope caches a successfully verified connection identity for its client, checks it against the current profile on each read, and rereads resource ancestry. Explicit connection verification, including apply's entry check, refreshes identity. Ordinary CLI code must not call the raw transport. The engine is the trusted effect owner: it uses transport only after its scope and state checks, including exact-ID readback after archival.

Package gardening, todos, and editing as ordinary skills inside the `notion` plugin. Skills decide intent and content; they do not implement separate HTTP clients. Gardening defaults to read-only review.

Use the current API's block `position` parameter for insertion, including insertion at the start of a container. Preserve page identity with native page moves. Do not carry the deprecated `after` parameter into new requests.

## Rejected alternatives

Independent clients in each skill would duplicate credential, retry, and scope rules. A raw HTTP escape hatch would bypass the operation contract. Copying and deleting pages to simulate moves would change IDs and risk losing references. Keeping credentials inside the installed plugin would expose them to packaging and cache replacement.

Duplicating engine authorization in a second generic HTTP wrapper would add another rule owner without making Notion requests transactional. The public command surface exposes reviewed operations instead of URLs or HTTP verbs. This is an application boundary, not isolation from arbitrary code running as the same local user.

Keychain was considered; the user selected the simpler local-file approach. A new MCP service or daemon adds lifecycle work without a current consumer that needs it.

## Consequences

Plugin updates can replace code without replacing local credentials or profiles. Requests are inspectable before execution, and repeated application of the same completed plan can be recognized.

State checks and local write locks reduce conflicts but cannot prevent a human editor from changing Notion between API calls. Partial and uncertain outcomes must remain explicit; recovery must not overwrite subsequent edits. Unknown outcomes of non-idempotent writes require reconciliation rather than blind retries.

The three Notion skills and shared CLI are the plugin's supported entry points. Gantry's implementation-grounded publishing and generated KB mirror remain domain responsibilities with their existing credential sources. Production content is not reorganized as part of installation; live mutation tests use isolated, named pages.
