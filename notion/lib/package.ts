import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface PackageResult {
  root: string;
  release: string;
  hash: string;
  files: number;
}

export async function assemblePlugin(source: string, home: string): Promise<PackageResult> {
  source = resolve(source);
  home = resolve(home);
  const files = new Map<string, Buffer>();
  const required = [
    'plugin.json',
    'skills/gardening', 'skills/todos', 'skills/edit',
    'references', 'scripts/notion.mjs', 'dist/cli.js',
    ...[
      'client', 'config', 'engine', 'errors', 'journal', 'operations',
      'package', 'read', 'scope', 'todos', 'types', 'values',
    ].map(name => `dist/lib/${name}.js`),
  ];
  for (const path of required) await collect(source, path, files);
  for (const path of ['assets/workspace.example.json', 'docs/adr']) {
    if (await exists(join(source, path))) await collect(source, path, files);
  }
  const manifest = JSON.parse(files.get('plugin.json')?.toString('utf8') ?? 'null');
  if (manifest?.name !== 'notion' || typeof manifest.version !== 'string') {
    throw new Error('The package must have a notion plugin manifest and version.');
  }
  for (const name of ['gardening', 'todos', 'edit']) {
    if (!files.has(`skills/${name}/SKILL.md`)) throw new Error(`Missing ${name} skill.`);
  }
  files.set('package.json', Buffer.from(JSON.stringify({
    name: 'notion-runtime', version: manifest.version, private: true, type: 'module',
    engines: { node: '>=22.18' },
  })));
  const hash = digest(files);
  await privateDirectory(home);
  const releases = join(home, '.releases');
  await privateDirectory(releases);
  const release = join(releases, hash);
  if (await exists(release)) {
    const existing = new Map<string, Buffer>();
    await collect(release, '', existing);
    if (digest(existing) !== hash) throw new Error('Existing release content differs from its identity.');
  } else {
    const stage = await mkdtemp(join(releases, '.stage-'));
    let published = false;
    try {
      for (const [path, body] of files) {
        const target = join(stage, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, body, { flag: 'wx', mode: 0o644 });
      }
      await rename(stage, release);
      published = true;
    } finally {
      if (!published) await rm(stage, { recursive: true });
    }
  }
  const root = join(home, 'plugin');
  if (await exists(root)) {
    const state = await lstat(root);
    const target = state.isSymbolicLink() ? await readlink(root) : '';
    if (!/^\.releases\/[a-f0-9]{64}$/.test(target)) {
      throw new Error('Refusing to replace a plugin path not owned by this installer.');
    }
  }
  const next = join(home, `.plugin-next-${randomUUID()}`);
  await symlink(`.releases/${hash}`, next);
  let activated = false;
  try {
    await rename(next, root);
    activated = true;
  } finally {
    if (!activated) await unlink(next);
  }
  return { root, release, hash, files: files.size };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function privateDirectory(path: string): Promise<void> {
  if (!(await exists(path))) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(`Expected an owner-only directory: ${path}`);
  }
}

async function collect(root: string, path: string, files: Map<string, Buffer>): Promise<void> {
  for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    if ((await lstat(join(root, parent))).isSymbolicLink()) {
      throw new Error(`Cannot package a symbolic link: ${parent}`);
    }
  }
  const entry = join(root, path);
  const stat = await lstat(entry);
  if (stat.isSymbolicLink()) throw new Error(`Cannot package a symbolic link: ${path}`);
  if (stat.isDirectory()) {
    for (const name of (await readdir(entry)).sort()) {
      if (name.startsWith('.')) throw new Error(`Hidden files cannot enter a runtime package: ${name}`);
      await collect(root, join(path, name), files);
    }
  } else {
    if (!stat.isFile()) throw new Error(`Unsupported package entry: ${path}`);
    const body = await readFile(entry);
    if (/(?:ntn_|secret_)[A-Za-z0-9_-]{20,}/.test(body.toString('utf8'))) {
      throw new Error(`Credential-shaped content prevents packaging: ${path}`);
    }
    files.set(path, body);
  }
}

function digest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const [path, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${Buffer.byteLength(path)}:${path}:${body.length}:`);
    hash.update(body);
  }
  return hash.digest('hex');
}
