---
name: control-cli
description: Drive a real CLI or TUI to prove behavior — build it, run it in an isolated PTY or tmux session, exercise the user path, capture transcripts and exit codes as evidence. Use for /control-cli, "verify this on the command line", "prove the CLI works", or whenever pstack asks for the CLI control skill.
---

# Control a CLI

Cursor's `cursor-team-kit` plugin ships this. GitHub Copilot CLI does not, and pstack's playbooks name `control-cli` wherever a change touches a CLI or TUI surface. This is that entry point.

## Prefer the repo's own skill

Before anything here, look for a project-local verification skill: `.github/skills/verify-*/`, `.cursor/skills/verify-*/`, or an existing harness (expect scripts, a PTY helper, integration tests that shell out). If one exists, use it and stop reading. This skill is the generic fallback for a repo that has none.

If you find yourself writing build and drive steps from scratch, run `/create-verification-skill` so the next agent inherits them.

## Launch

A CLI has no server to keep alive. Launch means build the binary or install dependencies once, then start each drive in its own isolated session.

Build with the repo's own command. Verify you are driving the build you just made, not a stale one on `PATH` — resolve the absolute path to the binary and use it. Running the globally installed version while believing you tested your change is the defining failure of CLI verification.

Give each drive its own working directory, config dir, and env. A CLI that writes to `~/.config` will otherwise carry state between runs and between your run and the user's.

## Doctor

Before the first drive: the binary exists at the path you resolved, `--version` reports the build you expect, and required env or auth is present. Re-run it on each fresh session and after any failed drive.

## Drive

For a non-interactive command, run it directly and capture stdout, stderr, and the exit code separately. The exit code is the assertion most often forgotten and most often wrong.

For a TUI or anything that reads a prompt, allocate a PTY — a detached `tmux` session is the most portable option. Send keys, then wait for a prompt string or a settled screen before sending the next; a fixed sleep races the render and produces flaky, unreproducible transcripts. Capture the pane to a file.

Drive the documented user path. Calling an internal function that the command would have called proves the function works, not the command.

When the safe path is a `--dry-run` or test mode, verify what it actually skips by observing the filesystem, the network, and git refs. Some dry-runs still write, still fetch, still open a browser. Trust the observation, not the flag's name.

## Evidence

Capture the full transcript, the exit code, and the observable side effects — files written, rows inserted, refs moved, requests made. Diff the working directory before and after when the command claims to change it.

Write evidence to a path you name explicitly, outside anything cleanup removes.

## Cleanup

Kill the specific tmux session or PID you started, by name or id you captured at launch. Never kill by process name — concurrent sessions run the same binaries.

Remove the scratch directories the run created. Never remove the evidence: confirm it still exists at its named location after teardown.
