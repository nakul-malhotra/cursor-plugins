---
name: deslop
description: Strip AI slop from a diff before commit — narration comments, defensive scaffolding nobody asked for, any-casts, dead abstraction, and style inconsistent with the surrounding file. Use for /deslop, "clean this diff up", or before any commit in pstack's playbooks.
---

# Deslop

Cursor's `cursor-team-kit` plugin ships this. GitHub Copilot CLI does not, and pstack's playbooks call `/deslop` before every commit. This is that entry point.

Review the diff against its merge base and remove what a careful human author would never have written. Judge every hunk against the file around it, not against a general style guide: the standard is consistency with this codebase.

## Scope

```bash
git diff $(git merge-base HEAD origin/main)...HEAD
```

Only the diff. Pre-existing slop outside the change stays, unless the change made it load-bearing.

## What to remove

| Slop | Looks like |
|---|---|
| Narration comments | `// Loop through the users` above a loop. Comments restating the next line. |
| Section banners | `// ===== HELPERS =====` in a file that has none elsewhere. |
| Defensive scaffolding | try/catch, null guards, or fallbacks around a call path that is already validated and trusted, in an area of the codebase that does not defend. |
| `any` escapes | `as any`, `@ts-ignore`, or a widened signature used to get past a type error rather than model the type. |
| Premature abstraction | A helper, interface, or config flag with exactly one caller and no second one coming. |
| Redundant tests | Tests asserting the language works, or re-covering a path already covered. |
| Tone drift | Verbose JSDoc on a file with none, or terse code in a documented module. |

## What to keep

A comment explaining *why* a non-obvious choice was made. A guard on genuinely untrusted input — a network boundary, user input, a parsed file. An abstraction with two real callers today. When you are unsure whether a guard is defensive slop or a real boundary, trace one caller: if the value reaches this line already validated, it is slop.

## Pass

1. Read the whole diff before editing anything. Slop is a pattern across hunks, not a property of one line.
2. For each candidate, open the surrounding file and check whether the neighbours do the same thing. Consistent is not slop.
3. Remove, then re-run the repo's own gate (`npm run verify`, `cargo test`, whatever the project uses). A removed guard that breaks a test was load-bearing — restore it and note why.
4. Report in one to three sentences what you removed. Do not narrate each deletion.

Removing a check is a behavior change until a passing suite says otherwise. Never report this skill as done without a green run.

For comments specifically, `/no-comments` goes deeper and spawns the Comment Sicko reviewer. Run `/deslop` before commit and `/no-comments` before review; they are complementary, not alternatives.
