import assert from 'node:assert/strict';
import { chmod, link, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { NotionClient } from '../lib/client.js';
import { ScopedNotion } from '../lib/scope.js';
import type { JsonObject } from '../lib/types.js';
import { applyPlan, createPlan, readJournal, readPlan } from '../lib/engine.js';
import { parseOperations, stateFingerprint, type Operation } from '../lib/operations.js';
import { NotionError } from '../lib/errors.js';
import { acquireLock, writeState } from '../lib/journal.js';
import { fingerprint, object } from '../lib/values.js';
import { fixture, id, paragraph, parent, profile, text } from './engine-fixture.js';

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof NotionError && error.code === expected;

test('closed operation payloads reject unknown fields, secrets and raw mutation escapes', () => {
  for (const value of [
    [{ kind: 'request', path: '/pages', body: {} }],
    [{ kind: 'update-page', id: id(2), patch: { in_trash: true } }],
    [{ kind: 'update-page', id: id(2), patch: { parent: { page_id: id(99) } } }],
    [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('x')], after: id(12) }],
    [{ kind: 'append-blocks', parentId: id(3), children: [{ ...paragraph('x'), parent: { page_id: id(99) } }] }],
    [{ kind: 'append-blocks', parentId: id(3), children: [paragraph(`secret_${'s'.repeat(40)}`)] }],
    [{ kind: 'create-page', parent: { kind: 'page', id: id(3) }, properties: { token: { title: text('Synthetic non-secret value') } } }],
    [{ kind: 'update-page', id: id(2), patch: { properties: {} } }],
    [{ kind: 'update-block', id: id(10), patch: { to_do: {} } }],
  ]) assert.throws(() => parseOperations(value), code('INVALID_OPERATION'));
  assert.equal(parseOperations({ operations: [{ kind: 'archive-page', id: id(2) }] })[0]?.kind, 'archive-page');
});

test('selected credentials in remote property names or values never reach persisted plans', async t => {
  const credential = 'opaque-selected-credential';
  for (const location of ['property-name', 'value']) {
    const f = await fixture(); t.after(f.cleanup);
    const scope = new ScopedNotion(f.scope.profile, new NotionClient(credential, {
      fetch: f.server.fetch, minIntervalMs: 0,
    }));
    let operations: Operation[];
    if (location === 'property-name') {
      f.server.get(id(21)).properties = {
        ...object(f.server.get(id(21)).properties),
        [credential]: { id: 'private-name', type: 'rich_text', rich_text: {} },
      };
      operations = parseOperations([{ kind: 'update-data-source', id: id(21), patch: { description: text('Reviewed') } }]);
    } else {
      f.server.get(id(12)).paragraph = { rich_text: text(credential) };
      operations = parseOperations([{ kind: 'update-block', id: id(12), patch: { paragraph: { rich_text: text('Replacement') } } }]);
    }
    await assert.rejects(createPlan(scope, f.home, operations), code('CREDENTIAL_CONTENT'));
    assert.deepEqual(await readdir(join(f.home, '.state', 'plans')), []);
    assert.equal(f.server.writes.length, 0);
  }
});

test('generic credential-shaped object keys are refused by the private state writer', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(
    writeState(f.home, 'journals', id(77), { nested: { [`secret_${'s'.repeat(40)}`]: 'value' } }),
    code('INVALID_OPERATION'),
  );
});

test('apply refreshes connection identity even when the same scope was already verified', async t => {
  for (const replay of [false, true]) {
    const f = await fixture(); t.after(f.cleanup);
    const plan = await createPlan(f.scope, f.home, [{
      kind: 'append-blocks', parentId: id(3), children: [paragraph('One effect')],
    }]);
    if (replay) await applyPlan(f.scope, f.home, plan.id);
    const writes = f.server.writes.length;
    f.server.onRead = path => path === '/users/me'
      ? Response.json({ object: 'user', id: id(999), bot: { workspace_id: id(91) } })
      : undefined;
    await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('CONNECTION_MISMATCH'));
    assert.equal(f.server.writes.length, writes);
  }
});

test('a credential-bearing result stays out of a durably uncertain journal', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const credential = id(f.server.nextId);
  const scope = new ScopedNotion(f.scope.profile, new NotionClient(credential, {
    fetch: f.server.fetch, minIntervalMs: 0,
  }));
  const plan = await createPlan(scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), children: [paragraph('Created once')],
  }]);
  await assert.rejects(applyPlan(scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal(f.server.writes.length, 1);
  assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
  assert.ok(!(await readFile(join(f.home, '.state', 'journals', `${plan.id}.json`), 'utf8')).includes(credential));
});

test('exact mention ID is authorized even when a similarly titled sibling exists', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(99, null, 'Destination');
  await assert.rejects(createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), children: [{
      type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: id(99) } } }] },
    }],
  }]), /scope|root|outside/i);
  assert.equal(f.server.childObjects(id(3)).length, 1);
  assert.equal(f.server.writes.length, 0);
});

test('native move preserves identity, recursive content and checked tasks; identical move is a no-op', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const beforeTask = structuredClone(f.server.get(id(10)));
  const beforeNested = structuredClone(f.server.get(id(11)));
  const plan = await createPlan(f.scope, f.home, [{ kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) } }]);
  const result = await applyPlan(f.scope, f.home, plan.id);
  assert.equal(result.status, 'applied');
  assert.deepEqual(f.server.get(id(2)).parent, parent({ kind: 'page', id: id(3) }));
  assert.deepEqual(f.server.get(id(10)), beforeTask);
  assert.deepEqual(f.server.get(id(11)), beforeNested);
  assert.equal(f.server.writes[0]?.path, `/pages/${id(2)}/move`);
  assert.equal(f.server.writes[0]?.method, 'POST');
  assert.equal(f.server.childObjects(id(4)).length, 0);
  const noOp = await createPlan(f.scope, f.home, [{ kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) } }]);
  assert.deepEqual(noOp.noOps, [0]);
  await applyPlan(f.scope, f.home, noOp.id);
  assert.equal(f.server.writes.length, 1);
});

test('paginated append at start and after immediate anchor preserves exact nested children', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.block(13, 3, paragraph('Second'));
  f.server.block(14, 3, paragraph('Third'));
  const nested = { type: 'toggle', toggle: { rich_text: text('Group'), children: [paragraph('Nested new')] } };
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), position: { type: 'start' }, children: [nested] },
    { kind: 'append-blocks', parentId: id(3), position: { type: 'after_block', after_block: { id: id(12) } }, children: [paragraph('After anchor')] },
  ]);
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  const children = f.server.childObjects(id(3));
  assert.equal(children.length, 5);
  assert.equal(children[0]?.type, 'toggle');
  assert.equal(children[1]?.id, id(12));
  assert.deepEqual(object(children[2]?.paragraph).rich_text, text('After anchor'));
  assert.deepEqual(object(f.server.childObjects(String(children[0]?.id))[0]?.paragraph).rich_text, text('Nested new'));
  assert.ok(f.server.requests.some(path => path.includes('start_cursor=')));
  assert.deepEqual(f.server.writes[0]?.body.position, { type: 'start' });
  assert.equal(f.server.writes[0]?.body.after, undefined);
});

test('all stale sources, parents and anchors are refused before the first mutation', async t => {
  for (const change of ['source', 'parent', 'anchor']) {
    const f = await fixture(); t.after(f.cleanup);
    const plan = await createPlan(f.scope, f.home, [
      { kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) } },
      { kind: 'append-blocks', parentId: id(3), position: { type: 'after_block', after_block: { id: id(12) } }, children: [paragraph('New')] },
    ]);
    if (change === 'source') f.server.get(id(11)).paragraph = { rich_text: text('Human edit') };
    if (change === 'parent') f.server.get(id(3)).icon = { type: 'emoji', emoji: 'X' };
    if (change === 'anchor') f.server.get(id(12)).parent = parent({ kind: 'page', id: id(4) });
    await assert.rejects(applyPlan(f.scope, f.home, plan.id), code(change === 'anchor' ? 'MALFORMED_RESPONSE' : 'STALE_PLAN'));
    assert.equal(f.server.writes.length, 0);
    assert.equal((await readJournal(f.home, plan.id)).status, 'failed');
  }
});

test('cross-parent anchors and root archives cannot be approved', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), position: { type: 'after_block', after_block: { id: id(10) } }, children: [paragraph('Wrong')] }]), /anchor|child/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'archive-page', id: id(1) }]), /root|protected/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'archive-block', id: id(1) }]), /root|protected/i);
  assert.equal(f.server.writes.length, 0);
});

test('profile and root binding reject another bot scope in the same physical workspace', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('New')] }]);
  for (const p of [profile({ key: 'other' }), profile({ roots: [{ kind: 'page', id: id(3) }] }), profile({ credentialRef: 'other' })]) {
    const other = new ScopedNotion(p, f.scope.client);
    await assert.rejects(applyPlan(other, f.home, plan.id), code('SCOPE_MISMATCH'));
  }
  assert.equal(f.server.writes.length, 0);
});

test('planning refuses a mixed snapshot before saving any plan', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let changed = false;
  f.server.onRead = path => {
    if (!changed && path === `/blocks/${id(11)}`) {
      changed = true;
      f.server.get(id(12)).paragraph = { rich_text: text('Changed during planning') };
    }
    return undefined;
  };
  await assert.rejects(createPlan(f.scope, f.home, [
    { kind: 'update-block', id: id(12), patch: { paragraph: { rich_text: text('First edit') } } },
    { kind: 'update-block', id: id(11), patch: { paragraph: { rich_text: text('Second edit') } } },
  ]), code('STALE_PLAN'));
  assert.equal(changed, true);
  assert.deepEqual(await readdir(join(f.home, '.state', 'plans')), []);
  assert.equal(f.server.writes.length, 0);
});

test('engine operations in distinct profiles do not share a mutation lock', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const firstScope = new ScopedNotion(profile({ key: 'first', roots: [{ kind: 'page', id: id(2) }] }), f.scope.client);
  const secondScope = new ScopedNotion(profile({ key: 'second', roots: [{ kind: 'page', id: id(3) }] }), f.scope.client);
  const first = await createPlan(firstScope, f.home, [{ kind: 'append-blocks', parentId: id(2), children: [paragraph('First profile')] }]);
  const second = await createPlan(secondScope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Second profile')] }]);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  f.server.onWrite = async () => {
    if (f.server.writes.length === 1) { entered?.(); await paused; }
  };
  const running = applyPlan(firstScope, f.home, first.id);
  await writing;
  try {
    assert.equal((await applyPlan(secondScope, f.home, second.id)).status, 'applied');
    assert.equal(f.server.writes.length, 2);
  } finally {
    release?.();
    assert.equal((await running).status, 'applied');
  }
  assert.equal(f.server.childObjects(id(2)).length, 2);
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('per-scope lock prevents interleaving; completed replay never duplicates appends', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const op = { kind: 'append-blocks' as const, parentId: id(3), children: [paragraph('Once')] };
  const first = await createPlan(f.scope, f.home, [op]);
  const second = await createPlan(f.scope, f.home, [op]);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  f.server.onWrite = async () => { entered?.(); await paused; };
  const running = applyPlan(f.scope, f.home, first.id);
  await writing;
  await assert.rejects(applyPlan(f.scope, f.home, second.id), code('BUSY'));
  release?.();
  const result = await running;
  assert.equal(result.status, 'applied');
  assert.deepEqual(await applyPlan(f.scope, f.home, first.id), result);
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('ambiguous creation has a durable uncertain journal and never retries', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.uncertainWrite = 1;
  const plan = await createPlan(f.scope, f.home, [{ kind: 'create-page', parent: { kind: 'page', id: id(3) }, properties: { title: { title: text('Created once') } } }]);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  const journal = await readJournal(f.home, plan.id);
  assert.equal(journal.status, 'uncertain');
  assert.equal(journal.steps[0]?.status, 'uncertain');
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('RECONCILIATION_REQUIRED'));
  assert.equal(f.server.writes.length, 1);
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('definite second-step failure records partial progress and refuses replay', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.failWrite = 2;
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Applied')] },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Refused')] },
  ]);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id));
  const journal = await readJournal(f.home, plan.id);
  assert.equal(journal.status, 'partial');
  assert.equal(journal.steps[0]?.resultIds.length, 1);
  assert.equal(f.server.childObjects(id(3)).length, 2);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('RECONCILIATION_REQUIRED'));
  assert.equal(f.server.writes.length, 2);
});

test('human edits between steps are not absorbed into refreshed observations', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.afterWrite = count => {
    if (count === 1) f.server.get(id(12)).paragraph = { rich_text: text('Concurrent human edit') };
  };
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('First')] },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not happen')] },
  ]);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id));
  assert.equal(f.server.writes.length, 1);
  assert.notEqual((await readJournal(f.home, plan.id)).status, 'applied');
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('schema changes preserve old select colors and require exact deletion names plus approval', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'update-data-source', id: id(21), patch: { properties: { Retire: null } } }]), /delet|name|allow/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'update-data-source', id: id(21), patch: { properties: { Retire: null } }, allowDeleteProperties: ['retire'] }]), /delet|name|allow/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'update-data-source', id: id(21), patch: { properties: { State: { type: 'number', number: {} } } } }]), /type|destruct/i);
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'update-data-source', id: id(21), patch: { properties: {
      Retire: null, State: { select: { options: [{ name: 'Blocked', color: 'red' }] } },
    } }, allowDeleteProperties: ['Retire'],
  }]);
  assert.equal(plan.destructive, true);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('APPROVAL_REQUIRED'));
  await applyPlan(f.scope, f.home, plan.id, { approveDestructive: true });
  const properties = object(f.server.get(id(21)).properties);
  assert.equal(properties.Retire, undefined);
  assert.ok(properties.Name);
  assert.deepEqual(object(object(properties.State).select).options, [
    { id: 'pending', name: 'Pending', color: 'orange' },
    { id: 'done', name: 'Done', color: 'green' },
    { name: 'Blocked', color: 'red' },
  ]);
});

test('readback rejects false success for insertion position or moved task state', async t => {
  for (const kind of ['append', 'move']) {
    const f = await fixture(); t.after(f.cleanup);
    f.server.corruptAppend = kind === 'append';
    f.server.corruptMove = kind === 'move';
    const plan = await createPlan(f.scope, f.home, kind === 'append'
      ? [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('First')], position: { type: 'start' } }]
      : [{ kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) } }]);
    await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
    assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
  }
});

test('immutable private plans validate integrity, request keys and unsafe paths', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const ops = [{ kind: 'append-blocks' as const, parentId: id(3), children: [paragraph('Private')] }];
  const plan = await createPlan(f.scope, f.home, ops, { requestKey: 'stable-key' });
  const same = await createPlan(f.scope, f.home, ops, { requestKey: 'stable-key' });
  assert.equal(same.id, plan.id);
  await assert.rejects(createPlan(f.scope, f.home, [{ ...ops[0]!, children: [paragraph('Changed')] }], { requestKey: 'stable-key' }), code('REQUEST_KEY_MISMATCH'));
  const path = join(f.home, '.state', 'plans', `${plan.id}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, '.state', 'plans'))).mode & 0o777, 0o700);
  assert.deepEqual(await readPlan(f.home, plan.id), plan);
  await assert.rejects(readJournal(f.home, plan.id), code('JOURNAL_NOT_FOUND'));
  await assert.rejects(readPlan(f.home, '../outside'), code('INVALID_PLAN_ID'));
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('synthetic-token'), false);
  await writeFile(path, raw.replace('Private', 'Tampered'));
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('TAMPERED_STATE'));
  assert.equal(f.server.writes.length, 0);
});

test('unsafe state permissions and symlink plan files are rejected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('x')] }]);
  const path = join(f.home, '.state', 'plans', `${plan.id}.json`);
  await chmod(path, 0o644);
  await assert.rejects(readPlan(f.home, plan.id), /permission|private|mode/i);
  await chmod(path, 0o600);
  const otherId = id(999);
  await symlink(path, join(f.home, '.state', 'plans', `${otherId}.json`));
  await assert.rejects(readPlan(f.home, otherId), /symlink|symbolic/i);
  assert.equal((await readdir(join(f.home, '.state', 'plans'))).length, 2);
});

test('current API database creation, data-source page parents, updates and archives read back', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'create-database', parent: { kind: 'page', id: id(3) }, title: text('Created DB'), properties: { Name: { title: {} } } },
    { kind: 'create-page', parent: { kind: 'data_source', id: id(21) }, properties: { Name: { title: text('Row') } } },
    { kind: 'update-page', id: id(2), patch: { icon: { type: 'emoji', emoji: 'X' } } },
    { kind: 'update-block', id: id(10), patch: { to_do: { checked: false } } },
    { kind: 'update-database', id: id(20), patch: { title: text('Renamed') } },
    { kind: 'create-comment', parentId: id(2), richText: text('Reviewed') },
  ]);
  const journal = await applyPlan(f.scope, f.home, plan.id);
  assert.equal(journal.status, 'applied');
  assert.deepEqual(object(f.server.writes[0]?.body.initial_data_source).properties, { Name: { title: {} } });
  assert.deepEqual(object(f.server.writes[1]?.body.parent), { type: 'data_source_id', data_source_id: id(21) });
  assert.deepEqual(f.server.get(id(2)).icon, { type: 'emoji', emoji: 'X' });
  assert.equal(object(f.server.get(id(10)).to_do).checked, false);
  assert.equal(f.server.comments.size, 1);
  const archives = await createPlan(f.scope, f.home, [{ kind: 'archive-block', id: id(12) }, { kind: 'archive-page', id: id(4) }]);
  await applyPlan(f.scope, f.home, archives.id, { approveDestructive: true });
  assert.equal(f.server.get(id(12)).in_trash, true);
  assert.equal(f.server.get(id(4)).in_trash, true);
  assert.ok(f.server.writes.some(write => write.method === 'DELETE' && write.path === `/blocks/${id(12)}`));
  assert.deepEqual(f.server.writes.at(-1)?.body, { in_trash: true });
});

test('projected moves and schema extensions preserve previous steps rather than initial state', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) } },
    { kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(1) } },
    { kind: 'update-data-source', id: id(21), patch: { properties: { State: { select: { options: [{ name: 'Blocked', color: 'red' }] } } } } },
    { kind: 'update-data-source', id: id(21), patch: { properties: { State: { select: { options: [{ name: 'Review', color: 'blue' }] } } } } },
  ]);
  assert.deepEqual(plan.noOps, []);
  await applyPlan(f.scope, f.home, plan.id);
  assert.deepEqual(f.server.get(id(2)).parent, parent({ kind: 'page', id: id(1) }));
  assert.deepEqual(object(object(object(f.server.get(id(21)).properties).State).select).options, [
    { id: 'pending', name: 'Pending', color: 'orange' }, { id: 'done', name: 'Done', color: 'green' },
    { name: 'Blocked', color: 'red' }, { name: 'Review', color: 'blue' },
  ]);
});

test('nested children from an earlier append remain guarded against later human edits', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), children: [{ type: 'toggle', toggle: { rich_text: text('Group'), children: [paragraph('Nested')] } }] },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Second')] },
  ]);
  const original = f.server.fetch;
  let mutated = false;
  let nestedReads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const result = await original(input, init);
    if (f.server.writes.length === 1 && String(input).includes(id(101)) && (init?.method ?? 'GET') === 'GET') nestedReads += 1;
    if (nestedReads >= 3 && !mutated) {
      mutated = true;
      f.server.get(id(101)).paragraph = { rich_text: text('Human changed nested') };
    }
    return result;
  };
  const guarded = new ScopedNotion(f.scope.profile, new NotionClient('synthetic-token', { fetch, minIntervalMs: 0, maxAttempts: 1 }));
  await assert.rejects(applyPlan(guarded, f.home, plan.id));
  assert.equal(f.server.writes.length, 1);
});

test('running journals become uncertain without replaying and dead locks require explicit recovery', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Never restarted')] }]);
  await writeState(f.home, 'journals', plan.id, {
    version: 1, planId: plan.id, planDigest: plan.digest, workspace: plan.workspace,
    status: 'running', steps: [{ index: 0, status: 'attempting', resultIds: [], before: {} }], updatedAt: new Date().toISOString(),
  });
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('RECONCILIATION_REQUIRED'));
  assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
  const lockKey = fingerprint({ profileKey: f.scope.profile.key });
  const lockPath = join(f.home, '.state', 'locks', `${lockKey}.json`);
  await writeFile(lockPath, JSON.stringify({ owner: 'old', pid: 2147483647, planId: plan.id }), { mode: 0o600 });
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), error => code('BUSY')(error) && /dead|stale/i.test(String(error)));
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).owner, 'old');
  assert.equal(f.server.writes.length, 0);
});

test('lock release refuses replacement ownership and profiles have separate locks', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const release = await acquireLock(f.home, fingerprint({ profileKey: 'first' }), id(1));
  const otherRelease = await acquireLock(f.home, fingerprint({ profileKey: 'second' }), id(2));
  await otherRelease();
  const path = join(f.home, '.state', 'locks', `${fingerprint({ profileKey: 'first' })}.json`);
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, owner: 'replacement' }));
  await assert.rejects(release(), code('LOCK_LOST'));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).owner, 'replacement');
});

test('state hardlinks and symlink directories cannot redirect writes', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Private')] }]);
  await link(join(f.home, '.state', 'plans', `${plan.id}.json`), join(f.home, 'second-link'));
  await assert.rejects(readPlan(f.home, plan.id), /link|private/i);
  const g = await fixture(); t.after(g.cleanup);
  await symlink(f.home, join(g.home, '.state'));
  await assert.rejects(createPlan(g.scope, g.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Refused')] }]), /symlink/i);
  assert.equal(f.server.writes.length + g.server.writes.length, 0);
});

test('select recolors, implicit options and foreign relations are rejected before persistence', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(99, null, 'Outside');
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'update-data-source', id: id(21), patch: { properties: { State: { select: { options: [{ id: 'pending', name: 'Pending', color: 'red' }] } } } } }]), /color/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'create-page', parent: { kind: 'data_source', id: id(21) }, properties: { State: { select: { name: 'Unapproved implicit option' } } } }]), /implicit|option/i);
  await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'update-page', id: id(2), patch: { properties: { Related: { relation: [{ id: id(99) }] } } } }]), /scope|root/i);
  assert.equal(f.server.writes.length, 0);
});

test('successful but malformed mutation responses are uncertain, never definite failures', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.malformedWrite = 1;
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Committed')] }]);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('RECONCILIATION_REQUIRED'));
  assert.equal(f.server.childObjects(id(3)).length, 2);
  assert.equal(f.server.writes.length, 1);
});

test('a wrong mutation response ID remains uncertain even when target readback would match', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const scope = new ScopedNotion(f.scope.profile, new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: async (input, init) => {
      const response = await f.server.fetch(input, init);
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (init?.method === 'PATCH' && path === `/v1/blocks/${id(12)}`) {
        return Response.json({ ...object(await response.json()), id: id(10) });
      }
      return response;
    },
  }));
  const plan = await createPlan(scope, f.home, [{
    kind: 'update-block', id: id(12), patch: { paragraph: { rich_text: text('Committed edit') } },
  }]);
  await assert.rejects(applyPlan(scope, f.home, plan.id), code('UNCERTAIN'));
  const journal = await readJournal(f.home, plan.id);
  assert.equal(journal.status, 'uncertain');
  assert.deepEqual(journal.steps[0]?.resultIds, []);
  assert.deepEqual(object(f.server.get(id(12)).paragraph).rich_text, text('Committed edit'));
  assert.equal(f.server.writes.length, 1);
});

test('created resources do not absorb omitted mutable fields changed before readback', async t => {
  for (const kind of ['block', 'page']) {
    const f = await fixture(); t.after(f.cleanup);
    f.server.afterWrite = count => {
      if (count !== 1) return;
      if (kind === 'block') f.server.get(id(100)).paragraph = { rich_text: text('Created'), color: 'red' };
      else f.server.get(id(100)).icon = { type: 'emoji', emoji: 'X' };
    };
    const plan = await createPlan(f.scope, f.home, [
      ...(kind === 'block'
        ? [{ kind: 'append-blocks' as const, parentId: id(3), children: [paragraph('Created')] }]
        : [{ kind: 'create-page' as const, parent: { kind: 'page' as const, id: id(3) }, properties: { title: { title: text('Created') } } }]),
      { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not run')] },
    ]);
    await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
    assert.equal(f.server.writes.length, 1);
  }
});

test('page and database title updates propagate into their watched child wrappers', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.addToList(id(1), id(20));
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'update-page', id: id(2), patch: { properties: { title: { title: text('Renamed page') } } } },
    { kind: 'update-database', id: id(20), patch: { title: text('Renamed database') } },
    { kind: 'append-blocks', parentId: id(1), children: [paragraph('After renames')] },
  ]);
  await applyPlan(f.scope, f.home, plan.id);
  assert.equal(object(f.server.blockView(id(2)).child_page).title, 'Renamed page');
  assert.equal(object(f.server.blockView(id(20)).child_database).title, 'Renamed database');
});

for (const parentKind of ['page', 'workspace'] as const) {
  test(`root plain-page title updates do not read the enclosing ${parentKind} parent`, async t => {
    const f = await fixture(); t.after(f.cleanup);
    if (parentKind === 'workspace') f.server.get(id(2)).parent = { type: 'workspace', workspace: true };
    const scope = new ScopedNotion(profile({ roots: [{ kind: 'page', id: id(2) }] }), f.scope.client);
    const outsideBefore = structuredClone(f.server.get(id(1)));
    const childBefore = structuredClone(f.server.get(id(10)));
    const patch = { properties: { title: { title: text('Reviewed root title') } } };
    const plan = await createPlan(scope, f.home, [{ kind: 'update-page', id: id(2), patch }]);
    assert.ok(plan.observations.every(observation => observation.ref.id === id(2)));
    assert.equal(plan.destructive, false);
    assert.equal((await applyPlan(scope, f.home, plan.id)).status, 'applied');
    assert.deepEqual(object(object(f.server.get(id(2)).properties).title).title, text('Reviewed root title'));
    assert.deepEqual(f.server.get(id(1)), outsideBefore);
    assert.deepEqual(f.server.get(id(10)), childBefore);
    assert.deepEqual(f.server.writes, [{ path: `/pages/${id(2)}`, method: 'PATCH', body: patch }]);
    assert.equal(f.server.requests.some(path => path.includes(id(1))), false);
    assert.deepEqual(scope.profile.roots, [{ kind: 'page', id: id(2) }]);
  });
}

test('root title support retains title-only validation and denies surrounding pages', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const scope = new ScopedNotion(profile({ roots: [{ kind: 'page', id: id(2) }] }), f.scope.client);
  const before = structuredClone(f.server.get(id(2)));
  await assert.rejects(createPlan(scope, f.home, [{
    kind: 'update-page', id: id(2), patch: { properties: { Budget: { number: 100 } } },
  }]), code('INVALID_OPERATION'));
  assert.equal(f.server.requests.some(path => path.includes(id(1))), false);
  await assert.rejects(createPlan(scope, f.home, [{
    kind: 'update-page', id: id(3), patch: { properties: { title: { title: text('Outside root') } } },
  }]), code('OUT_OF_SCOPE'));
  assert.deepEqual(f.server.get(id(2)), before);
  assert.deepEqual(object(object(f.server.get(id(3)).properties).title).title, text('Destination'));
  assert.equal(f.server.writes.length, 0);
});

test('data-source row properties still require scoped schema reads and retain stale-schema guards', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(40, 1, 'Row');
  f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
  f.server.get(id(40)).properties = { Name: { type: 'title', title: text('Row') } };
  const rowOnly = new ScopedNotion(profile({ roots: [{ kind: 'page', id: id(40) }] }), f.scope.client);
  const update = { kind: 'update-page' as const, id: id(40), patch: { properties: { Name: { title: text('Updated row') } } } };
  await assert.rejects(createPlan(rowOnly, f.home, [update]), code('OUT_OF_SCOPE'));
  assert.ok(f.server.requests.includes(`GET /data_sources/${id(21)}`));
  await assert.rejects(createPlan(f.scope, f.home, [{
    kind: 'update-page', id: id(40), patch: { properties: { Name: { number: 100 } } },
  }]), code('INVALID_OPERATION'));
  const plan = await createPlan(f.scope, f.home, [update]);
  assert.ok(plan.observations.some(observation => observation.kind === 'resource'
    && observation.ref.kind === 'data_source' && observation.ref.id === id(21)));
  const schema = object(f.server.get(id(21)).properties);
  schema.State = { ...object(schema.State), name: 'Human schema change' };
  f.server.get(id(21)).properties = schema;
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('STALE_PLAN'));
  assert.equal((await readJournal(f.home, plan.id)).status, 'failed');
  assert.deepEqual(object(object(f.server.get(id(40)).properties).Name).title, text('Row'));
  assert.equal(f.server.writes.length, 0);
});

test('schema type inference permits creating then using a property within one reviewed plan', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'update-data-source', id: id(21), patch: { properties: { Priority: { select: { options: [{ name: 'High', color: 'red' }] } } } } },
    { kind: 'create-page', parent: { kind: 'data_source', id: id(21) }, properties: { Name: { title: text('New row') }, Priority: { select: { name: 'High' } } } },
  ]);
  await applyPlan(f.scope, f.home, plan.id);
  assert.deepEqual(object(object(f.server.get(id(100)).properties).Priority).select, { name: 'High' });
});

test('nested Notion IDs are normalized in parsed, persisted and submitted content', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const compact = id(2).replaceAll('-', '');
  const notionUrl = `https://www.notion.so/Source-${compact}`;
  const operations = parseOperations([{
    kind: 'append-blocks', parentId: id(3), children: [
      { type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: notionUrl } } }] } },
      { type: 'link_to_page', link_to_page: { type: 'page_id', page_id: compact } },
    ],
  }]);
  assert.equal(JSON.stringify(operations).includes(notionUrl), false);
  assert.equal(JSON.stringify(operations).includes(compact), false);
  const plan = await createPlan(f.scope, f.home, operations);
  await applyPlan(f.scope, f.home, plan.id);
  assert.equal(JSON.stringify((await readPlan(f.home, plan.id)).operations).includes(notionUrl), false);
  assert.equal(JSON.stringify(f.server.writes[0]?.body).includes(compact), false);
});

test('state persistence scans strict JSON and cannot invoke a toJSON credential injection', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let invoked = false;
  await assert.rejects(writeState(f.home, 'journals', id(500), {
    toJSON: () => { invoked = true; return { content: `secret_${'x'.repeat(40)}` }; },
  }));
  assert.equal(invoked, false);
  await assert.rejects(readJournal(f.home, id(500)), code('JOURNAL_NOT_FOUND'));
});

test('plan immutability and state authentication are independent of the public plan digest', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Authentic')] }]);
  await assert.rejects(writeState(f.home, 'plans', plan.id, { ...plan, summary: 'Replacement' }), /exist/i);
  assert.deepEqual(await readPlan(f.home, plan.id), plan);
  const path = join(f.home, '.state', 'plans', `${plan.id}.json`);
  const envelope = object(JSON.parse(await readFile(path, 'utf8')));
  const payload = object(envelope.payload);
  payload.summary = 'Attacker recomputed public digest';
  const unsigned = { ...payload };
  delete unsigned.digest;
  payload.digest = fingerprint(unsigned);
  envelope.payload = payload;
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(readPlan(f.home, plan.id), code('TAMPERED_STATE'));
  const journalId = id(700);
  await writeState(f.home, 'journals', journalId, {
    version: 1, planId: journalId, planDigest: plan.digest, workspace: plan.workspace,
    status: 'applied', steps: [], updatedAt: new Date().toISOString(),
  });
  const journalPath = join(f.home, '.state', 'journals', `${journalId}.json`);
  const journal = object(JSON.parse(await readFile(journalPath, 'utf8')));
  journal.signature = '0'.repeat(64);
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(readJournal(f.home, journalId), code('TAMPERED_STATE'));
});

test('data-source page creation verifies unrequested property defaults', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.afterWrite = count => {
    if (count === 1) {
      const properties = object(f.server.get(id(100)).properties);
      properties.Retire = { type: 'number', number: 42 };
      f.server.get(id(100)).properties = properties;
    }
  };
  const plan = await createPlan(f.scope, f.home, [{ kind: 'create-page', parent: { kind: 'data_source', id: id(21) }, properties: { Name: { title: text('Row') } } }]);
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
});

test('new database schema is checked exactly before any later operation', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'create-database', parent: { kind: 'page', id: id(3) }, title: text('Exact schema'), properties: { Name: { title: {} } } },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not run')] },
  ]);
  f.server.afterWrite = count => {
    if (count === 1) f.server.get(id(101)).properties = { Name: { title: {} }, Injected: { number: {} } };
  };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal(f.server.writes.length, 1);
});

test('successful mutation has a durable attempting record before the HTTP boundary', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('Journal first')] }]);
  f.server.onWrite = async () => {
    const journal = await readJournal(f.home, plan.id);
    assert.equal(journal.status, 'running');
    assert.equal(journal.steps.at(-1)?.status, 'attempting');
    assert.deepEqual(journal.steps.at(-1)?.resultIds, []);
    assert.ok(Object.keys(journal.steps.at(-1)?.before ?? {}).length > 0);
  };
  const journal = await applyPlan(f.scope, f.home, plan.id);
  assert.equal(journal.status, 'applied');
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('planner fingerprints ignore volatile metadata, preserve content and do not mutate input', () => {
  const original = {
    object: 'page', id: id(2), created_time: 'old', last_edited_time: 'old',
    created_by: { id: id(80) }, last_edited_by: { id: id(80) }, request_id: 'old',
    properties: { created_time: { type: 'title', title: text('User-named field') } },
    children: [{ ...paragraph('Original'), created_time: 'old', last_edited_by: { id: id(80) } }],
  };
  const unchanged = structuredClone(original);
  const updated = structuredClone(original);
  updated.created_time = 'new'; updated.last_edited_time = 'new';
  updated.created_by = { id: id(81) }; updated.last_edited_by = { id: id(81) }; updated.request_id = 'new';
  updated.children[0]!.created_time = 'new';
  updated.children[0]!.last_edited_by = { id: id(81) };
  assert.equal(stateFingerprint(original), stateFingerprint(updated));
  updated.properties.created_time.title = text('Meaningful edit');
  assert.notEqual(stateFingerprint(original), stateFingerprint(updated));
  assert.deepEqual(original, unchanged);
});

test('preconditions have a closed runtime shape and normalized IDs', () => {
  const condition = { kind: 'children', id: id(3), hash: stateFingerprint([]) };
  for (const malformed of [
    { ...condition, kind: 'request' }, { ...condition, hash: 'not-a-hash' },
    { ...condition, body: {} }, { ...condition, id: '../../outside' },
  ]) {
    assert.throws(() => parseOperations([{ kind: 'append-blocks', parentId: id(3), children: [paragraph('x')], preconditions: [malformed] }]), code('INVALID_OPERATION'));
  }
  const [operation] = parseOperations([{ kind: 'append-blocks', parentId: id(3), children: [paragraph('x')], preconditions: [{ ...condition, id: id(3).replaceAll('-', '') }] }]);
  assert.deepEqual(operation?.preconditions, [condition]);
});

test('planner resource and layout hashes reject edits between planning and createPlan without saving a plan', async t => {
  for (const kind of ['page', 'children', 'query'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const resourceId = kind === 'query' ? id(21) : id(3);
    const before = kind === 'page' ? await f.scope.read({ kind, id: resourceId })
      : kind === 'children' ? await f.scope.children(resourceId) : await f.scope.query(resourceId);
    if (kind === 'page') f.server.get(id(3)).icon = { type: 'emoji', emoji: 'X' };
    else if (kind === 'children') f.server.block(13, 3, paragraph('Human layout edit'));
    else {
      f.server.page(40, 1, 'Human row');
      f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
    }
    await assert.rejects(createPlan(f.scope, f.home, [{
      kind: 'append-blocks', parentId: id(3), position: { type: 'start' }, children: [paragraph('Stale proposal')],
      preconditions: [{ kind, id: resourceId, hash: stateFingerprint(before) }],
    }]), code('STALE_PLAN'));
    assert.deepEqual(await readdir(join(f.home, '.state', 'plans')), []);
    assert.equal(f.server.writes.length, 0);
  }
});

test('planner-only full query watches refuse row edits with unchanged membership at apply', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const n of [40, 41, 42]) {
    f.server.page(n, 1, `Row ${n}`);
    f.server.get(id(n)).parent = parent({ kind: 'data_source', id: id(21) });
  }
  const before = await f.scope.query(id(21));
  const condition = { kind: 'query' as const, id: id(21), hash: stateFingerprint(before) };
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), children: [paragraph('Blocked by row edit')], preconditions: [condition],
  }]);
  assert.deepEqual((await readPlan(f.home, plan.id)).operations[0]?.preconditions, [condition]);
  f.server.get(id(42)).properties = { title: { type: 'title', title: text('Human changed last page') } };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('STALE_PLAN'));
  assert.equal(f.server.writes.length, 0);
  assert.equal(before.length, 3);
});

test('planner-only resources and paginated children stay scoped and remain guarded until apply', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const n of [13, 14, 15]) f.server.block(n, 4, paragraph(`Sibling ${n}`));
  const before = await f.scope.children(id(4));
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), children: [paragraph('Guard sibling layout')],
    preconditions: [{ kind: 'children', id: id(4), hash: stateFingerprint(before) }],
  }]);
  f.server.get(id(15)).paragraph = { rich_text: text('Edited beyond first page') };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('STALE_PLAN'));
  assert.equal(f.server.writes.length, 0);
  f.server.page(99, null, 'Foreign');
  await assert.rejects(createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), children: [paragraph('Not authorized')],
    preconditions: [{ kind: 'page', id: id(99), hash: stateFingerprint(f.server.get(id(99))) }],
  }]), /scope|root/i);
});

test('planner children preconditions advance only by our successful appends', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const before = await f.scope.children(id(3));
  const preconditions = [{ kind: 'children' as const, id: id(3), hash: stateFingerprint(before) }];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), position: { type: 'start' }, children: [paragraph('First')], preconditions },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Second')], preconditions },
  ]);
  f.server.get(id(12)).last_edited_time = 'Metadata change is not a content conflict';
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.deepEqual(f.server.childObjects(id(3)).map(child => object(child.paragraph).rich_text), [text('First'), text('Anchor'), text('Second')]);
});

test('planner full query and resource observations advance through our page updates and creations', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(40, 1, 'Initial row');
  f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
  f.server.get(id(40)).properties = { Name: { type: 'title', title: text('Initial row') }, State: { type: 'select', select: { name: 'Pending' } }, Retire: { type: 'number', number: null } };
  const preconditions = [
    { kind: 'query' as const, id: id(21), hash: stateFingerprint(await f.scope.query(id(21))) },
    { kind: 'page' as const, id: id(40), hash: stateFingerprint(await f.scope.read({ kind: 'page', id: id(40) })) },
  ];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'update-page', id: id(40), patch: { properties: { State: { select: { name: 'Done' } } } }, preconditions },
    { kind: 'create-page', parent: { kind: 'data_source', id: id(21) }, properties: { Name: { title: text('Created row') } }, preconditions },
    { kind: 'update-page', id: id(40), patch: { properties: { Name: { title: text('Final row title') } } }, preconditions },
  ]);
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.equal((await f.scope.query(id(21))).length, 2);
  assert.deepEqual(object(object(f.server.get(id(40)).properties).State).select, { name: 'Done' });
  assert.deepEqual(object(object(f.server.get(id(40)).properties).Name).title, text('Final row title'));
});

test('planner-only human row edits after our first write are never adopted as expected state', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(40, 1, 'Observed row');
  f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
  const preconditions = [{ kind: 'query' as const, id: id(21), hash: stateFingerprint(await f.scope.query(id(21))) }];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('First')], preconditions },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not run')], preconditions },
  ]);
  f.server.afterWrite = count => {
    if (count === 1) f.server.get(id(40)).icon = { type: 'emoji', emoji: 'X' };
  };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal(f.server.writes.length, 1);
});

test('planner resource has_children changes reflect our appends rather than self-conflicting', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const preconditions = [
    { kind: 'block' as const, id: id(12), hash: stateFingerprint(await f.scope.read({ kind: 'block', id: id(12) })) },
    { kind: 'children' as const, id: id(3), hash: stateFingerprint(await f.scope.children(id(3))) },
  ];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'append-blocks', parentId: id(12), children: [paragraph('Nested first')], preconditions },
    { kind: 'append-blocks', parentId: id(12), children: [paragraph('Nested second')], preconditions },
  ]);
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.equal(f.server.get(id(12)).has_children, true);
  assert.equal(f.server.childObjects(id(12)).length, 2);
});

test('planner queries allow our edited row to change default position without losing other rows', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const n of [40, 41, 42]) {
    f.server.page(n, 1, `Row ${n}`);
    f.server.get(id(n)).parent = parent({ kind: 'data_source', id: id(21) });
    f.server.get(id(n)).properties = { Name: { type: 'title', title: text(`Row ${n}`) } };
  }
  const preconditions = [{ kind: 'query' as const, id: id(21), hash: stateFingerprint(await f.scope.query(id(21))) }];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'update-page', id: id(40), patch: { properties: { Name: { title: text('Edited 40') } } }, preconditions },
    { kind: 'update-page', id: id(41), patch: { properties: { Name: { title: text('Edited 41') } } }, preconditions },
  ]);
  f.server.afterWrite = count => {
    const editedId = count === 1 ? id(40) : id(41);
    const edited = f.server.get(editedId);
    f.server.resources.delete(editedId);
    f.server.resources.set(editedId, edited);
  };
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.deepEqual((await f.scope.query(id(21))).map(page => page.id), [id(42), id(40), id(41)]);
});

test('children and query preconditions cannot authorize foreign resources', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(99, null, 'Foreign root');
  f.server.resources.set(id(200), { object: 'database', id: id(200), parent: parent({ kind: 'page', id: id(99) }), title: text('Foreign DB') });
  f.server.resources.set(id(201), { object: 'data_source', id: id(201), parent: parent({ kind: 'database', id: id(200) }), properties: {} });
  for (const condition of [
    { kind: 'children' as const, id: id(99), hash: stateFingerprint([]) },
    { kind: 'query' as const, id: id(201), hash: stateFingerprint([]) },
  ]) {
    await assert.rejects(createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(3), children: [paragraph('No bypass')], preconditions: [condition] }]), /scope|root/i);
  }
  assert.deepEqual(await readdir(join(f.home, '.state', 'plans')), []);
  assert.equal(f.server.writes.length, 0);
});

test('planner archive readback reauthorizes the watched target through ScopedNotion', async t => {
  for (const kind of ['page', 'block'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const resourceId = kind === 'page' ? id(4) : id(12);
    const plan = await createPlan(f.scope, f.home, [{
      kind: kind === 'page' ? 'archive-page' : 'archive-block', id: resourceId,
      preconditions: [{ kind, id: resourceId, hash: stateFingerprint(await f.scope.read({ kind, id: resourceId })) }],
    }]);
    const journal = await applyPlan(f.scope, f.home, plan.id, { approveDestructive: true });
    const write = `${kind === 'page' ? 'PATCH /pages/' : 'DELETE /blocks/'}${resourceId}`;
    const requestIndex = f.server.requests.indexOf(write);
    const readbacks = f.server.requests.slice(requestIndex + 1);
    assert.ok(readbacks.filter(path => path === `GET /${kind === 'page' ? 'pages' : 'blocks'}/${resourceId}`).length >= 2);
    assert.ok(readbacks.includes(`GET /pages/${kind === 'page' ? id(1) : id(3)}`));
    assert.equal(f.server.get(resourceId).in_trash, true);
    assert.equal(journal.status, 'applied');
  }
});

test('planner fingerprints ignore rotating internal file signatures but retain asset and external URL changes', () => {
  const original = { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/asset.png?X-Amz-Signature=old', expiry_time: 'old' } };
  const rotated = { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/asset.png?X-Amz-Signature=new', expiry_time: 'new' } };
  assert.equal(stateFingerprint(original), stateFingerprint(rotated));
  assert.notEqual(stateFingerprint(original), stateFingerprint({ ...rotated, file: { ...rotated.file, url: rotated.file.url.replace('asset.png', 'other.png') } }));
  const external = { type: 'external', external: { url: 'https://example.com/image?version=1' } };
  assert.notEqual(stateFingerprint(external), stateFingerprint({ type: 'external', external: { url: 'https://example.com/image?version=2' } }));
});

test('planner fingerprints ignore generated self URLs while preserving URL properties and links', () => {
  const original = {
    object: 'page', id: id(40), url: `https://app.notion.com/p/Before-${id(40)}`,
    properties: { url: { type: 'url', url: 'https://example.com/one' } },
  };
  for (const object of ['page', 'database', 'data_source']) {
    const resource = { object, id: original.id, url: original.url };
    assert.equal(stateFingerprint(resource), stateFingerprint({ ...resource, url: `https://app.notion.com/p/After-${id(40)}` }));
  }
  assert.notEqual(stateFingerprint(original), stateFingerprint({
    ...original, properties: { url: { type: 'url', url: 'https://example.com/two' } },
  }));
  const linked = { type: 'text', text: { content: 'Link', link: { url: 'https://example.com/one' } } };
  assert.notEqual(stateFingerprint(linked), stateFingerprint({
    ...linked, text: { ...linked.text, link: { url: 'https://example.com/two' } },
  }));
});

test('generated page URLs and last-edited property values do not make our own query updates stale', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(40, 1, 'Generated metadata row');
  f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
  f.server.get(id(40)).properties = {
    Name: { type: 'title', title: text('Before') },
    Edited: { type: 'last_edited_time', last_edited_time: '2026-09-05T12:00:00Z' },
  };
  const beforeUrl = (await f.scope.read({ kind: 'page', id: id(40) })).url;
  const preconditions = [{ kind: 'query' as const, id: id(21), hash: stateFingerprint(await f.scope.query(id(21))) }];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'update-page', id: id(40), patch: { properties: { Name: { title: text('After') } } }, preconditions },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('After update')], preconditions },
  ]);
  f.server.afterWrite = count => {
    if (count === 1) {
      const properties = object(f.server.get(id(40)).properties);
      properties.Edited = { type: 'last_edited_time', last_edited_time: '2026-09-05T13:00:00Z' };
      f.server.get(id(40)).properties = properties;
    }
  };
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.notEqual((await f.scope.read({ kind: 'page', id: id(40) })).url, beforeUrl);
  assert.deepEqual(object(object(f.server.get(id(40)).properties).Name).title, text('After'));
  assert.equal(f.server.childObjects(id(3)).length, 2);
});

test('paragraph and date mention readbacks normalize nullable API defaults without changing requested dates', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const dates: JsonObject[] = [
    { start: '2026-09-06' },
    { start: '2026-09-06', end: null, time_zone: null },
    { start: '2026-09-06T09:00:00', end: '2026-09-06T10:00:00', time_zone: 'America/Vancouver' },
  ];
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), position: { type: 'start' },
    children: dates.map(date => ({
      type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'date', date } }] },
    })),
  }]);
  const journal = await applyPlan(f.scope, f.home, plan.id);
  assert.equal(journal.status, 'applied');
  assert.equal(f.server.childObjects(id(3)).length, 4);
  for (const [index, date] of dates.entries()) {
    const block = await f.scope.read({ kind: 'block', id: id(100 + index) });
    const content = object(block.paragraph);
    assert.equal(content.icon, null);
    assert.ok(Array.isArray(content.rich_text));
    assert.deepEqual(object(object(content.rich_text[0]).mention).date, { end: null, time_zone: null, ...date });
    assert.deepEqual(f.server.get(id(100 + index)).parent, parent({ kind: 'page', id: id(3) }));
  }
});

test('non-null paragraph icons and date range or timezone changes remain readback conflicts', async t => {
  for (const field of ['icon', 'end', 'time_zone']) {
    const f = await fixture(); t.after(f.cleanup);
    const plan = await createPlan(f.scope, f.home, [{
      kind: 'append-blocks', parentId: id(3), children: [{
        type: 'paragraph', paragraph: { rich_text: [
          { type: 'mention', mention: { type: 'date', date: { start: '2026-09-06' } } },
        ] },
      }],
    }]);
    f.server.afterWrite = () => {
      const content = object(f.server.get(id(100)).paragraph);
      if (field === 'icon') content.icon = { type: 'emoji', emoji: 'X' };
      else content.rich_text = [{
        type: 'mention', mention: { type: 'date', date: {
          start: '2026-09-06', [field]: field === 'end' ? '2026-09-07' : 'UTC',
        } },
      }];
      f.server.get(id(100)).paragraph = content;
    };
    await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
    assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
    assert.equal(f.server.childObjects(id(3)).length, 2);
  }
});

test('archived trees reconcile reviewed descendants, planner watches and later steps without child enumeration', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.page(30, 2, 'Nested page');
  f.server.block(31, 30, paragraph('Nested page content'));
  const taskBefore = structuredClone(f.server.get(id(10)).to_do);
  const textBefore = structuredClone(f.server.get(id(11)).paragraph);
  const preconditions = [
    { kind: 'children' as const, id: id(2), hash: stateFingerprint(await f.scope.children(id(2))) },
    { kind: 'children' as const, id: id(10), hash: stateFingerprint(await f.scope.children(id(10))) },
    { kind: 'block' as const, id: id(11), hash: stateFingerprint(await f.scope.read({ kind: 'block', id: id(11) })) },
  ];
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'archive-page', id: id(2), preconditions, watches: [{ ref: { kind: 'page', id: id(2) }, children: true }] },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('After archive')] },
  ]);
  const journal = await applyPlan(f.scope, f.home, plan.id, { approveDestructive: true });
  assert.equal(journal.status, 'applied');
  assert.deepEqual(journal.steps.map(step => step.status), ['applied', 'applied']);
  for (const n of [2, 10, 11, 30, 31]) assert.equal(f.server.get(id(n)).in_trash, true);
  assert.deepEqual(f.server.get(id(10)).to_do, taskBefore);
  assert.deepEqual(f.server.get(id(11)).paragraph, textBefore);
  assert.equal(f.server.childObjects(id(1)).some(child => child.id === id(2)), false);
  assert.equal(f.server.childObjects(id(3)).length, 2);
  const archivedAt = f.server.requests.indexOf(`PATCH /pages/${id(2)}`);
  const readbacks = f.server.requests.slice(archivedAt + 1);
  assert.ok(readbacks.includes(`GET /blocks/${id(11)}`));
  assert.equal(readbacks.some(path => path.startsWith(`GET /blocks/${id(2)}/children`)), false);
  await assert.rejects(f.scope.client.request(`/blocks/${id(2)}/children`), code('NOT_FOUND'));
  const persisted = await readJournal(f.home, plan.id);
  const limitations = object(persisted).limitations;
  assert.ok(Array.isArray(limitations));
  assert.match(limitations.join(' '), /not transactional/i);
  assert.match(limitations.join(' '), /unseen additions/i);
  assert.deepEqual(await applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), persisted);
  assert.equal(f.server.writes.length, 2);
});

test('database archive reconciliation requires positive block evidence when container metadata stays live', async t => {
  for (const defect of ['none', 'metadata-trashed', 'missing-block', 'not-trashed', 'wrong-kind', 'wrong-parent', 'wrong-title', 'source-not-trashed', 'metadata-title', 'row-text']) {
    const f = await fixture(); t.after(f.cleanup);
    const valid = defect === 'none' || defect === 'metadata-trashed';
    f.server.get(id(20)).parent = parent({ kind: 'page', id: id(2) });
    f.server.addToList(id(2), id(20));
    f.server.page(40, null, 'Database row');
    f.server.get(id(40)).parent = parent({ kind: 'data_source', id: id(21) });
    f.server.get(id(40)).properties = { Name: { type: 'title', title: text('Database row') } };
    f.server.onRead = path => {
      if (f.server.get(id(20)).in_trash !== true) return;
      if (path === `/databases/${id(20)}` && defect !== 'metadata-trashed') return Response.json({ ...f.server.get(id(20)), in_trash: false });
      if (path !== `/blocks/${id(20)}`) return;
      if (defect === 'missing-block') return Response.json({ code: 'object_not_found' }, { status: 404 });
      const block = f.server.blockView(id(20));
      if (defect === 'not-trashed') block.in_trash = false;
      if (defect === 'wrong-kind') {
        // Keep the old body to isolate the discriminator check on a malformed reply.
        block.type = 'paragraph';
        block.paragraph = { rich_text: text('Not a database block') };
      }
      if (defect === 'wrong-parent') block.parent = parent({ kind: 'page', id: id(3) });
      if (defect === 'wrong-title') block.child_database = { title: 'Unreviewed title' };
      return Response.json(block);
    };
    const plan = await createPlan(f.scope, f.home, [
      { kind: 'archive-page', id: id(2), preconditions: [
        { kind: 'database', id: id(20), hash: stateFingerprint(await f.scope.read({ kind: 'database', id: id(20) })) },
        // Negative controls must reach the engine's own proof, without a redundant block-list guard.
        ...(valid ? [{ kind: 'children' as const, id: id(2), hash: stateFingerprint(await f.scope.children(id(2))) }] : []),
      ] },
      { kind: 'append-blocks', parentId: id(3), children: [paragraph('After archive')] },
    ]);
    f.server.afterWrite = count => {
      if (count !== 1) return;
      if (defect === 'source-not-trashed') f.server.get(id(21)).in_trash = false;
      if (defect === 'metadata-title') f.server.get(id(20)).title = text('Unreviewed title');
      if (defect === 'row-text') f.server.get(id(40)).properties = { Name: { type: 'title', title: text('Unreviewed row') } };
    };
    if (valid) {
      assert.equal((await applyPlan(f.scope, f.home, plan.id, { approveDestructive: true })).status, 'applied');
      assert.equal(f.server.writes.length, 2);
      assert.equal((await f.scope.read({ kind: 'database', id: id(20) })).in_trash, defect === 'metadata-trashed');
      assert.equal((await f.scope.read({ kind: 'block', id: id(20) })).in_trash, true);
      assert.equal(f.server.get(id(21)).in_trash, true);
      assert.equal(f.server.get(id(40)).in_trash, true);
    } else {
      await assert.rejects(applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), code('UNCERTAIN'), defect);
      assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain', defect);
      assert.equal(f.server.writes.length, 1, defect);
    }
  }
});

test('archive readback rejects altered known descendants, missing IDs, trash failures and unrelated parent edits', async t => {
  for (const defect of ['text', 'checked', 'parent', 'missing', 'untrashed', 'sibling', 'live-membership']) {
    const f = await fixture(); t.after(f.cleanup);
    const plan = await createPlan(f.scope, f.home, [
      { kind: 'archive-page', id: id(2) },
      { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not run')] },
    ]);
    f.server.afterWrite = () => {
      if (defect === 'text') f.server.get(id(11)).paragraph = { rich_text: text('Unrelated edit') };
      if (defect === 'checked') f.server.get(id(10)).to_do = { ...object(f.server.get(id(10)).to_do), checked: false };
      if (defect === 'parent') f.server.get(id(11)).parent = parent({ kind: 'page', id: id(4) });
      if (defect === 'missing') f.server.resources.delete(id(11));
      if (defect === 'untrashed') f.server.get(id(11)).in_trash = false;
      if (defect === 'sibling') f.server.get(id(4)).properties = { title: { title: text('Unrelated rename') } };
      if (defect === 'live-membership') f.server.onRead = path => path === `/blocks/${id(1)}/children`
        ? Response.json({ object: 'list', results: [f.server.blockView(id(2)), ...f.server.childObjects(id(1))], has_more: false, next_cursor: null })
        : undefined;
    };
    await assert.rejects(applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), code('UNCERTAIN'), defect);
    assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain', defect);
    assert.equal(f.server.get(id(2)).in_trash, true);
    assert.equal(f.server.childObjects(id(3)).length, 1);
    assert.equal(f.server.writes.length, 1);
  }
});

test('archive reconciliation never treats forbidden, missing or disconnected descendant reads as confirmation', async t => {
  for (const failure of [403, 404, 'disconnect'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const plan = await createPlan(f.scope, f.home, [{ kind: 'archive-page', id: id(2) }]);
    f.server.afterWrite = () => {
      f.server.onRead = path => {
        if (path !== `/blocks/${id(11)}`) return undefined;
        if (failure === 'disconnect') throw new TypeError('Synthetic offline read');
        return Response.json({ code: failure === 403 ? 'restricted_resource' : 'object_not_found', message: 'Unavailable' }, { status: failure });
      };
    };
    await assert.rejects(applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), code('UNCERTAIN'));
    assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
    assert.equal(f.server.get(id(11)).in_trash, true);
    assert.equal(f.server.writes.length, 1);
    await assert.rejects(applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), code('RECONCILIATION_REQUIRED'));
  }
});

test('later steps still refuse human edits to previously reconciled archived descendants', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [
    { kind: 'archive-page', id: id(2) },
    { kind: 'append-blocks', parentId: id(3), children: [paragraph('Must not run')] },
  ]);
  f.server.onRead = async path => {
    if (path === `/pages/${id(2)}` && f.server.writes.length === 1
      && (await readJournal(f.home, plan.id)).steps[0]?.status === 'applied') {
      f.server.get(id(11)).paragraph = { rich_text: text('Human edit after readback') };
      f.server.onRead = undefined;
    }
    return undefined;
  };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id, { approveDestructive: true }), code('STALE_PLAN'));
  assert.equal(f.server.childObjects(id(3)).length, 1);
  assert.equal(f.server.writes.length, 1);
  assert.equal((await readJournal(f.home, plan.id)).status, 'partial');
});

test('block parents accept only classified wrong-kind or not-found page lookups', async t => {
  for (const failure of ['wrong-kind', 'not-found', 'validation', 'forbidden']) {
    const f = await fixture(); t.after(f.cleanup);
    f.server.block(49, 2, { type: 'column_list', column_list: {} });
    f.server.block(50, 49, { type: 'column', column: {} });
    if (failure !== 'wrong-kind') f.server.onRead = path => path === `/pages/${id(50)}`
      ? Response.json({
        code: failure === 'not-found' ? 'object_not_found' : 'validation_error',
        message: failure === 'validation' ? 'Unrelated invalid request' : `Provided ID ${id(50)} is a block, not a page. Use the retrieve block API instead`,
      }, { status: failure === 'not-found' ? 404 : failure === 'forbidden' ? 403 : 400 })
      : undefined;
    const planning = createPlan(f.scope, f.home, [{ kind: 'append-blocks', parentId: id(50), children: [paragraph('Inside column')] }]);
    if (failure === 'validation' || failure === 'forbidden') {
      await assert.rejects(planning, code(failure === 'forbidden' ? 'AUTH' : 'API_ERROR'));
      assert.equal(f.server.requests.includes(`GET /blocks/${id(50)}`), false);
      assert.equal(f.server.childObjects(id(50)).length, 0);
      assert.equal(f.server.writes.length, 0);
    } else {
      const plan = await planning;
      assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
      assert.deepEqual(f.server.childObjects(id(50)).map(child => object(child.paragraph).rich_text), [text('Inside column')]);
      assert.equal(f.server.writes[0]?.path, `/blocks/${id(50)}/children`);
    }
  }
});
