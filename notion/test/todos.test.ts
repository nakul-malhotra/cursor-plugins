import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOperations, stateFingerprint } from '../lib/operations.js';
import {
  listTodos,
  parseTodoRequest,
  planTodos,
  resolveDate,
  type TodoRequest,
  type TodoScope,
} from '../lib/todos.js';
import type {
  BlockTodoProfile,
  DatabaseTodoProfile,
  JsonObject,
  Profile,
  ResourceRef,
} from '../lib/types.js';
import { id, profile } from './helpers.js';

function record(value: unknown, label = 'value'): JsonObject {
  assert.ok(isJsonObject(value), `${label} must be an object`);
  return value;
}

function records(value: unknown, label = 'value'): JsonObject[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function block(
  blockId: string,
  type: string,
  value: JsonObject,
  parentId = id(1),
  hasChildren = false,
): JsonObject {
  return {
    object: 'block',
    id: blockId,
    parent: { type: 'block_id', block_id: parentId },
    type,
    has_children: hasChildren,
    [type]: value,
  };
}

function paragraph(blockId: string, text: string, parentId = id(1)): JsonObject {
  return block(blockId, 'paragraph', {
    rich_text: [{ type: 'text', text: { content: text }, plain_text: text }],
  }, parentId);
}

function heading3(blockId: string, text: string, parentId = id(1)): JsonObject {
  return block(blockId, 'heading_3', {
    rich_text: [{ type: 'text', text: { content: text }, plain_text: text }],
  }, parentId);
}

function dateHeading(blockId: string, date: string, parentId = id(1)): JsonObject {
  return block(blockId, 'paragraph', {
    rich_text: [{
      type: 'mention',
      mention: { type: 'date', date: { start: date } },
      plain_text: 'Formatted date',
    }],
  }, parentId);
}

function todo(
  blockId: string,
  text: string,
  checked: boolean,
  parentId = id(1),
  hasChildren = false,
): JsonObject {
  return block(blockId, 'to_do', {
    rich_text: [{ type: 'text', text: { content: text }, plain_text: text }],
    checked,
  }, parentId, hasChildren);
}

function blockProfile(todos: BlockTodoProfile): Profile {
  return profile({ todos });
}

function databaseProfile(todos: DatabaseTodoProfile): Profile {
  return profile({ todos });
}

function fixture(
  profileValue: Profile,
  childrenById: Record<string, JsonObject[]>,
  resources: Record<string, JsonObject> = {},
  rows: JsonObject[] = [],
): TodoScope {
  return {
    profile: profileValue,
    async read(ref: ResourceRef) {
      const resource = resources[ref.id];
      if (resource === undefined) {
        throw new Error(`Missing synthetic resource ${ref.kind}:${ref.id}`);
      }
      return resource;
    },
    async children(parentId: string) {
      return childrenById[parentId] ?? [];
    },
    async query() {
      return rows;
    },
  };
}

function appendChildren(operation: unknown): JsonObject[] {
  return records(record(operation, 'operation').children, 'operation.children');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function todoChecked(value: JsonObject): boolean | undefined {
  const body = value.to_do;
  return isJsonObject(body) && typeof body.checked === 'boolean'
    ? body.checked
    : undefined;
}

function textContent(value: JsonObject): string | undefined {
  const body = value.to_do ?? value.paragraph;
  if (!isJsonObject(body)) return undefined;
  const richText = body.rich_text;
  if (!Array.isArray(richText)) return undefined;
  const first = richText[0];
  if (!isJsonObject(first)) return undefined;
  const text = first.text;
  if (!isJsonObject(text)) return undefined;
  return typeof text.content === 'string' ? text.content : undefined;
}

test('request parsing is closed and keeps collection intents distinct from exact-ID updates', () => {
  assert.deepEqual(parseTodoRequest({
    intent: 'plan',
    owner: ' Nakul ',
    items: [{ text: ' Ship allocation ', subitems: [' Check totals '] }],
  }), {
    intent: 'plan',
    owner: 'Nakul',
    items: [{ text: 'Ship allocation', subitems: ['Check totals'] }],
  });
  assert.deepEqual(parseTodoRequest({ intent: 'complete', id: id(10) }), {
    intent: 'complete',
    id: id(10),
  });
  assert.throws(
    () => parseTodoRequest({ intent: 'plan', items: [], completedDeliverable: true }),
    /unknown|completedDeliverable/i,
  );
  assert.throws(() => parseTodoRequest({ intent: 'backlog', items: [] }), /items/i);
  assert.throws(() => parseTodoRequest({ intent: 'complete', text: 'Task title' }), /id/i);
  assert.throws(() => parseTodoRequest({ intent: 'update', id: id(10) }), /text|checked/i);
  assert.throws(
    () => parseTodoRequest({ intent: 'plan', allowSimilar: 'yes', items: [{ text: 'Task' }] }),
    /Unknown.*allowSimilar/i,
  );
  assert.throws(
    () => parseTodoRequest({ intent: 'complete', id: id(10), allowSimilar: true }),
    /complete.*allowSimilar|allowSimilar/i,
  );
  assert.throws(
    () => parseTodoRequest({ intent: 'plan', id: id(10), items: [{ text: 'Task' }] }),
    /id|intent/i,
  );
  assert.throws(
    () => parseTodoRequest({
      intent: 'plan',
      items: [{ text: 'x'.repeat(2001) }],
    }),
    /2000|rich-text/i,
  );
});

test('relative dates use the profile timezone and impossible dates are rejected', () => {
  const boundary = new Date('2026-09-06T06:30:00.000Z');
  assert.equal(resolveDate(undefined, 'America/Vancouver', boundary), '2026-09-05');
  assert.equal(resolveDate('today', 'America/Vancouver', boundary), '2026-09-05');
  assert.equal(resolveDate('tomorrow', 'America/Vancouver', boundary), '2026-09-06');
  assert.equal(resolveDate('2028-02-29', 'America/Vancouver', boundary), '2028-02-29');
  assert.throws(() => resolveDate('2026-02-30', 'America/Vancouver', boundary), /date/i);
});

test('dated plans create date mentions in chronological position and remain unchecked', async () => {
  const containerId = id(10);
  const firstDate = dateHeading(id(11), '2026-09-06', containerId);
  const firstTask = todo(id(12), 'Already planned', false, containerId);
  const separator = paragraph(id(13), '', containerId);
  const olderDate = dateHeading(id(14), '2026-09-04', containerId);
  const scope = fixture(
    blockProfile({
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: {
        Nakul: { id: containerId, layout: 'dated', dateOrder: 'descending' },
      },
      logBuckets: [],
    }),
    { [containerId]: [firstDate, firstTask, separator, olderDate] },
  );

  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    owner: 'Nakul',
    date: '2026-09-05',
    items: [{ text: 'Backfill the middle date' }],
  }));
  assert.equal(operations.length, 1);
  const operation = record(operations[0]);
  assert.deepEqual(operation.position, {
    type: 'after_block',
    after_block: { id: id(13) },
  });
  const children = appendChildren(operation);
  const heading = children[0] ?? {};
  assert.equal(heading.type, 'paragraph');
  const paragraphBody = record(heading.paragraph, 'heading.paragraph');
  const richText = records(paragraphBody.rich_text, 'heading rich text');
  assert.deepEqual(richText[0]?.mention, {
    type: 'date',
    date: { start: '2026-09-05' },
  });
  assert.equal(todoChecked(children[1] ?? {}), false);

  const newest = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    owner: 'Nakul',
    date: '2026-09-07',
    items: [{ text: 'Newest date starts the container' }],
  }));
  assert.deepEqual(record(newest[0]).position, { type: 'start' });
});

test('late exact matches are no-ops and do not reset an existing checked task', async () => {
  const containerId = id(20);
  const filler = Array.from({ length: 100 }, (_, index) =>
    paragraph(id(100 + index), `filler ${index}`, containerId));
  const heading = paragraph(id(220), '2026-09-05', containerId);
  const existing = todo(id(221), 'Keep the completed state', true, containerId);
  const scope = fixture(
    blockProfile({
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: { Nakul: { id: containerId, layout: 'dated' } },
      logBuckets: [],
    }),
    { [containerId]: [...filler, heading, existing] },
  );
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    date: '2026-09-05',
    items: [{ text: 'Keep the completed state' }],
  }));
  assert.deepEqual(operations, []);
  assert.equal(todoChecked(existing), true);

  const nearMatch = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    date: '2026-09-05',
    items: [{ text: 'keep the completed state' }],
  }));
  assert.equal(nearMatch.length, 1);
  assert.equal(textContent(appendChildren(nearMatch[0])[0] ?? {}), 'keep the completed state');
  assert.equal(todoChecked(appendChildren(nearMatch[0])[0] ?? {}), false);

  const spacingMatch = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    date: '2026-09-05',
    items: [{ text: 'Keep  the completed state' }],
  }));
  assert.equal(spacingMatch.length, 1);
});

test('grouped logs grow one existing bucket and become no-ops once represented', async () => {
  const containerId = id(30);
  const bucketId = id(32);
  const profileValue = blockProfile({
    kind: 'blocks',
    pageId: id(1),
    defaultOwner: 'Nakul',
    containers: { Nakul: { id: containerId, layout: 'dated' } },
    logBuckets: ['product updates', 'infra updates'],
  });
  const childrenById = {
    [containerId]: [
      dateHeading(id(31), '2026-09-05', containerId),
      todo(bucketId, 'infra updates', true, containerId, true),
    ],
    [bucketId]: [todo(id(33), 'Existing release', true, bucketId)],
  };
  const scope = fixture(profileValue, childrenById);
  const request = parseTodoRequest({
    intent: 'log',
    date: '2026-09-05',
    items: [{
      text: 'infra updates',
      subitems: ['Existing release', 'Added state fingerprints'],
    }],
  });
  const operations = await planTodos(scope, request);
  assert.equal(operations.length, 1);
  const operation = record(operations[0]);
  assert.equal(operation.parentId, bucketId);
  const children = appendChildren(operation);
  assert.equal(children.length, 1);
  assert.equal(textContent(children[0] ?? {}), 'Added state fingerprints');
  assert.equal(todoChecked(children[0] ?? {}), true);
  assert.ok(records(operation.preconditions, 'preconditions').some(item =>
    item.kind === 'children' && item.id === bucketId));

  childrenById[bucketId]?.push(todo(id(34), 'Added state fingerprints', true, bucketId));
  assert.deepEqual(await planTodos(scope, request), []);
  await assert.rejects(
    planTodos(scope, parseTodoRequest({
      intent: 'log',
      date: '2026-09-05',
      items: [{ text: 'infra updates' }],
    })),
    /subitems|bucket/i,
  );
});

test('section placement stops before an exact paragraph divider', async () => {
  const containerId = id(40);
  const selectedTask = todo(id(42), 'Current backlog task', false, containerId);
  const divider = paragraph(id(43), 'back-back log', containerId);
  const laterTask = todo(id(44), 'Deep backlog task', false, containerId);
  const scope = fixture(
    blockProfile({
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: {
        backlog: {
          id: containerId,
          layout: 'sections',
          sectionLabels: ['Shared Backlog', 'Gibran', 'Nakul', 'back-back log'],
        },
      },
      backlogContainer: 'backlog',
      logBuckets: [],
    }),
    {
      [containerId]: [
        heading3(id(41), 'Nakul', containerId),
        selectedTask,
        divider,
        laterTask,
      ],
    },
  );
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'backlog',
    section: 'Nakul',
    items: [{ text: 'Place before the paragraph divider' }],
  }));
  const operation = record(operations[0]);
  assert.deepEqual(operation.position, {
    type: 'after_block',
    after_block: { id: id(42) },
  });
  assert.equal(todoChecked(appendChildren(operation)[0] ?? {}), false);
});

test('workspaces without log buckets create flat checked shipped entries', async () => {
  const containerId = id(45);
  const operations = await planTodos(
    fixture(
      blockProfile({
        kind: 'blocks',
        pageId: id(1),
        defaultOwner: 'Nakul',
        containers: { Nakul: { id: containerId, layout: 'flat' } },
        logBuckets: [],
      }),
      { [containerId]: [] },
    ),
    parseTodoRequest({
      intent: 'log',
      items: [{ text: 'Shipped the flat workspace adapter' }],
    }),
  );
  assert.equal(todoChecked(appendChildren(operations[0])[0] ?? {}), true);
});

test('preserve mode accepts historical disorder while descending mode refuses it', async () => {
  const containerId = id(50);
  const children = [
    dateHeading(id(51), '2026-09-05', containerId),
    todo(id(52), 'one', false, containerId),
    dateHeading(id(53), '2026-09-03', containerId),
    todo(id(54), 'two', false, containerId),
    dateHeading(id(55), '2026-09-04', containerId),
    todo(id(56), 'three', false, containerId),
  ];
  const makeScope = (dateOrder?: 'descending' | 'preserve') => fixture(
    blockProfile({
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: { Nakul: { id: containerId, layout: 'dated', ...(dateOrder === undefined ? {} : { dateOrder }) } },
      logBuckets: [],
    }),
    { [containerId]: children },
  );
  const request = parseTodoRequest({
    intent: 'plan',
    date: '2026-09-02',
    items: [{ text: 'Historical backfill' }],
  });
  await assert.rejects(planTodos(makeScope('descending'), request), /order|descending/i);
  for (const order of ['preserve', undefined] as const) {
    const operations = await planTodos(makeScope(order), request);
    assert.equal(operations.length, 1);
    assert.deepEqual(record(operations[0]).position, { type: 'end' });
  }
});

test('unrelated historical duplicate dates do not block a unique target in preserve mode', async () => {
  const container = id(50);
  const blocks = [
    dateHeading(id(51), '2026-09-05', container),
    todo(id(52), 'Current', false, container),
    dateHeading(id(53), '2026-03-09', container),
    todo(id(54), 'Historical entry one', true, container),
    dateHeading(id(55), '2026-03-09', container),
    todo(id(56), 'Historical entry two', true, container),
  ];
  const before = structuredClone(blocks);
  const scope = fixture(blockProfile({
    kind: 'blocks', pageId: id(1), defaultOwner: 'Nakul',
    containers: { Nakul: { id: container, layout: 'dated', dateOrder: 'preserve' } },
    logBuckets: [],
  }), { [container]: blocks });
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'plan', date: '2026-09-06', items: [{ text: 'New work' }],
  }));
  assert.deepEqual(record(operations[0]).position, { type: 'start' });
  assert.deepEqual((await listTodos(scope, { date: '2026-09-05' })).blocks, blocks.slice(0, 2));
  await assert.rejects(planTodos(scope, parseTodoRequest({
    intent: 'plan', date: '2026-03-09', items: [{ text: 'Ambiguous date' }],
  })), /Multiple date headings/);
  await assert.rejects(listTodos(scope, { date: '2026-03-09' }), /Multiple date headings/);
  assert.deepEqual(blocks, before);
});

test('exact block updates reject foreign and non-task IDs and carry read preconditions', async () => {
  const pageId = id(1);
  const containerId = id(60);
  const taskId = id(61);
  const task = todo(taskId, 'Scoped task', false, containerId);
  const container = block(containerId, 'column', {}, pageId);
  const page: JsonObject = {
    object: 'page',
    id: pageId,
    parent: { type: 'workspace', workspace: true },
    properties: {},
  };
  const paragraphBlock = paragraph(id(62), 'Document text', containerId);
  const foreignTask = todo(id(63), 'Foreign task', false, id(99));
  const foreignPage: JsonObject = {
    object: 'page',
    id: id(99),
    parent: { type: 'workspace', workspace: true },
    properties: {},
  };
  const scope = fixture(
    blockProfile({
      kind: 'blocks',
      pageId,
      defaultOwner: 'Nakul',
      containers: { Nakul: { id: containerId, layout: 'dated' } },
      logBuckets: [],
    }),
    {},
    {
      [taskId]: task,
      [containerId]: container,
      [pageId]: page,
      [id(62)]: paragraphBlock,
      [id(63)]: foreignTask,
      [id(99)]: foreignPage,
    },
  );
  await assert.rejects(
    planTodos(scope, parseTodoRequest({ intent: 'complete', id: id(62) })),
    /to_do|task/i,
  );
  await assert.rejects(
    planTodos(scope, parseTodoRequest({ intent: 'complete', id: id(63) })),
    /todo page|configured|scope/i,
  );
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'update',
    id: taskId,
    text: 'Renamed scoped task',
    checked: true,
  }));
  const operation = record(operations[0]);
  assert.equal(operation.id, taskId);
  const patch = record(operation.patch, 'patch');
  const body = record(patch.to_do, 'patch.to_do');
  assert.equal(body.checked, true);
  assert.equal(textContent({ to_do: body }), 'Renamed scoped task');
  assert.ok(records(operation.preconditions, 'preconditions').some(item =>
    item.kind === 'block' && item.id === taskId && typeof item.hash === 'string'));
  assert.ok(records(operation.preconditions, 'preconditions').some(item =>
    item.kind === 'block' && item.id === containerId && typeof item.hash === 'string'));
});

test('database planning validates schema, maps configured properties, and avoids duplicate rows', async () => {
  const dataSourceId = id(70);
  const source: JsonObject = {
    object: 'data_source',
    id: dataSourceId,
    properties: {
      Name: { id: 'title', type: 'title', title: {} },
      Status: {
        id: 'status',
        type: 'status',
        status: {
          options: [
            { id: 'pending', name: 'Queued', color: 'yellow' },
            { id: 'done', name: 'Shipped', color: 'green' },
          ],
        },
      },
      Date: { id: 'date', type: 'date', date: {} },
      Owner: {
        id: 'owner',
        type: 'select',
        select: { options: [{ id: 'nakul', name: 'Nakul M', color: 'blue' }] },
      },
    },
  };
  const existing: JsonObject = {
    object: 'page',
    id: id(71),
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { type: 'title', title: [{ type: 'text', text: { content: 'Existing task' } }] },
      Status: { type: 'status', status: { name: 'Shipped', color: 'green' } },
      Date: { type: 'date', date: { start: '2026-09-05' } },
      Owner: { type: 'select', select: { name: 'Nakul M', color: 'blue' } },
      Unrelated: { type: 'rich_text', rich_text: [{ type: 'text', text: { content: 'keep' } }] },
    },
  };
  const profileValue = databaseProfile({
    kind: 'database',
    dataSourceId,
    titleProperty: 'Name',
    statusProperty: 'Status',
    statusType: 'status',
    pendingValue: 'Queued',
    doneValue: 'Shipped',
    dateProperty: 'Date',
    ownerProperty: 'Owner',
    ownerType: 'select',
    owners: { Nakul: 'Nakul M' },
  });
  const scope = fixture(profileValue, {}, { [dataSourceId]: source }, [existing]);
  assert.deepEqual(await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    owner: 'Nakul',
    date: '2026-09-05',
    items: [{ text: 'Existing task' }],
  })), []);

  const operations = await planTodos(
    scope,
    parseTodoRequest({
      intent: 'plan',
      owner: 'Nakul',
      items: [{ text: 'New pending task' }],
    }),
    new Date('2026-09-06T06:30:00.000Z'),
  );
  assert.equal(operations.length, 1);
  const operation = record(operations[0]);
  assert.deepEqual(operation.parent, { kind: 'data_source', id: dataSourceId });
  const properties = record(operation.properties, 'properties');
  assert.deepEqual(properties.Status, { status: { name: 'Queued' } });
  assert.deepEqual(properties.Date, { date: { start: '2026-09-05' } });
  assert.deepEqual(properties.Owner, { select: { name: 'Nakul M' } });
  assert.equal(Object.hasOwn(properties, 'Unrelated'), false);
  const preconditions = records(operation.preconditions, 'preconditions');
  assert.ok(preconditions.some(item => item.kind === 'data_source' && item.id === dataSourceId));
  assert.ok(preconditions.some(item => item.kind === 'query' && item.id === dataSourceId));

  const invalidSource: JsonObject = {
    ...source,
    properties: {
      ...record(source.properties),
      Status: { type: 'select', select: { options: [] } },
    },
  };
  await assert.rejects(
    planTodos(
      fixture(profileValue, {}, { [dataSourceId]: invalidSource }, []),
      parseTodoRequest({
        intent: 'plan',
        owner: 'Nakul',
        items: [{ text: 'Schema must match' }],
      }),
    ),
    /Status|status/i,
  );
});

test('database exact-ID updates reject generic pages outside the configured source', async () => {
  const dataSourceId = id(80);
  const source: JsonObject = {
    object: 'data_source',
    id: dataSourceId,
    properties: {
      Name: { type: 'title', title: {} },
      Done: { type: 'checkbox', checkbox: {} },
    },
  };
  const document: JsonObject = {
    object: 'page',
    id: id(81),
    parent: { type: 'page_id', page_id: id(1) },
    properties: {
      Name: { type: 'title', title: [{ type: 'text', text: { content: 'Document' } }] },
    },
  };
  const scope = fixture(
    databaseProfile({
      kind: 'database',
      dataSourceId,
      titleProperty: 'Name',
      statusProperty: 'Done',
      statusType: 'checkbox',
      pendingValue: false,
      doneValue: true,
      owners: {},
    }),
    {},
    { [dataSourceId]: source, [id(81)]: document },
  );
  await assert.rejects(
    planTodos(scope, parseTodoRequest({ intent: 'complete', id: id(81) })),
    /data source|task|row/i,
  );
});

test('database checkbox and people properties use configured pending, done, and owner values', async () => {
  const dataSourceId = id(85);
  const ownerId = id(86);
  const taskId = id(87);
  const source: JsonObject = {
    object: 'data_source',
    id: dataSourceId,
    properties: {
      Name: { type: 'title', title: {} },
      Done: { type: 'checkbox', checkbox: {} },
      Owner: { type: 'people', people: {} },
    },
  };
  const task: JsonObject = {
    object: 'page',
    id: taskId,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { type: 'title', title: [{ type: 'text', text: { content: 'Owned task' } }] },
      Done: { type: 'checkbox', checkbox: false },
      Owner: { type: 'people', people: [{ id: ownerId }] },
    },
  };
  const profileValue = databaseProfile({
    kind: 'database',
    dataSourceId,
    titleProperty: 'Name',
    statusProperty: 'Done',
    statusType: 'checkbox',
    pendingValue: false,
    doneValue: true,
    ownerProperty: 'Owner',
    ownerType: 'people',
    owners: { Nakul: ownerId },
  });
  const scope = fixture(profileValue, {}, { [dataSourceId]: source, [taskId]: task });
  const create = await planTodos(scope, parseTodoRequest({
    intent: 'backlog',
    owner: 'Nakul',
    items: [{ text: 'New owned task' }],
  }));
  const createProperties = record(record(create[0]).properties);
  assert.deepEqual(createProperties.Done, { checkbox: false });
  assert.deepEqual(createProperties.Owner, { people: [{ id: ownerId }] });

  const complete = await planTodos(scope, parseTodoRequest({ intent: 'complete', id: taskId }));
  const completePatch = record(record(complete[0]).patch);
  assert.deepEqual(record(completePatch.properties).Done, { checkbox: true });
});

test('database owner selectors require a configured property and existing rows can grow past 100 children', async () => {
  const dataSourceId = id(88);
  const taskId = id(89);
  const source: JsonObject = {
    object: 'data_source',
    id: dataSourceId,
    properties: {
      Name: { type: 'title', title: {} },
      Done: { type: 'checkbox', checkbox: {} },
    },
  };
  const task: JsonObject = {
    object: 'page',
    id: taskId,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { type: 'title', title: [{ type: 'text', text: { content: 'Expandable row' } }] },
      Done: { type: 'checkbox', checkbox: false },
    },
  };
  const profileValue = databaseProfile({
    kind: 'database',
    dataSourceId,
    titleProperty: 'Name',
    statusProperty: 'Done',
    statusType: 'checkbox',
    pendingValue: false,
    doneValue: true,
    owners: {},
  });
  const scope = fixture(
    profileValue,
    { [taskId]: [] },
    { [dataSourceId]: source },
    [task],
  );
  await assert.rejects(
    planTodos(scope, parseTodoRequest({
      intent: 'backlog',
      owner: 'Nakul',
      items: [{ text: 'Unmapped owner' }],
    })),
    /owner property/i,
  );
  await assert.rejects(
    planTodos(scope, parseTodoRequest({
      intent: 'backlog',
      container: 'unsupported',
      items: [{ text: 'Unsupported database selector' }],
    })),
    /container|section/i,
  );

  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    items: [{
      text: 'Expandable row',
      subitems: Array.from({ length: 101 }, (_, index) => `Child ${index}`),
    }],
  }));
  assert.deepEqual(operations.map(operation => appendChildren(operation).length), [100, 1]);
  assert.ok(operations.every(operation => record(operation).parentId === taskId));
});

test('dated lists select one actual date band and standing sections stop before dated history', async () => {
  const containerId = id(96);
  const blocks = [
    paragraph(id(97), 'Backlog', containerId),
    todo(id(98), 'Standing work', false, containerId),
    dateHeading(id(99), '2026-09-06', containerId),
    todo(id(100), 'Tomorrow', false, containerId),
    dateHeading(id(101), '2026-09-05', containerId),
    todo(id(102), 'Today', true, containerId),
  ];
  const scope = fixture(blockProfile({
    kind: 'blocks', pageId: id(1), defaultOwner: 'Nakul',
    containers: {
      Nakul: { id: containerId, layout: 'dated' },
      backlog: { id: containerId, layout: 'sections', section: 'Backlog', sectionLabels: ['Todos', 'Backlog'] },
    },
    backlogContainer: 'backlog', logBuckets: [],
  }), { [containerId]: blocks });
  const dateList = await listTodos(scope, { date: '2026-09-05' });
  assert.deepEqual(dateList.blocks, blocks.slice(4));
  assert.deepEqual((await listTodos(scope, { date: '2026-09-04' })).blocks, []);
  const backlog = await listTodos(scope, { container: 'backlog' });
  assert.deepEqual(backlog.blocks, blocks.slice(0, 2));
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'backlog',
    items: [{ text: 'New standing work' }],
  }));
  assert.deepEqual(record(operations[0]).position, { type: 'after_block', after_block: { id: id(98) } });
});

test('listing returns faithful selected blocks or rows with scope metadata', async () => {
  const blockContainer = id(90);
  const blocks = [
    paragraph(id(91), 'Todos', blockContainer),
    todo(id(92), 'One', false, blockContainer),
    paragraph(id(95), 'Backlog', blockContainer),
    todo(id(96), 'Other section', true, blockContainer),
  ];
  const blockResult = await listTodos(
    fixture(
      blockProfile({
        kind: 'blocks',
        pageId: id(1),
        defaultOwner: 'Nakul',
        containers: {
          Nakul: {
            id: blockContainer,
            layout: 'sections',
            section: 'Todos',
            sectionLabels: ['Todos', 'Backlog'],
          },
        },
        logBuckets: [],
      }),
      { [blockContainer]: blocks },
    ),
    { owner: 'Nakul' },
  );
  assert.equal(blockResult.layout, 'blocks');
  assert.deepEqual(blockResult.blocks, blocks.slice(0, 2));
  assert.equal(record(blockResult.container).id, blockContainer);
  assert.equal(record(blockResult.container).section, 'Todos');
  await assert.rejects(
    listTodos(
      fixture(
        blockProfile({
          kind: 'blocks',
          pageId: id(1),
          defaultOwner: 'Nakul',
          containers: {
            Nakul: {
              id: blockContainer,
              layout: 'sections',
              section: 'Todos',
              sectionLabels: ['Todos', 'Backlog'],
            },
          },
          logBuckets: [],
        }),
        { [blockContainer]: blocks },
      ),
      { owner: 'Nakul', date: '2026-09-05' },
    ),
    /not dated|date/i,
  );

  const dataSourceId = id(93);
  const source: JsonObject = {
    object: 'data_source',
    id: dataSourceId,
    properties: {
      Name: { type: 'title', title: {} },
      Done: { type: 'checkbox', checkbox: {} },
      Date: { type: 'date', date: {} },
    },
  };
  const rows = [{
    object: 'page',
    id: id(94),
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { type: 'title', title: [] },
      Done: { type: 'checkbox', checkbox: false },
      Date: { type: 'date', date: { start: '2026-09-05' } },
    },
  }];
  const databaseResult = await listTodos(
    fixture(
      databaseProfile({
        kind: 'database',
        dataSourceId,
        titleProperty: 'Name',
        statusProperty: 'Done',
        statusType: 'checkbox',
        pendingValue: false,
        doneValue: true,
        dateProperty: 'Date',
        owners: {},
      }),
      {},
      { [dataSourceId]: source },
      rows,
    ),
    { date: '2026-09-05' },
  );
  assert.equal(databaseResult.layout, 'database');
  assert.equal(databaseResult.dataSourceId, dataSourceId);
  assert.deepEqual(databaseResult.rows, rows);
  assert.equal(Object.hasOwn(databaseResult, 'credentialRef'), false);
  await assert.rejects(
    listTodos(
      fixture(
        databaseProfile({
          kind: 'database',
          dataSourceId,
          titleProperty: 'Name',
          statusProperty: 'Done',
          statusType: 'checkbox',
          pendingValue: false,
          doneValue: true,
          dateProperty: 'Date',
          owners: {},
        }),
        {},
        { [dataSourceId]: source },
        rows,
      ),
      { section: 'Backlog' },
    ),
    /container|section/i,
  );
});

test('oversized nested todo input is rejected rather than truncated', async () => {
  const containerId = id(100);
  const request: TodoRequest = {
    intent: 'plan',
    items: [{
      text: 'Parent',
      subitems: Array.from({ length: 101 }, (_, index) => `Child ${index}`),
    }],
  };
  await assert.rejects(
    planTodos(
      fixture(
        blockProfile({
          kind: 'blocks',
          pageId: id(1),
          defaultOwner: 'Nakul',
          containers: { Nakul: { id: containerId, layout: 'flat' } },
          logBuckets: [],
        }),
        { [containerId]: [] },
      ),
      request,
    ),
    /100|limit/i,
  );
});

test('top-level appends split at 100 blocks without reversing final start placement', async () => {
  const containerId = id(110);
  const items = Array.from({ length: 205 }, (_, index) => ({ text: `Task ${index}` }));
  const operations = await planTodos(
    fixture(
      blockProfile({
        kind: 'blocks',
        pageId: id(1),
        defaultOwner: 'Nakul',
        containers: { Nakul: { id: containerId, layout: 'flat' } },
        logBuckets: [],
      }),
      { [containerId]: [] },
    ),
    parseTodoRequest({ intent: 'plan', items }),
  );
  assert.deepEqual(operations.map(operation => appendChildren(operation).length), [5, 100, 100]);
  assert.deepEqual(
    operations.map(operation => textContent(appendChildren(operation)[0] ?? {})),
    ['Task 200', 'Task 100', 'Task 0'],
  );
  assert.ok(operations.every(operation =>
    record(operation).position !== undefined
    && record(record(operation).position).type === 'start'));
});

test('generated operations pass the shared parser and fingerprint prior layout reads', async () => {
  const containerId = id(120);
  const existing = {
    ...paragraph(id(121), 'Existing', containerId),
    last_edited_time: '2026-09-05T20:00:00.000Z',
  };
  const scope = fixture(
    blockProfile({
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: { Nakul: { id: containerId, layout: 'flat' } },
      logBuckets: [],
    }),
    { [containerId]: [existing] },
  );
  const operations = await planTodos(scope, parseTodoRequest({
    intent: 'plan',
    items: [{ text: 'New task' }],
  }));
  assert.deepEqual(parseOperations(operations), operations);
  const conditions = records(record(operations[0]).preconditions, 'preconditions');
  const layout = conditions.find(condition =>
    condition.kind === 'children' && condition.id === containerId);
  assert.equal(layout?.hash, stateFingerprint([existing]));
  assert.equal(
    layout?.hash,
    stateFingerprint([{ ...existing, last_edited_time: '2026-09-05T21:00:00.000Z' }]),
  );
});
