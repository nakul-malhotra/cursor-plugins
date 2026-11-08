import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const scriptsDirectory = import.meta.dir;
const installKey = currentInstallKey();
const installDirectory = join(
  resolve(process.env.XDG_CACHE_HOME || join(homedir(), ".cache")),
  "poteto-mode-tools",
  installKey
);
const nodeModulesDirectory = join(installDirectory, "node_modules");
const commanderPackagePath = join(
  nodeModulesDirectory,
  "commander",
  "package.json"
);
const installKeyPath = join(
  nodeModulesDirectory,
  ".poteto-mode-tools-install-key"
);

function currentInstallKey(): string {
  return createHash("sha256")
    .update(readFileSync(join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(readFileSync(join(scriptsDirectory, "bun.lock")))
    .digest("hex");
}

export function ensureDependenciesInstalled(): void {
  const installed =
    existsSync(commanderPackagePath) &&
    existsSync(installKeyPath) &&
    readFileSync(installKeyPath, "utf8").trim() === installKey;

  if (!installed) {
    const cacheDirectory = join(installDirectory, "..");
    mkdirSync(cacheDirectory, { recursive: true });
    const stagingDirectory = mkdtempSync(join(cacheDirectory, ".install-"));
    try {
      for (const file of ["package.json", "bun.lock"]) {
        writeFileSync(
          join(stagingDirectory, file),
          readFileSync(join(scriptsDirectory, file))
        );
      }
      const result = Bun.spawnSync(
        [process.execPath, "install", "--frozen-lockfile"],
        { cwd: stagingDirectory }
      );
      if (result.exitCode !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        throw new Error(
          `bun install --frozen-lockfile exited with status ${result.exitCode}`
        );
      }
      if (
        !existsSync(
          join(stagingDirectory, "node_modules", "commander", "package.json")
        )
      ) {
        throw new Error(
          "bun install --frozen-lockfile completed without installing commander"
        );
      }
      writeFileSync(
        join(stagingDirectory, "node_modules", ".poteto-mode-tools-install-key"),
        `${installKey}\n`
      );
      try {
        renameSync(stagingDirectory, installDirectory);
      } catch (error) {
        // Another launcher can publish the same complete installation first.
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") ||
          !existsSync(commanderPackagePath) ||
          !existsSync(installKeyPath) ||
          readFileSync(installKeyPath, "utf8").trim() !== installKey
        ) {
          throw error;
        }
      }
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  const modulePaths = process.env.NODE_PATH?.split(delimiter) ?? [];
  if (installed && modulePaths[0] === nodeModulesDirectory) return;

  const restarted = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: [nodeModulesDirectory, ...modulePaths].join(delimiter),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(restarted.exitCode ?? 1);
}
