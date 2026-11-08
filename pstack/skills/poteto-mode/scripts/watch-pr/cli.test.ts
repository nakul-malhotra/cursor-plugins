import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CliRuntime, main, parseArgs } from "./cli.ts";
import { fakeReader, passingCheck } from "./fakes.test-helper.ts";
import { renderJson, renderPretty } from "./render.ts";
import type { GitHubReader, WatcherVerdict } from "./types.ts";
import { parsePrNumber } from "./types.ts";

const silentIo = { stdout: () => {}, stderr: () => {} };

describe("immutable bootstrap", () => {
  it("runs cold and warm CLI help with pinned dependencies despite an ancestor package", () => {
    const directory = mkdtempSync(join(process.cwd(), ".bootstrap-test-"));
    const source = join(directory, "source");
    const cache = join(directory, "cache");
    mkdirSync(source);
    for (const file of ["bootstrap.ts", "package.json", "bun.lock"]) {
      cpSync(join(import.meta.dir, "..", file), join(source, file));
    }
    cpSync(import.meta.dir, join(source, "watch-pr"), { recursive: true });
    cpSync(join(import.meta.dir, "..", "orch"), join(source, "orch"), {
      recursive: true,
    });
    const ancestorCommander = join(directory, "node_modules", "commander");
    mkdirSync(ancestorCommander, { recursive: true });
    writeFileSync(
      join(ancestorCommander, "package.json"),
      JSON.stringify({ name: "commander", type: "module", main: "index.js" })
    );
    writeFileSync(
      join(ancestorCommander, "index.js"),
      [
        "export class Command {}",
        "export class CommanderError {}",
        "export class InvalidArgumentError {}",
        "export class Option {}",
        'throw new Error("UNPINNED_PARENT_COMMANDER");',
      ].join("\n")
    );
    const lock = readFileSync(join(source, "bun.lock"));
    const manifest = readFileSync(join(source, "package.json"));
    const entries = readdirSync(source);
    chmodSync(source, 0o555);
    try {
      expect(() => writeFileSync(join(source, "write-probe"), "")).toThrow();
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const [entryPoint, usage] of [
          ["watch-pr/watch-pr", "Usage: watch-pr"],
          ["orch/orch.ts", "Usage: orch"],
        ]) {
          const result = Bun.spawnSync(
            [process.execPath, join(source, entryPoint), "--help"],
            {
              cwd: directory,
              env: {
                ...process.env,
                GH_TOKEN: "",
                GITHUB_TOKEN: "",
                NODE_PATH: "",
                XDG_CACHE_HOME: cache,
                BUN_INSTALL_CACHE_DIR: join(directory, "bun-cache"),
              },
              timeout: 30_000,
            }
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout.toString()).toContain(usage);
          expect(result.stderr.toString()).toBe("");
        }
      }
      expect(existsSync(join(source, "node_modules"))).toBe(false);
      expect(readdirSync(source)).toEqual(entries);
      expect(readFileSync(join(source, "bun.lock"))).toEqual(lock);
      expect(readFileSync(join(source, "package.json"))).toEqual(manifest);
      const installs = readdirSync(join(cache, "poteto-mode-tools"));
      expect(installs).toHaveLength(1);
      expect(
        readFileSync(
          join(cache, "poteto-mode-tools", installs[0], "bun.lock")
        )
      ).toEqual(lock);
    } finally {
      chmodSync(source, 0o755);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

function testRuntime(reader: GitHubReader): {
  readonly runtime: CliRuntime;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    runtime: {
      reader,
      clock: {
        now: () => 0,
        observedAt: () => "2026-07-26T00:00:00.000Z",
        async sleep() {
          throw new Error("test unexpectedly slept");
        },
      },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("parseArgs", () => {
  it("uses the specified defaults", () => {
    expect(parseArgs([], silentIo)).toMatchObject({
      owner: null,
      repo: null,
      pr: null,
      mode: "single",
      stackPrs: [],
      statusOnly: false,
      pretty: false,
      polling: {
        interval: 60,
        sweepInterval: 300,
        timeout: 0,
        maxQueryErrors: 5,
        allowDraft: false,
      },
    });
  });

  it("parses a frozen queued stack bottom-to-top", () => {
    const parsed = parseArgs(
      [
        "--queued-stack",
        "--stack-prs",
        "#10, 11,#12",
        "--interval",
        "2.5",
        "--sweep-interval",
        "30",
        "--timeout",
        "0",
        "--max-query-errors",
        "3",
        "--allow-draft",
        "--pretty",
      ],
      silentIo
    );
    expect(parsed.mode).toBe("queued-stack");
    expect(parsed.stackPrs.map(Number)).toEqual([10, 11, 12]);
    expect(parsed.polling).toEqual({
      interval: 2.5,
      sweepInterval: 30,
      timeout: 0,
      maxQueryErrors: 3,
      allowDraft: true,
    });
    expect(parsed.pretty).toBe(true);
  });

  it("rejects every invalid mode and numeric shape as usage", async () => {
    const invalid = [
      ["--unknown"],
      ["--interval", "0"],
      ["--sweep-interval", "-1"],
      ["--timeout", "-1"],
      ["--max-query-errors", "1.5"],
      ["--stack", "--queued-stack"],
      ["--stack-prs", "1,2"],
      ["--queued-stack", "--stack-prs", "1,1"],
    ];
    for (const argv of invalid) {
      const harness = testRuntime(fakeReader());
      expect(await main(argv, harness.runtime)).toBe(64);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr.join("")).toContain("error:");
    }
  });
});

describe("rendering", () => {
  const context = {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };
  const status = {
    schemaVersion: 1,
    sequence: 1,
    observedAt: "2026-07-26T00:00:00.000Z",
    mode: "single",
    kind: "STATUS",
    terminal: true,
    exitCode: 0,
    reason: "status-only",
    rows: [
      {
        kind: "merged",
        context,
        facts: {
          context,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          headRefOid: "head",
          headRefName: "feature",
          baseRefName: "main",
          state: "MERGED",
          mergedAt: "now",
          isDraft: false,
        },
      },
    ],
  } satisfies WatcherVerdict;

  it("emits compact valid JSON by default", () => {
    const rendered = renderJson(status);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(status);
  });

  it("renders the Markdown table from the same verdict only", () => {
    const rendered = renderPretty(status);
    expect(rendered).toContain("| PR | CI | Review | Merge |");
    expect(rendered).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | \u2014 | \u2014 | ✅ merged |"
    );
  });
});

describe("main", () => {
  it("returns EX_USAGE 64 and writes usage errors only to stderr", async () => {
    const harness = testRuntime(fakeReader());
    expect(await main(["--interval", "0"], harness.runtime)).toBe(64);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("")).toContain(
      "option '--interval <seconds>' argument '0' is invalid"
    );
  });

  it("bypasses the queue machine for queued-stack status-only", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    const code = await main(
      [
        "--owner",
        "owner",
        "--repo",
        "repo",
        "--queued-stack",
        "--stack-prs",
        "1",
        "--status-only",
      ],
      harness.runtime
    );
    expect(code).toBe(0);
    expect(harness.stdout).toHaveLength(1);
    const verdict: unknown = JSON.parse(harness.stdout[0]);
    expect(verdict).toMatchObject({
      kind: "STATUS",
      terminal: true,
      exitCode: 0,
      mode: "queued-stack",
    });
    expect(harness.stdout[0]).not.toContain('"kind":"QUEUE"');
  });

  it("returns exit 4 for a hidden GitHub-side CI refusal", async () => {
    const reader = fakeReader({
      facts: { mergeStateStatus: "BLOCKED" },
      fastPath: { kind: "checks", checks: [passingCheck()] },
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    });
    const harness = testRuntime(reader);
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1"],
      harness.runtime
    );
    expect(code).toBe(4);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      kind: "BLOCKER",
      exitCode: 4,
      blocker: {
        kind: "failing-checks",
        ci: { kind: "ci-github-rejected" },
      },
    });
  });

  it("shows help without touching the reader", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    expect(await main(["--help"], harness.runtime)).toBe(0);
    expect(harness.stdout.join("")).toContain("JSON (NDJSON while polling)");
    expect(reader.calls).toEqual([]);
  });
});
