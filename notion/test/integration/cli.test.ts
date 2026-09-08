import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../cli.js';
import { fakeFetch, id, jsonResponse, profileHome } from '../helpers.js';

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: { out: (text: string) => { stdout += text; }, err: (text: string) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test('help and invalid commands work without loading private configuration', async () => {
  const help = output();
  assert.equal(await runCli(['--help'], { ...help.io, home: '/not-a-notion-home' }), 0);
  assert.match(help.stdout(), /garden/);
  assert.match(help.stdout(), /todos/);
  assert.match(help.stdout(), /apply/);
  const unknown = output();
  assert.equal(await runCli(['wipe-everything'], { ...unknown.io, home: '/not-a-notion-home' }), 2);
  assert.match(unknown.stderr(), /USAGE/);
});

test('workspace discovery does not require or expose a credential', async () => {
  const f = await profileHome();
  try {
    await rm(join(f.home, '.credentials.json'));
    const capture = output();
    assert.equal(await runCli(['workspaces'], { ...capture.io, home: f.home }), 0);
    assert.match(capture.stdout(), /gantry/);
    assert.doesNotMatch(capture.stdout(), /synthetic-gantry-token/);
  } finally {
    await f.cleanup();
  }
});

test('gardening is read-only through the HTTP boundary and output redacts credentials', async () => {
  const f = await profileHome();
  const writes: string[] = [];
  const remote = fakeFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${url.pathname}`);
    if (url.pathname === '/v1/users/me') return jsonResponse({ id: id(90), object: 'user', bot: { workspace_id: id(91) } });
    if (url.pathname === `/v1/pages/${id(1)}`) {
      return jsonResponse({ id: id(1), object: 'page', parent: { type: 'workspace', workspace: true }, properties: { title: { type: 'title', title: [{ text: { content: 'Synthetic page' } }] } } });
    }
    if (url.pathname === `/v1/blocks/${id(1)}/children`) {
      return jsonResponse({ object: 'list', has_more: false, next_cursor: null, results: [
        { id: id(2), object: 'block', type: 'paragraph', has_children: false, parent: { type: 'page_id', page_id: id(1) }, paragraph: { rich_text: [{ text: { content: 'synthetic-gantry-token' } }] } },
      ] });
    }
    return jsonResponse({ code: 'object_not_found', message: 'Fixture resource absent' }, 404);
  });

  try {
    const capture = output();
    const status = await runCli(['garden', '--workspace', 'g', '--id', id(1), '--depth', '1'], {
      ...capture.io, home: f.home, fetch: remote, sleep: async () => {},
    });
    assert.equal(status, 0, capture.stderr());
    assert.match(capture.stdout(), /findings/);
    assert.doesNotMatch(capture.stdout() + capture.stderr(), /synthetic-gantry-token/);
    assert.deepEqual(writes, []);
  } finally {
    await f.cleanup();
  }
});

test('todo validation explains the problem without exposing the selected credential', async () => {
  const f = await profileHome();
  try {
    const request = join(f.home, 'request.json');
    await writeFile(request, JSON.stringify({
      intent: 'plan', items: [{ text: 'A pending task' }], 'synthetic-gantry-token': true,
    }), { mode: 0o600 });
    const capture = output();
    const status = await runCli(['todos', 'plan', '--workspace', 'gantry', '--file', request], {
      ...capture.io, home: f.home,
      fetch: fakeFetch(() => assert.fail('Invalid requests must not reach Notion.')),
    });
    assert.equal(status, 1);
    assert.match(capture.stderr(), /TODO_VALIDATION/);
    assert.match(capture.stderr(), /Unknown todo request field/);
    assert.match(capture.stderr(), /REDACTED/);
    assert.doesNotMatch(capture.stdout() + capture.stderr(), /synthetic-gantry-token/);
  } finally {
    await f.cleanup();
  }
});

test('inspection read failures remain partial results with a failing exit code', async () => {
  const f = await profileHome();
  const remote = fakeFetch(url => {
    if (url.pathname === '/v1/users/me') return jsonResponse({ id: id(90), object: 'user', bot: { workspace_id: id(91) } });
    if (url.pathname === `/v1/pages/${id(1)}`) {
      return jsonResponse({ id: id(1), object: 'page', parent: { type: 'workspace', workspace: true }, properties: {} });
    }
    return jsonResponse({ code: 'restricted_resource', message: 'Fixture denies children' }, 403);
  });
  try {
    const capture = output();
    const status = await runCli(['inspect', '--workspace', 'g', '--id', id(1)], {
      ...capture.io, home: f.home, fetch: remote, sleep: async () => {},
    });
    assert.equal(status, 1);
    assert.match(capture.stdout(), /"ok": false/);
    assert.match(capture.stdout(), /read-error/);
    assert.match(capture.stdout(), /"status": "partial"/);
  } finally {
    await f.cleanup();
  }
});
