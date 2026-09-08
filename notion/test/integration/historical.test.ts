import assert from 'node:assert/strict';
import test from 'node:test';
import { NotionClient } from '../../lib/client.js';
import { applyPlan, createPlan } from '../../lib/engine.js';
import { inspect } from '../../lib/read.js';
import { ScopedNotion } from '../../lib/scope.js';
import { canonicalJson, object } from '../../lib/values.js';
import { FakeNotion, paragraph, text } from '../engine-fixture.js';
import { id, profile, profileHome } from '../helpers.js';

test('the Case Study page mention selects the exact page and correct placement is a no-op', async () => {
  const remote = new FakeNotion();
  remote.page(30, 1, 'Unit Economics Case Study');
  remote.page(31, 1, 'Pricing & Economics');
  remote.get(id(10)).to_do = {
    checked: true,
    rich_text: [
      ...text('unit economics based on olympic path'),
      { type: 'mention', mention: { type: 'page', page: { id: id(30) } } },
    ],
  };
  const f = await profileHome();
  const scope = new ScopedNotion(profile(), new NotionClient('synthetic', { fetch: remote.fetch, sleep: async () => {} }));
  try {
    const before = canonicalJson([...remote.resources.entries()]);
    const read = await inspect(scope, { kind: 'block', id: id(10) }, { depth: 0 });
    const reference = read.nodes[0]?.references[0];
    assert.deepEqual(reference, { kind: 'page', id: id(30) });
    assert.ok(reference);
    const plan = await createPlan(scope, f.home, [{ kind: 'move-page', id: reference.id, parent: { kind: 'page', id: id(1) } }]);
    assert.deepEqual(plan.noOps, [0]);
    assert.equal((await applyPlan(scope, f.home, plan.id)).status, 'applied');
    assert.equal(remote.writes.length, 0);
    assert.equal(canonicalJson([...remote.resources.entries()]), before);
  } finally {
    await f.cleanup();
  }
});

test('moving Partnership Options keeps its identity, contents and completed tasks intact', async () => {
  const remote = new FakeNotion();
  remote.page(40, 2, 'Partnership Options');
  remote.block(41, 40, paragraph('Partnership scenarios and proposal'));
  remote.block(42, 2, { type: 'to_do', to_do: { rich_text: text('approx market pitch + partner scenarios'), checked: true } });
  const f = await profileHome();
  const scope = new ScopedNotion(profile(), new NotionClient('synthetic', { fetch: remote.fetch, sleep: async () => {} }));
  try {
    const content = canonicalJson(remote.get(id(41)));
    const tasks = canonicalJson([remote.get(id(10)), remote.get(id(42))]);
    const plan = await createPlan(scope, f.home, [{ kind: 'move-page', id: id(40), parent: { kind: 'page', id: id(3) } }]);
    assert.equal((await applyPlan(scope, f.home, plan.id)).status, 'applied');
    assert.equal(remote.get(id(40)).id, id(40));
    assert.equal(object(remote.get(id(40)).parent).page_id, id(3));
    assert.equal(canonicalJson(remote.get(id(41))), content);
    assert.equal(canonicalJson([remote.get(id(10)), remote.get(id(42))]), tasks);
    assert.deepEqual(remote.writes.map(write => `${write.method} ${write.path}`), [`POST /pages/${id(40)}/move`]);
  } finally {
    await f.cleanup();
  }
});
