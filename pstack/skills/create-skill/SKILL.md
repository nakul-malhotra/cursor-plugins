---
name: create-skill
description: Author or revise a SKILL.md through a draft, test, iterate loop, including description optimization when a skill exists but fails to trigger. Use for /create-skill, "write a skill", "tune this skill's description", or whenever pstack hands skill authoring off.
---

# Create a skill

Cursor ships this as a built-in. GitHub Copilot CLI does not, and pstack references it by name from `reflect`, the authoring-a-skill playbook, and `automate-me`. This is that entry point.

A skill is a prompt read cold, mid-task, by an agent that has never seen your repo. Write for that reader.

## Placement

| Scope | Path | For |
|---|---|---|
| Repo | `.github/skills/<name>/SKILL.md` | anything repo-specific: harnesses, domain rules, verification |
| User | `~/.copilot/skills/<name>/SKILL.md` | your workflow across every repo |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | distributed as a set |

Repo scope is the default when the skill names a path, a command, or a domain concept from one codebase. A skill that only works in one repo does not belong in user scope.

## Frontmatter

Required, or the skill never registers:

```yaml
---
name: kebab-case-name
description: What it does, then when to reach for it. Name the literal trigger phrases.
---
```

The `description` is the only thing the router sees before deciding. It is a matching surface, not a summary. Name the exact words a user says when they want this. A description that describes the skill to a human, rather than announcing its triggers to a router, is the single commonest reason a skill sits unused.

Optional: `disable-model-invocation: true` makes the skill explicit-invocation only. Use it for skills with side effects you never want auto-fired.

## Draft, test, iterate

1. **Draft.** Write the smallest body that makes a cold agent succeed. Steps in order, real commands, real paths from this repo. No placeholders.
2. **Test.** Run it cold against a real task, ideally on a weaker model — a skill that only works on the strongest model is underwritten. Watch where the agent hesitates, guesses, or does the wrong thing.
3. **Iterate.** Every hesitation is a missing sentence. Every wrong turn is an ambiguous one. Fix the skill, not the transcript.

A skill that was never executed is a draft, not a deliverable.

## Description optimization

When a skill exists but did not trigger, the body is rarely the problem. Collect the phrasings that should have matched and did not, then rewrite the description so those literal words appear in it. Re-test with the original phrasing.

## Writing rules

- Second person, imperative. "Run the suite", not "the agent should run the suite".
- One instruction per sentence. A compound sentence gets half-followed.
- State what to do, not what to avoid. Prohibitions that carry real cost get one line each.
- Tables for lookups, numbered steps for sequences, prose for judgment.
- Keep the body under roughly 200 lines. Push detail into `references/` and link it, so the router pays for the summary and only the executor pays for the depth.

Apply the `technical-writing` and `unslop` skills to the result. Agent-facing prose is still prose.
