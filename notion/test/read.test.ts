import assert from 'node:assert/strict';
import test from 'node:test';
import { gardenFindings, inspect, type ReadScope } from '../lib/read.js';
import type { JsonObject, ResourceRef } from '../lib/types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const page = (n: number, title: string): JsonObject => ({
  id: id(n), object: 'page', properties: { title: { type: 'title', title: [{ text: { content: title } }] } },
});
const root: ResourceRef = { kind: 'page', id: id(1) };

function fixture(children: JsonObject[], nested: Record<string, JsonObject[]> = {}): ReadScope {
  return {
    async read(ref) { return page(Number(ref.id.slice(-12)), 'Root'); },
    async children(parentId) { return parentId === root.id ? children : nested[parentId] ?? []; },
    async query() { return []; },
  };
}

test('inspection preserves date mentions, page-reference identity, and parent structure', async () => {
  const mention: JsonObject = {
    id: id(2), object: 'block', type: 'paragraph', has_children: false,
    paragraph: { rich_text: [
      { type: 'mention', mention: { type: 'date', date: { start: '2026-09-06' } } },
      { type: 'mention', mention: { type: 'page', page: { id: id(77) } }, plain_text: 'Unit Economics Case Study' },
    ] },
  };
  const result = await inspect(fixture([mention]), root, { depth: 1 });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.nodes[1]?.resource, mention);
  assert.deepEqual(result.nodes[1]?.parent, root);
  assert.deepEqual(result.nodes[1]?.references, [{ kind: 'page', id: id(77) }]);
});

test('inspection reports limits and read failures instead of claiming complete coverage', async () => {
  const children = [2, 3, 4].map(n => ({
    id: id(n), object: 'block', type: 'paragraph', has_children: true,
    paragraph: { rich_text: [{ text: { content: String(n) } }] },
  }));
  const limited = await inspect(fixture(children), root, { depth: 3, maxNodes: 2 });
  assert.equal(limited.nodes.length, 2);
  assert.equal(limited.status, 'partial');
  assert.ok(limited.gaps.some(gap => gap.reason === 'node-limit'));
  const failing: ReadScope = {
    ...fixture(children),
    async children(parentId) {
      if (parentId !== root.id) throw new Error('permission changed');
      return children;
    },
  };
  const partial = await inspect(failing, root, { depth: 2, maxNodes: 20 });
  assert.equal(partial.status, 'partial');
  assert.ok(partial.gaps.some(gap => gap.reason === 'read-error'));
});

test('gardening flags review candidates without treating duplicate titles as proven duplicates', async () => {
  const task: JsonObject = { id: id(2), object: 'block', type: 'to_do', has_children: true, to_do: { checked: true, rich_text: [] } };
  const one: JsonObject = { id: id(3), object: 'block', type: 'child_page', child_page: { title: 'Partnership Options' }, has_children: false };
  const two: JsonObject = { id: id(4), object: 'block', type: 'child_page', child_page: { title: 'Partnership Options' }, has_children: false };
  const result = await inspect(fixture([task], { [id(2)]: [one, two] }), root, { depth: 2 });
  const findings = gardenFindings(result);
  assert.ok(findings.some(finding => finding.kind === 'deliverable-under-task' && finding.ids.includes(id(3))));
  assert.ok(findings.some(finding => finding.kind === 'duplicate-title' && finding.ids.includes(id(4))));
  assert.ok(findings.every(finding => finding.confidence === 'candidate'));
  assert.equal(task.to_do && typeof task.to_do === 'object' && !Array.isArray(task.to_do) ? task.to_do.checked : undefined, true);
});

test('nested databases load their actual data-source metadata before traversal', async () => {
  const database: JsonObject = { id: id(8), object: 'block', type: 'child_database', child_database: { title: 'Tasks' }, has_children: false };
  const base = fixture([database]);
  const scope: ReadScope = {
    ...base,
    async read(ref) {
      if (ref.kind === 'database') return { id: id(8), object: 'database', title: [], data_sources: [{ id: id(9) }] };
      if (ref.kind === 'data_source') return { id: id(9), object: 'data_source', title: [] };
      return base.read(ref);
    },
  };
  const result = await inspect(scope, root, { depth: 3 });
  assert.ok(result.nodes.some(node => node.ref.kind === 'data_source' && node.ref.id === id(9)));
  assert.ok(!result.gaps.some(gap => gap.reason === 'read-error'));
});
