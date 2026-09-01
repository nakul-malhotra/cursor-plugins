---
name: control-ui
description: Drive a real browser, Electron, or web UI to prove behavior — launch it, exercise the user path, capture screenshots and console output as evidence. Use for /control-ui, "verify this in the browser", "prove the UI works", or whenever pstack asks for the UI control skill.
---

# Control a UI

Cursor's `cursor-team-kit` plugin ships this. GitHub Copilot CLI does not, and pstack's playbooks name `control-ui` wherever a change touches a browser, Electron, or web surface. This is that entry point.

## Prefer the repo's own skill

Before anything here, look for a project-local verification skill: `.github/skills/verify-*/`, `.cursor/skills/verify-*/`, or an existing harness (Playwright specs, Cypress, a dev script). If one exists, use it and stop reading — it knows the real selectors, ports, seed data, and auth. This skill is the generic fallback for a repo that has none.

If the repo has no such skill and you find yourself writing launch and drive steps from scratch, that is the signal to run `/create-verification-skill` and make the next agent's job cheap.

## Launch

Use the repo's own documented dev command — a package script, a Makefile target, the README quickstart. Never invent one. Note the port, the env vars, and any seed or auth step. Start it detached so it survives the drive, and wait for a real readiness signal (a log line, the port answering) rather than sleeping a fixed interval.

Run it on a non-default port when one may already be up. Driving someone else's running instance corrupts their session and produces evidence about the wrong build.

## Doctor

Before the first drive, and again after anything surprising, answer one read-only question: is this instance worth driving? The process is up, the port belongs to what you started, the build is the one you just made, and auth is valid. A drive against a stale instance produces a confident, wrong result.

## Drive

Use Playwright when the repo already depends on it — it is the shortest path to a real browser and most repos with a web surface have it. Otherwise use whatever the repo has, or CDP over the browser's remote debugging port.

Prefer stable handles in this order: `data-testid` and other test attributes, ARIA roles and accessible names, visible text, route paths. Never coordinates, never tab order — both encode layout that the change you are verifying may have moved.

Exercise the path a user takes. Clicking through the UI proves the feature; calling the store setter that the UI would have called proves nothing about the UI.

## Evidence

Capture the action and the resulting state, not only the final screen. A screenshot before and after the interaction, the console output, and any network call that mattered. Verify side effects too — the row written, the file created, the email queued — since a UI that renders success over a failed write is exactly the bug worth catching.

For visual work, capture every theme and breakpoint the repo supports. One screenshot in one theme is not coverage when five exist.

Write evidence to a path you name explicitly, outside anything cleanup removes.

## Cleanup

Kill what you started, by the PID you captured at launch. Never kill by process name — concurrent sessions and other worktrees run the same binaries, and a name-matched kill takes them out too.

Remove scratch state the run created. Never remove the evidence: confirm it still exists at its named location after teardown.
