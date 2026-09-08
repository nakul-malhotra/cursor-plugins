import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rename, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assemblePlugin } from '../lib/package.js';

const runtimeModules = [
  'client', 'config', 'engine', 'errors', 'journal', 'operations',
  'package', 'read', 'scope', 'todos', 'types', 'values',
];
const legacyFiles = [
  'scripts/gantry-todo.mjs',
  'scripts/migrate-local.mjs',
  'dist/lib/legacy.js',
  'assets/gantry-todo-skill.md',
  'assets/legacy/gantry-todo.mjs',
  'assets/legacy/gantry-todos-server.mjs',
  'assets/legacy/notion-workspace-architect.md',
  'assets/legacy/startup-sync.md',
  'skills/gantry-todo/SKILL.md',
  'agents/notion-workspace-architect.md',
  'mcp/gantry-todos/server.mjs',
  'commands/startup-sync.md',
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'notion-package-test-'));
  const source = join(root, 'source');
  const home = join(root, 'home');
  await mkdir(source, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const files: Record<string, string> = {
    'plugin.json': JSON.stringify({ name: 'notion', version: '0.1.0', skills: 'skills/' }),
    'scripts/notion.mjs': 'console.log("notion");',
    'dist/cli.js': 'export const ready = true;',
    ...Object.fromEntries(runtimeModules.map(name => [`dist/lib/${name}.js`, 'export const version = 1;'])),
    'assets/workspace.example.json': '{"key":"example"}',
    'references/common-workflow.md': '# Common workflow',
    ...Object.fromEntries(['gardening', 'todos', 'edit'].map(name => [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}`])),
    ...Object.fromEntries(legacyFiles.map(path => [path, 'obsolete wrapper'])),
    '.credentials.json': '{"should":"never be distributed"}',
    'node_modules/unused/index.js': 'not packaged',
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), body);
  }
  await writeFile(join(home, '.credentials.json'), '{"private":"local credential fixture"}', { mode: 0o600 });
  return { root, source, home };
}

test('package contains only current runtime assets and leaves local credentials outside its tree', async () => {
  const f = await fixture();
  try {
    const result = await assemblePlugin(f.source, f.home);
    assert.equal(result.root, join(f.home, 'plugin'));
    assert.equal(JSON.parse(await readFile(join(result.root, 'package.json'), 'utf8')).type, 'module');
    assert.equal(await readFile(join(result.root, 'dist/lib/client.js'), 'utf8'), 'export const version = 1;');
    assert.equal(await readFile(join(result.root, 'assets/workspace.example.json'), 'utf8'), '{"key":"example"}');
    assert.deepEqual((await readdir(join(result.root, 'scripts'))).sort(), ['notion.mjs']);
    assert.deepEqual((await readdir(join(result.root, 'skills'))).sort(), ['edit', 'gardening', 'todos']);
    assert.deepEqual((await readdir(join(result.root, 'dist/lib'))).sort(), runtimeModules.map(name => `${name}.js`).sort());
    assert.deepEqual(await readdir(join(result.root, 'assets')), ['workspace.example.json']);
    for (const path of legacyFiles) {
      await assert.rejects(lstat(join(result.root, path)), { code: 'ENOENT' }, path);
    }
    await assert.rejects(lstat(join(result.root, '.credentials.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(result.root, 'node_modules')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.home, '.credentials.json'), 'utf8'), '{"private":"local credential fixture"}');
    assert.equal((await lstat(join(f.home, '.credentials.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('updates atomically switch immutable releases without changing the previous release', async () => {
  const f = await fixture();
  try {
    const first = await assemblePlugin(f.source, f.home);
    await writeFile(join(f.source, 'dist/lib/client.js'), 'export const version = 2;');
    const second = await assemblePlugin(f.source, f.home);
    assert.notEqual(first.hash, second.hash);
    assert.equal(await realpath(second.root), await realpath(second.release));
    assert.equal(await readFile(join(first.release, 'dist/lib/client.js'), 'utf8'), 'export const version = 1;');
    assert.equal(await readFile(join(second.root, 'dist/lib/client.js'), 'utf8'), 'export const version = 2;');
    const repeated = await assemblePlugin(f.source, f.home);
    assert.equal(repeated.hash, second.hash);
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('packaging rejects credential-shaped content inside an otherwise valid skill', async () => {
  const f = await fixture();
  try {
    const skill = join(f.source, 'skills/edit/SKILL.md');
    const original = await readFile(skill, 'utf8');
    await writeFile(skill, `${original}\nntn_${'x'.repeat(32)}\n`);
    await assert.rejects(assemblePlugin(f.source, f.home), /credential-shaped/i);
    await assert.rejects(lstat(join(f.home, 'plugin')), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('packaging rejects links that would copy private files into a skill', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.home, '.credentials.json'), join(f.source, 'skills/gardening/leak.md'));
    await assert.rejects(assemblePlugin(f.source, f.home), /symbolic link/i);
    await assert.rejects(lstat(join(f.home, 'plugin')), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('packaging rejects symbolic links in parents of allowlisted assets', async () => {
  for (const directory of ['skills', 'dist/lib', 'assets']) {
    const f = await fixture();
    try {
      const target = join(f.root, 'linked');
      await rename(join(f.source, directory), target);
      await symlink(target, join(f.source, directory));
      await assert.rejects(assemblePlugin(f.source, f.home), /symbolic link/i, directory);
      await assert.rejects(lstat(join(f.home, 'plugin')), { code: 'ENOENT' });
    } finally {
      await rm(f.root, { recursive: true });
    }
  }
});

test('a modified published release cannot be reused under its original hash', async () => {
  const f = await fixture();
  try {
    const first = await assemblePlugin(f.source, f.home);
    await writeFile(join(first.release, 'dist/cli.js'), 'export const changed = true;');
    await assert.rejects(assemblePlugin(f.source, f.home), /differs from its identity/);
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('an existing unrelated plugin directory is preserved', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, 'plugin'));
    await writeFile(join(f.home, 'plugin/local-work.txt'), 'keep this');
    await assert.rejects(assemblePlugin(f.source, f.home), /not owned by this installer/);
    assert.equal(await readFile(join(f.home, 'plugin/local-work.txt'), 'utf8'), 'keep this');
  } finally {
    await rm(f.root, { recursive: true });
  }
});
