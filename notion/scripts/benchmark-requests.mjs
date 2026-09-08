#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';
import { applyPlan, createPlan } from '../dist/lib/engine.js';
import { fixture, id, paragraph, parent } from '../dist/test/engine-fixture.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function measure(server, run) {
  server.requests = [];
  server.writes = [];
  const started = performance.now();
  const value = await run();
  const syntheticMs = performance.now() - started;
  const counts = { getPage: 0, getBlock: 0, listChildren: 0, otherGet: 0, writes: 0 };
  for (const request of server.requests) {
    const [method, path] = request.split(' ');
    if (method !== 'GET') counts.writes++;
    else if (/^\/blocks\/[^/]+\/children(?:\?|$)/.test(path)) counts.listChildren++;
    else if (/^\/blocks\/[^/?]+$/.test(path)) counts.getBlock++;
    else if (/^\/pages\/[^/?]+$/.test(path)) counts.getPage++;
    else counts.otherGet++;
  }
  assert.equal(counts.writes, server.writes.length);
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), server.requests.length);
  return {
    value,
    metrics: {
      requests: server.requests.length,
      counts,
      syntheticMs,
      minimumSpacingMs: Math.max(0, server.requests.length - 1) * 350,
    },
  };
}

async function runScenario(name, pageSize) {
  const f = await fixture();
  try {
    f.server.pageSize = pageSize;
    const leafCounts = name === 'mixed' ? [25, 50, 100] : [50];
    const pageIds = [];
    const preserved = [];
    let nextId = 1000;
    for (const count of leafCounts) {
      const pageNumber = nextId++;
      f.server.page(pageNumber, 1, `Synthetic ${count}-leaf document`);
      pageIds.push(id(pageNumber));
      const groups = name === 'nested' ? 5 : 1;
      for (let group = 0; group < groups; group++) {
        let parentNumber = pageNumber;
        if (name === 'nested') {
          parentNumber = nextId++;
          f.server.block(parentNumber, pageNumber, paragraph('Nested group'));
        }
        for (let leaf = 0; leaf < count / groups; leaf++) {
          f.server.block(nextId++, parentNumber, paragraph(`Synthetic leaf ${leaf}`));
        }
      }
    }
    for (const resource of f.server.resources.values()) {
      if (resource.object === 'block') preserved.push(globalThis.structuredClone(resource));
    }
    const icons = ['X', 'Y', 'Z'];
    const operations = pageIds.map(pageId => ({
      kind: 'move-page', id: pageId, parent: { kind: 'page', id: id(3) },
    }));
    if (name === 'mixed') {
      operations.push(...pageIds.map((pageId, index) => ({
        kind: 'update-page', id: pageId, patch: { icon: { type: 'emoji', emoji: icons[index] } },
      })));
    }
    const planned = await measure(f.server, () => createPlan(f.scope, f.home, operations));
    const applied = await measure(f.server, () => applyPlan(f.scope, f.home, planned.value.id));
    assert.equal(applied.value.status, 'applied');
    assert.equal(applied.metrics.counts.writes, operations.length);
    for (const [index, pageId] of pageIds.entries()) {
      assert.deepEqual(f.server.get(pageId).parent, parent({ kind: 'page', id: id(3) }));
      if (name === 'mixed') assert.deepEqual(f.server.get(pageId).icon, { type: 'emoji', emoji: icons[index] });
    }
    assert.deepEqual(preserved.map(resource => f.server.get(resource.id)), preserved);
    return { name, pageSize, contentPreserved: true, createPlan: planned.metrics, applyPlan: applied.metrics };
  } finally {
    await f.cleanup();
  }
}

const scenarios = [];
for (const pageSize of [100, 2]) {
  for (const name of ['flat', 'nested', 'mixed']) scenarios.push(await runScenario(name, pageSize));
}
console.log(JSON.stringify({
  revision: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain').length > 0,
  note: 'Offline fake transport. Request counts are deterministic; syntheticMs is not live latency. minimumSpacingMs is only the 350ms/request spacing lower bound for an isolated phase.',
  scenarios,
}, null, 2));
