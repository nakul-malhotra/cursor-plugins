#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL, URL } from 'node:url';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' }, home: { type: 'string' },
    'confirm-isolated-writes': { type: 'boolean' }, database: { type: 'boolean' },
  },
  strict: true,
});
if (!values.workspace || !values['confirm-isolated-writes']) {
  throw new Error('Requires --workspace NAME --confirm-isolated-writes. Creates and archives one isolated test page.');
}
const home = values.home ?? process.env.NOTION_HOME ?? join(homedir(), '.copilot/notion');
const load = name => import(pathToFileURL(join(home, 'plugin/dist/lib', `${name}.js`)).href);
const { resolveProfile, readCredential } = await load('config');
const { NotionClient } = await load('client');
const { ScopedNotion } = await load('scope');
const { createPlan, applyPlan, readJournal } = await load('engine');
const { parseTodoRequest, planTodos } = await load('todos');
const { safeError } = await load('errors');
const { blockText, pageTitle } = await load('values');
const profile = await resolveProfile(home, values.workspace);
const token = await readCredential(home, profile.credentialRef);
const run = randomUUID();
const label = `Notion plugin isolated smoke ${run}`;
const record = { run, workspace: profile.key, marker: label, events: [], requests: [], dataSources: [], scratch: null, cleanup: 'pending' };
let activeStage;
await mkdir(join(home, '.state'), { recursive: true, mode: 0o700 });
const recordPath = join(home, '.state', `live-smoke-${run}.json`);
async function save() {
  await writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
}
const scope = new ScopedNotion(profile, new NotionClient(token, {
  async fetch(input, init) {
    const url = new URL(input instanceof globalThis.Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const readOnly = method === 'GET' || (method === 'POST' && (
      url.pathname === '/v1/search' || /^\/v1\/data_sources\/[^/]+\/query$/.test(url.pathname)
    ));
    const entry = { stage: activeStage, method, path: url.pathname, readOnly };
    record.requests.push(entry);
    if (!readOnly) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const parentId = body.parent?.page_id ?? body.parent?.data_source_id;
      const targetId = /^\/v1\/(?:pages|blocks|databases|data_sources)\/([^/]+)/.exec(url.pathname)?.[1];
      const initial = activeStage === 'create scratch' && method === 'POST' && url.pathname === '/v1/pages'
        && parentId === profile.roots.find(ref => ref.kind === 'page')?.id
        && body.properties?.title?.title?.[0]?.text?.content === label;
      const known = new Set([...record.dataSources, ...record.events.flatMap(event => event.resultIds)]);
      entry.parentId = parentId;
      entry.targetId = targetId;
      entry.allowed = initial || (
        (targetId !== undefined || parentId !== undefined)
        && (targetId === undefined || known.has(targetId))
        && (parentId === undefined || known.has(parentId))
      );
      await save();
      assert.ok(entry.allowed, 'Refusing a live test mutation outside known test resources.');
    }
    const response = await globalThis.fetch(input, init);
    entry.status = response.status;
    await save();
    return response;
  },
}));
async function execute(stage, operations, selected = scope) {
  activeStage = stage;
  const plan = await createPlan(selected, home, operations, { summary: `Isolated smoke: ${stage}` });
  const event = { stage, planId: plan.id, status: 'planned', resultIds: [] };
  record.events.push(event);
  await save();
  try {
    const journal = await applyPlan(selected, home, plan.id, { approveDestructive: true });
    assert.equal(journal.status, 'applied');
    event.status = journal.status;
    event.resultIds = journal.steps.flatMap(step => step.resultIds);
    await save();
    console.log(JSON.stringify({ stage, status: event.status }));
    return { plan, journal, ids: event.resultIds };
  } catch (error) {
    const journal = await readJournal(home, plan.id);
    event.status = journal.status;
    event.resultIds = journal.steps.flatMap(step => step.resultIds);
    await save();
    throw error;
  }
}
const rich = content => [{ type: 'text', text: { content } }];
const page = (parentId, title) => ({ kind: 'create-page', parent: { kind: 'page', id: parentId }, properties: { title: { title: rich(title) } } });
let failure;
try {
  const root = profile.roots.find(ref => ref.kind === 'page');
  assert.ok(root, 'A regular page root is required for isolated smoke testing.');
  const created = await execute('create scratch', [page(root.id, label)]);
  record.scratch = created.ids[0];
  await save();
  const scratch = record.scratch;
  assert.equal(pageTitle(await scope.read({ kind: 'page', id: scratch })), label);
  await applyPlan(scope, home, created.plan.id);
  const replayChildren = await scope.children(root.id);
  assert.deepEqual(replayChildren.filter(block => block.type === 'child_page' && block.child_page.title === label).map(block => block.id), [scratch]);
  const logBuckets = profile.todos?.kind === 'blocks' ? profile.todos.logBuckets : [];
  const todoScope = new ScopedNotion({
    ...profile,
    todos: {
      kind: 'blocks', pageId: scratch, defaultOwner: 'tester',
      containers: { tester: { id: scratch, layout: 'dated', dateOrder: 'descending' } },
      logBuckets,
    },
  }, scope.client);
  const todoRequest = { intent: 'plan', owner: 'tester', date: '2026-09-06', items: [{ text: `Pending ${run}` }] };
  await execute('plan unchecked task', await planTodos(todoScope, parseTodoRequest(todoRequest)), todoScope);
  assert.equal((await planTodos(todoScope, parseTodoRequest(todoRequest))).length, 0);
  let blocks = await scope.children(scratch);
  assert.ok(blocks.some(block => block.type === 'paragraph' && block.paragraph.rich_text.some(part =>
    part.type === 'mention' && part.mention?.type === 'date' && part.mention.date.start === '2026-09-06')));
  const task = blocks.find(block => block.type === 'to_do' && blockText(block) === `Pending ${run}`);
  assert.ok(task);
  assert.equal(task.to_do.checked, false);
  const bucketName = logBuckets[0];
  const shipped = `Shipped ${run}`;
  await execute('log checked work', await planTodos(todoScope, parseTodoRequest({
    intent: 'log', owner: 'tester', date: '2026-09-06',
    items: [bucketName ? { text: bucketName, subitems: [shipped] } : { text: shipped }],
  })), todoScope);
  blocks = await scope.children(scratch);
  const bucket = blocks.find(block => block.type === 'to_do' && blockText(block) === (bucketName ?? shipped));
  assert.ok(bucket);
  assert.equal(bucket.to_do.checked, true);
  if (bucketName) assert.equal((await scope.children(bucket.id))[0].to_do.checked, true);
  else assert.equal(bucket.has_children, false);
  assert.equal((await scope.read({ kind: 'block', id: task.id })).to_do.checked, false);
  await execute('complete exact task', await planTodos(todoScope, parseTodoRequest({ intent: 'complete', id: task.id })), todoScope);
  assert.equal((await scope.read({ kind: 'block', id: task.id })).to_do.checked, true);
  const destination = (await execute('create destination', [page(scratch, `Destination ${run}`)])).ids[0];
  const document = (await execute('create document', [{
    ...page(scratch, `Document ${run}`),
    children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(`Preserved document body ${run}`) } }],
  }])).ids[0];
  const beforeMove = (await scope.children(document)).map(block => ({ id: block.id, text: blockText(block) }));
  assert.equal(beforeMove.length, 1);
  await execute('native page move', [{ kind: 'move-page', id: document, parent: { kind: 'page', id: destination } }]);
  const moved = await scope.read({ kind: 'page', id: document });
  assert.equal(moved.parent.page_id, destination);
  assert.equal(pageTitle(moved), `Document ${run}`);
  assert.deepEqual((await scope.children(document)).map(block => ({ id: block.id, text: blockText(block) })), beforeMove);
  if (values.database) {
    const database = (await execute('create database', [{
      kind: 'create-database', parent: { kind: 'page', id: scratch }, title: rich(`Tasks ${run}`),
      properties: {
        Name: { title: {} },
        State: { select: { options: [{ name: 'Pending', color: 'orange' }, { name: 'Done', color: 'green' }] } },
      },
    }])).ids[0];
    const sourceId = (await scope.read({ kind: 'database', id: database })).data_sources[0].id;
    record.dataSources.push(sourceId);
    await save();
    const databaseScope = new ScopedNotion({
      ...profile,
      todos: {
        kind: 'database', dataSourceId: sourceId, titleProperty: 'Name', statusProperty: 'State',
        statusType: 'select', pendingValue: 'Pending', doneValue: 'Done', owners: {},
      },
    }, scope.client);
    await execute('database backlog', await planTodos(databaseScope, parseTodoRequest({
      intent: 'backlog', items: [{ text: `Database task ${run}` }],
    })), databaseScope);
    const row = (await scope.query(sourceId)).find(item => pageTitle(item) === `Database task ${run}`);
    assert.ok(row);
    assert.equal(row.properties.State.select.name, 'Pending');
    await execute('database task rename', await planTodos(databaseScope, parseTodoRequest({
      intent: 'update', id: row.id, text: `Edited database task ${run}`,
    })), databaseScope);
    assert.equal(pageTitle(await scope.read({ kind: 'page', id: row.id })), `Edited database task ${run}`);
    await execute('database completion', await planTodos(databaseScope, parseTodoRequest({ intent: 'complete', id: row.id })), databaseScope);
    assert.equal((await scope.read({ kind: 'page', id: row.id })).properties.State.select.name, 'Done');
    await execute('preserve select colors', [{
      kind: 'update-data-source', id: sourceId,
      patch: { properties: { State: { select: { options: [{ name: 'Deferred', color: 'blue' }] } } } },
    }]);
    const options = (await scope.read({ kind: 'data_source', id: sourceId })).properties.State.select.options;
    assert.equal(options.find(option => option.name === 'Pending').color, 'orange');
    assert.equal(options.find(option => option.name === 'Done').color, 'green');
    assert.equal(options.find(option => option.name === 'Deferred').color, 'blue');
  }
  record.status = 'passed';
} catch (error) {
  failure = error;
  record.status = 'failed';
  record.error = safeError(error, [token]);
} finally {
  record.scratch ??= record.events.find(event => event.stage === 'create scratch')?.resultIds[0] ?? null;
  if (record.scratch) {
    try {
      const scratch = await scope.read({ kind: 'page', id: record.scratch });
      assert.equal(pageTitle(scratch), label, 'Refusing cleanup of a page without this run marker.');
      await execute('archive scratch', [{ kind: 'archive-page', id: record.scratch }]);
      assert.equal((await scope.read({ kind: 'page', id: record.scratch })).in_trash, true);
      record.cleanup = 'archived';
    } catch (error) {
      record.cleanup = 'failed';
      record.cleanupError = safeError(error, [token]);
      failure ??= error;
    }
  } else {
    record.cleanup = 'no-known-page';
  }
  await save();
}
console.log(JSON.stringify({ ok: !failure, workspace: profile.key, status: record.status, cleanup: record.cleanup, recordPath, error: record.error, cleanupError: record.cleanupError }, null, 2));
if (failure) process.exitCode = 1;
