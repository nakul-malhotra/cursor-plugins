import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../cli.js';
import { object, string } from '../../lib/values.js';
import { FakeNotion } from '../engine-fixture.js';
import { id, profile, profileHome } from '../helpers.js';

test('todo CLI plans, applies, replays and deduplicates through the actual HTTP and persistence boundaries', async () => {
  const remote = new FakeNotion();
  remote.page(30, 1, 'Todo fixture');
  const value = profile({
    todos: {
      kind: 'blocks', pageId: id(30), defaultOwner: 'nakul',
      containers: { nakul: { id: id(30), layout: 'dated' } }, logBuckets: [],
    },
  });
  const f = await profileHome([{ slug: 'gantry', value }]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await remote.fetch(input, init);
    const body = object(await response.json());
    return new Response(JSON.stringify({ ...body, request_id: randomUUID() }), {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  };
  async function invoke(args: string[]) {
    let stdout = '';
    let stderr = '';
    const code = await runCli(args, {
      home: f.home, fetch, sleep: async () => {},
      out: text => { stdout += text; }, err: text => { stderr += text; },
    });
    assert.equal(code, 0, stderr);
    return object(JSON.parse(stdout));
  }
  try {
    const file = join(f.home, 'request.json');
    await writeFile(file, JSON.stringify({ intent: 'plan', owner: 'nakul', date: '2026-09-06', items: [{ text: 'Review options' }] }), { mode: 0o600 });
    const planned = await invoke(['todos', 'plan', '--workspace', 'g', '--file', file]);
    assert.equal(remote.writes.length, 0);
    const planId = string(object(planned.plan).id);
    const applied = await invoke(['apply', planId, '--workspace', 'g']);
    assert.equal(object(applied.journal).status, 'applied');
    const added = remote.childObjects(id(30)).find(block => block.type === 'to_do');
    assert.ok(added);
    assert.equal(object(added.to_do).checked, false);
    const writes = remote.writes.length;
    await invoke(['apply', planId, '--workspace', 'g']);
    assert.equal(remote.writes.length, writes);
    const repeated = await invoke(['todos', 'plan', '--workspace', 'g', '--file', file]);
    assert.equal(repeated.status, 'no-op');
    assert.equal(remote.writes.length, writes);
    await writeFile(file, JSON.stringify({ intent: 'complete', id: added.id }), { mode: 0o600 });
    const completion = await invoke(['todos', 'plan', '--workspace', 'g', '--file', file]);
    await invoke(['apply', string(object(completion.plan).id), '--workspace', 'g']);
    assert.equal(object(remote.get(string(added.id)).to_do).checked, true);
  } finally {
    await f.cleanup();
  }
});
