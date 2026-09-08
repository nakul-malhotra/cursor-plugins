import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assemblePlugin } from '../../lib/package.js';
import { profileHome } from '../helpers.js';

test('the installed package runs from another directory without runtime dependencies or copied credentials', async () => {
  const f = await profileHome();
  try {
    const installed = await assemblePlugin(process.cwd(), f.home);
    const invoke = (...args: string[]) => execFileSync(process.execPath, [join(installed.root, 'scripts/notion.mjs'), ...args], {
      cwd: f.home, env: { ...process.env, NOTION_HOME: f.home }, encoding: 'utf8',
    });
    assert.match(invoke('--help'), /Notion/);
    assert.match(invoke('workspaces'), /gantry/);
    assert.equal(JSON.parse(await readFile(join(installed.root, 'package.json'), 'utf8')).type, 'module');
    assert.deepEqual(await readdir(join(installed.root, 'scripts')), ['notion.mjs']);
    assert.deepEqual((await readdir(join(installed.root, 'skills'))).sort(), ['edit', 'gardening', 'todos']);
    assert.deepEqual(await readdir(join(installed.root, 'assets')), ['workspace.example.json']);
    await assert.rejects(lstat(join(installed.root, 'dist/lib/legacy.js')), { code: 'ENOENT' });
    for (const name of ['gardening', 'todos', 'edit']) {
      assert.match(await readFile(join(installed.root, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`name: ${name}`));
    }
    assert.doesNotMatch(invoke('profile', '--workspace', 'g'), /synthetic-gantry-token/);
  } finally {
    await f.cleanup();
  }
});
