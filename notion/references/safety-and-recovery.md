# Plans, attempts, and recovery

Every mutation uses a persisted plan. Planning reads current state and makes
no Notion writes. Inspect the operation payloads, target IDs, destinations,
insertion anchors, observations, and destructive flag before applying.
Private request JSON files must be owner-only; use `chmod 600` on a file
created without exposing its content.

```sh
node <plugin>/scripts/notion.mjs plan --workspace example --file /private/operations.json
node <plugin>/scripts/notion.mjs show-plan <plan-id> --workspace example
node <plugin>/scripts/notion.mjs apply <plan-id> --workspace example
node <plugin>/scripts/notion.mjs journal <plan-id> --workspace example
```

The engine binds the plan to its profile, integration, roots, protected
resources, and canonical mapping. It authenticates private plan/journal files,
serializes cooperating writers using a profile lock, checks observed state
again, records each attempt durably, and reads back the intended effect.
These controls do not make Notion transactional: humans and external clients
can still edit concurrently.

New plan capture and apply refresh connection identity at their execution boundaries.
Complete plans and journals are checked against the selected credential before
being written, including object keys. If source content contains that credential,
planning refuses it rather than copying it into local state.

Successful replay of the same plan does not repeat its writes. Optional
`--request-key` binds one logical request to one plan; reuse it only for retries
of that request with the same payload and summary. A later user request needs
a new key, even if it toggles the same task back to an earlier value.

Archive and property-deletion operations need `--approve-destructive` when
applying. That flag records execution approval; the skill must first establish
the user's actual authorization. Deleting schema properties additionally
requires their exact names in `allowDeleteProperties`. Configured roots cannot
be moved or archived.

## When an attempt stops

| State/error | Meaning and action |
|---|---|
| `STALE_PLAN` | Content, ancestry, membership, or ordering changed. Inspect current state and make a fresh plan. |
| `partial` | Earlier steps applied before a definite refusal. Preserve the journal and plan only the remaining work after reconciliation. |
| `uncertain` | A request may have committed, or its exact effect could not be confirmed. Inspect its result IDs, target, and parent membership read-only. Do not retry the write or create a replacement until the outcome is established. |
| `BUSY` | A writer holds the profile lock, or ownership is unverifiable. Wait for a live owner; do not remove its lock. |
| `TAMPERED_STATE` | Private state failed integrity validation. Preserve it for investigation; never edit a signature or digest to bypass the refusal. |

Uncertain failures include a typed `causeCode` in the error and journal when
available. It distinguishes a readback mismatch from a transport-level uncertain
response without recording the response body. It does not authorize retrying a
write; reconcile the actual effect first.

There is no automatic rollback, automatic stale-lock removal, or automatic
resumption of interrupted attempts. For an explicitly reported dead lock owner,
inspect the exact lock file and associated journal, confirm that no writer or
recovery process is active, then remove only that named stale lock. Removing a
lock does not make an uncertain journal safe to replay.

Move recovery uses the same page ID and a newly reviewed native move back to
its previous parent. Newly created test pages can be archived by exact ID.
Other repairs require fresh, scoped operations; restoring a snapshot over a
live page would overwrite intervening human work.

Notion may make child-list endpoints unavailable after archival. Archive
readback checks the exact previously reviewed resources for positive trash
state, preserved contents and parent relationships, plus removal from the live
parent. Missing individual resources remain uncertain. The journal records that
unseen concurrent additions and ordering changes cannot be ruled out after
archival.

Database containers can report `in_trash: false` after an ancestor is archived.
In that case, readback requires the exact `child_database` block to be in trash
with the same parent and title, while separately checking the database metadata,
data sources, and reviewed rows. A missing block is still an uncertain result.
Generated resource self-links are excluded from state fingerprints; URL
properties and content links remain part of the observed state.

Journals and before-state snapshots stay in `NOTION_HOME/.state/`, with mode
`600` files and `700` directories. They may contain private document content.
Keep the integrity key with its state when making a private backup; never
publish raw state as test evidence. Filesystem integrity checks detect
accidental edits and incomplete local state, not a hostile process that can
read and replace the same user's key.
