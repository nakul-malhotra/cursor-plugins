import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPlan, createPlan, readJournal } from '../lib/engine.js';
import { NotionError } from '../lib/errors.js';
import { object } from '../lib/values.js';
import { fixture, id, paragraph, parent, text } from './engine-fixture.js';

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof NotionError && error.code === expected;

test('move snapshots reuse freshly listed leaf blocks without individual GETs', async t => {
  for (const pageSize of [2, 100]) {
    const f = await fixture(); t.after(f.cleanup);
    f.server.pageSize = pageSize;
    f.server.page(50, 1, 'Document');
    const leaves = Array.from({ length: 50 }, (_, index) => id(1000 + index));
    for (let index = 0; index < leaves.length; index++) {
      f.server.block(1000 + index, 50, paragraph(`Leaf ${index}`));
    }
    const before = leaves.map(leaf => structuredClone(f.server.get(leaf)));
    f.server.requests = [];
    const plan = await createPlan(f.scope, f.home, [{
      kind: 'move-page', id: id(50), parent: { kind: 'page', id: id(3) },
    }]);
    const leafGets = () => f.server.requests.filter(request =>
      leaves.some(leaf => request === `GET /blocks/${leaf}`));
    assert.equal(leafGets().length, 0, 'listing already contains each leaf and its parent');
    assert.ok(f.server.requests.filter(request => request.startsWith(`GET /blocks/${id(50)}/children`)).length >= 2);
    f.server.requests = [];
    const result = await applyPlan(f.scope, f.home, plan.id);
    assert.equal(result.status, 'applied');
    assert.equal(leafGets().length, 0);
    assert.deepEqual(leaves.map(leaf => f.server.get(leaf)), before);
    assert.deepEqual(f.server.get(id(50)).parent, parent({ kind: 'page', id: id(3) }));
  }
});

test('apply checks the initial observation once immediately before the first write', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'update-page', id: id(2), patch: { icon: { type: 'emoji', emoji: 'X' } },
  }]);
  f.server.requests = [];
  let readsBeforeWrite = 0;
  f.server.onWrite = async () => {
    readsBeforeWrite = f.server.requests.filter(request => request === `GET /pages/${id(2)}`).length;
  };
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.equal(readsBeforeWrite, 1);
  assert.ok(f.server.requests.filter(request => request === `GET /pages/${id(2)}`).length > readsBeforeWrite);
});

test('three document moves and icons stay within a bounded request budget', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.server.pageSize = 100;
  const pageNumbers = [50, 51, 52];
  const leafCounts = [25, 50, 100];
  for (const [index, pageNumber] of pageNumbers.entries()) {
    f.server.page(pageNumber, 1, `Document ${index}`);
    for (let leaf = 0; leaf < (leafCounts[index] ?? 0); leaf++) {
      f.server.block(1000 + index * 100 + leaf, pageNumber, paragraph(`Leaf ${leaf}`));
    }
  }
  f.server.requests = [];
  const plan = await createPlan(f.scope, f.home, [
    ...pageNumbers.map(pageNumber => ({
      kind: 'move-page' as const, id: id(pageNumber), parent: { kind: 'page' as const, id: id(3) },
    })),
    ...pageNumbers.map(pageNumber => ({
      kind: 'update-page' as const, id: id(pageNumber), patch: { icon: { type: 'emoji', emoji: 'X' } },
    })),
  ]);
  assert.equal((await applyPlan(f.scope, f.home, plan.id)).status, 'applied');
  assert.equal(f.server.writes.length, 6);
  assert.ok(f.server.requests.length <= 400, `Expected at most 400 requests, got ${f.server.requests.length}`);
});

test('listing snapshots reject wrong parents, resource kinds, child flags and duplicate IDs', async t => {
  for (const defect of ['parent', 'kind', 'flag', 'duplicate']) {
    const f = await fixture(); t.after(f.cleanup);
    f.server.onRead = path => {
      if (path !== `/blocks/${id(3)}/children`) return undefined;
      const child = f.server.blockView(id(12));
      if (defect === 'parent') child.parent = parent({ kind: 'page', id: id(99) });
      if (defect === 'kind') child.object = 'page';
      if (defect === 'flag') delete child.has_children;
      return Response.json({
        object: 'list', results: defect === 'duplicate' ? [child, child] : [child],
        has_more: false, next_cursor: null,
      });
    };
    await assert.rejects(f.scope.children(id(3)), code('MALFORMED_RESPONSE'), defect);
    assert.equal(f.server.writes.length, 0);
  }
});

test('fresh listing snapshots still reject a leaf edit between plan and apply', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) },
  }]);
  f.server.get(id(11)).paragraph = { rich_text: text('Human edit') };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('STALE_PLAN'));
  assert.equal(f.server.writes.length, 0);
});

test('fresh listing snapshots still detect a corrupted leaf after a move', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'move-page', id: id(2), parent: { kind: 'page', id: id(3) },
  }]);
  f.server.afterWrite = () => {
    f.server.get(id(10)).to_do = { ...object(f.server.get(id(10)).to_do), checked: false };
  };
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('UNCERTAIN'));
  assert.equal(f.server.writes.length, 1);
  assert.equal((await readJournal(f.home, plan.id)).status, 'uncertain');
});

test('uncertain writes retain a typed cause without becoming retryable', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const plan = await createPlan(f.scope, f.home, [{
    kind: 'append-blocks', parentId: id(3), position: { type: 'start' }, children: [paragraph('Inserted')],
  }]);
  f.server.corruptAppend = true;
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), error =>
    error instanceof NotionError && error.code === 'UNCERTAIN' && error.details?.causeCode === 'READBACK_MISMATCH');
  const journal = await readJournal(f.home, plan.id);
  assert.equal(journal.error?.causeCode, 'READBACK_MISMATCH');
  await assert.rejects(applyPlan(f.scope, f.home, plan.id), code('RECONCILIATION_REQUIRED'));
  assert.equal(f.server.writes.length, 1);
});
