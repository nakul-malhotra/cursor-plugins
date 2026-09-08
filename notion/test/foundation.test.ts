import assert from 'node:assert/strict';
import { chmod, lstat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { NotionClient } from '../lib/client.js';
import {
  defaultHome,
  loadProfiles,
  readCredential,
  readPrivateJson,
  resolveProfile,
} from '../lib/config.js';
import { NotionError, safeError } from '../lib/errors.js';
import { ScopedNotion } from '../lib/scope.js';
import type { JsonObject, Profile } from '../lib/types.js';
import {
  array,
  blockText,
  canonicalJson,
  fingerprint,
  isObject,
  notionId,
  object,
  pageTitle,
  richText,
  string,
} from '../lib/values.js';
import { fakeFetch, id, jsonResponse, profile, profileHome } from './helpers.js';

test('JSON values validate recursively and serialize canonically', () => {
  assert.deepEqual(object({ b: [true, null, { z: 2 }], a: 'one' }), {
    b: [true, null, { z: 2 }],
    a: 'one',
  });
  assert.deepEqual(array([1, { ok: true }]), [1, { ok: true }]);
  assert.equal(string('value'), 'value');
  assert.equal(isObject({ nested: [1, true, null] }), true);
  assert.equal(isObject({ nested: undefined }), false);
  assert.equal(isObject(Array(1)), false);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(isObject(circular), false);
  assert.throws(() => object({ nested: undefined }), /nested/);
  assert.throws(() => array([Number.NaN]), /JSON/);
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(
    fingerprint({ z: 1, a: { d: 2, c: 3 } }),
    fingerprint({ a: { c: 3, d: 2 }, z: 1 }),
  );
  assert.notEqual(fingerprint({ value: 1 }), fingerprint({ value: 2 }));
  const protoKey = JSON.parse('{"__proto__":{"safe":true}}');
  assert.equal(canonicalJson(protoKey), '{"__proto__":{"safe":true}}');
  assert.notEqual(fingerprint(protoKey), fingerprint({}));
});

test('Notion identifiers accept exact IDs and known Notion URLs only', () => {
  const compact = '31E5A2A9E7968024B366E4A57F269417';
  const normalized = '31e5a2a9-e796-8024-b366-e4a57f269417';
  assert.equal(notionId(compact), normalized);
  assert.equal(notionId(normalized.toUpperCase()), normalized);
  assert.equal(
    notionId(`https://www.notion.so/Workspace-Title-${compact}?pvs=4`),
    normalized,
  );
  assert.equal(
    notionId(`https://example.notion.site/Title-${compact}`),
    normalized,
  );
  assert.equal(notionId(`https://notion.site/${normalized}`), normalized);
  assert.throws(() => notionId(`https://example.com/${compact}`), /Notion/);
  assert.throws(() => notionId(`prefix-${compact}`), /Notion/);
  assert.throws(() => notionId(`31e5-a2a9e7968024b366e4a57f269417`), /Notion/);
  assert.equal(notionId(`https://app.notion.com/p/Title-${compact}`), normalized);
  assert.equal(notionId(`https://www.notion.so/Page-${compact}#${id(22).replaceAll('-', '')}`), id(22));
  assert.throws(() => notionId(`https://www.notion.so/${compact}#unknown-section`), /fragment/);
  assert.throws(() => notionId(`file://notion.so/${compact}`), /HTTPS/);
});

test('rich text helpers preserve paragraph page and date mentions', () => {
  assert.deepEqual(richText('hello'), [{ type: 'text', text: { content: 'hello' } }]);
  const block: JsonObject = {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Due ' }, plain_text: 'Due ' },
        {
          type: 'mention',
          mention: { type: 'date', date: { start: '2026-09-06' } },
        },
        {
          type: 'mention',
          mention: { type: 'page', page: { id: id(7) } },
          plain_text: ' Unit Economics Case Study',
        },
      ],
    },
  };
  assert.equal(blockText(block), 'Due 2026-09-06 Unit Economics Case Study');
  const page: JsonObject = {
    object: 'page',
    properties: {
      Name: {
        type: 'title',
        title: [{ type: 'text', text: { content: 'Canonical title' } }],
      },
    },
  };
  assert.equal(pageTitle(page), 'Canonical title');
  const dataSource: JsonObject = {
    object: 'data_source',
    title: [{ type: 'text', text: { content: 'Tasks database' } }],
    properties: {
      Task: {
        type: 'title',
        title: {},
      },
    },
  };
  assert.equal(pageTitle(dataSource), 'Tasks database');
});

test('safe errors redact supplied secrets and Notion-token-shaped text', () => {
  const secret = 'synthetic-private-value';
  const shaped = 'secret_abcdefghijklmnopqrstuvwxyz123456';
  const result = safeError(
    new NotionError('CONFIG', `credential ${secret} ${shaped}`, {
      credential: secret,
      remote: shaped,
      nested: { credential: secret },
      values: [shaped],
    }),
    [secret],
  );
  const serialized = JSON.stringify(result);
  assert.equal(result.code, 'CONFIG');
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /secret_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(safeError({ response: '{"token":"raw credential JSON"}' }).message, 'Unexpected error.');
  const cyclicDetails: JsonObject = {};
  cyclicDetails.self = cyclicDetails;
  assert.doesNotThrow(() => safeError(new NotionError('CYCLIC', 'safe', cyclicDetails)));
});

test('private configuration rejects permissive modes, symlinks, and malformed profiles', async () => {
  const fixture = await profileHome();
  try {
    const registry = join(fixture.home, '.workspaces.json');
    await chmod(registry, 0o644);
    await assert.rejects(loadProfiles(fixture.home), /mode|private|600/i);
    await chmod(registry, 0o600);

    const profileFile = join(fixture.home, 'profiles', 'gantry.json');
    const profileTarget = join(fixture.home, 'profiles', 'target.json');
    await writeFile(profileTarget, JSON.stringify(profile()), { mode: 0o600 });
    await unlink(profileFile);
    await symlink(profileTarget, profileFile);
    await assert.rejects(loadProfiles(fixture.home), /symbolic link/i);
    await unlink(profileFile);

    const malformed = profile({
      todos: {
        kind: 'blocks',
        pageId: id(1),
        defaultOwner: 'Nakul',
        containers: { current: { id: id(2), layout: 'flat' } },
        logBuckets: ['done'],
      },
    });
    const malformedJson = JSON.stringify(malformed).replace('"layout":"flat"', '"layout":"grid"');
    await writeFile(profileFile, malformedJson, { mode: 0o600 });
    await assert.rejects(loadProfiles(fixture.home), /layout/i);

    await assert.rejects(readPrivateJson(join(fixture.home, 'profiles')), /regular file/i);
    assert.equal((await lstat(fixture.home)).mode & 0o777, 0o700);
  } finally {
    await fixture.cleanup();
  }
});

test('profiles resolve exact keys, aliases, repositories, and credential references', async () => {
  const praetor = profile({
    key: 'praetor',
    label: 'Praetor',
    aliases: ['addy-law'],
    repositories: ['Praetor', 'addy-law'],
    credentialRef: 'other-bot',
    connection: { botId: id(92), workspaceId: id(91) },
    roots: [{ kind: 'page', id: id(2) }],
  });
  const fixture = await profileHome([
    { slug: 'gantry', value: profile() },
    { slug: 'praetor', value: praetor },
  ]);
  try {
    const originalHome = process.env.NOTION_HOME;
    try {
      delete process.env.NOTION_HOME;
      assert.equal(defaultHome().endsWith(join('.copilot', 'notion')), true);
      process.env.NOTION_HOME = '/tmp/synthetic-notion-home';
      assert.equal(defaultHome(), '/tmp/synthetic-notion-home');
    } finally {
      if (originalHome === undefined) delete process.env.NOTION_HOME;
      else process.env.NOTION_HOME = originalHome;
    }
    assert.equal((await resolveProfile(fixture.home, 'gantry')).key, 'gantry');
    assert.equal((await resolveProfile(fixture.home, 'g')).key, 'gantry');
    assert.equal((await resolveProfile(fixture.home, 'addy-law')).key, 'praetor');
    assert.equal(
      (await resolveProfile(fixture.home, undefined, '/tmp/work/gantry/packages/app')).key,
      'gantry',
    );
    await assert.rejects(
      resolveProfile(fixture.home, undefined, '/tmp/work/gantry-copy'),
      /profile/i,
    );
    const resolved = await resolveProfile(fixture.home, 'gantry');
    assert.equal(await readCredential(fixture.home, resolved.credentialRef), 'synthetic-gantry-token');
    assert.equal(await readCredential(fixture.home, praetor.credentialRef), 'synthetic-other-token');
    await assert.rejects(readCredential(fixture.home, 'missing'), /credential/i);
  } finally {
    await fixture.cleanup();
  }
});

test('credential files require exact mode 600 rather than any owner-only mode', async t => {
  const fixture = await profileHome();
  t.after(fixture.cleanup);
  await chmod(join(fixture.home, '.credentials.json'), 0o400);
  await assert.rejects(readCredential(fixture.home, 'gantry-bot'), /600|permission|mode/i);
});

test('block todo profiles preserve owner backlog and section/date layout conventions', async () => {
  const fixture = await profileHome([
    {
      slug: 'gantry',
      value: profile({
        todos: {
          kind: 'blocks',
          pageId: id(1),
          defaultOwner: 'Nakul',
          containers: {
            current: {
              id: id(2),
              layout: 'sections',
              section: 'Todos',
              sectionLabels: ['Todos', 'Backlog', 'back-back log'],
              dateOrder: 'preserve',
            },
            history: {
              id: id(3),
              layout: 'dated',
              dateOrder: 'descending',
            },
          },
          backlogContainer: 'current',
          backlogContainers: { Nakul: 'current', Medicus: 'history' },
          logBuckets: ['history'],
        },
      }),
    },
  ]);
  try {
    const loaded = await loadProfiles(fixture.home);
    assert.deepEqual(loaded[0]?.todos, {
      kind: 'blocks',
      pageId: id(1),
      defaultOwner: 'Nakul',
      containers: {
        current: {
          id: id(2),
          layout: 'sections',
          section: 'Todos',
          sectionLabels: ['Todos', 'Backlog', 'back-back log'],
          dateOrder: 'preserve',
        },
        history: {
          id: id(3),
          layout: 'dated',
          dateOrder: 'descending',
        },
      },
      backlogContainer: 'current',
      backlogContainers: { Nakul: 'current', Medicus: 'history' },
      logBuckets: ['history'],
    });

    const profileFile = join(fixture.home, 'profiles', 'gantry.json');
    const source = await readPrivateJson(profileFile);
    const invalid = JSON.stringify(source).replace('"dateOrder":"preserve"', '"dateOrder":"ascending"');
    await writeFile(profileFile, invalid, { mode: 0o600 });
    await assert.rejects(loadProfiles(fixture.home), /date order/i);
  } finally {
    await fixture.cleanup();
  }
});

test('profile registry rejects unsafe slugs and duplicate selectors', async () => {
  const duplicate = profile({ key: 'other', aliases: ['g'], credentialRef: 'other-bot' });
  const fixture = await profileHome([
    { slug: 'gantry', value: profile() },
    { slug: 'other', value: duplicate },
  ]);
  try {
    await assert.rejects(loadProfiles(fixture.home), /duplicate|alias/i);
    await writeFile(
      join(fixture.home, '.workspaces.json'),
      JSON.stringify({ version: 1, profiles: ['../escape'] }),
      { mode: 0o600 },
    );
    await assert.rejects(loadProfiles(fixture.home), /slug|profile/i);
  } finally {
    await fixture.cleanup();
  }
});

test('client paginates beyond 100 results with a unique cursor chain', async () => {
  const first = Array.from({ length: 100 }, (_, index): JsonObject => ({
    object: 'block',
    id: id(index + 1),
  }));
  const seen: URL[] = [];
  const client = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch(url => {
      seen.push(url);
      if (url.searchParams.get('start_cursor') === 'next-100') {
        return jsonResponse({
          object: 'list',
          results: [{ object: 'block', id: id(101) }],
          has_more: false,
          next_cursor: null,
        });
      }
      return jsonResponse({
        object: 'list',
        results: first,
        has_more: true,
        next_cursor: 'next-100',
      });
    }),
  });
  const results = await client.paginate(`/blocks/${id(1)}/children`);
  assert.equal(results.length, 101);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.origin, 'https://api.notion.com');
  assert.equal(seen[0]?.searchParams.get('page_size'), '100');
  assert.equal(seen[1]?.searchParams.get('start_cursor'), 'next-100');
});

test('pagination rejects missing and repeated cursors rather than truncating success', async () => {
  const missing = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch(() =>
      jsonResponse({ object: 'list', results: [], has_more: true, next_cursor: null }),
    ),
  });
  await assert.rejects(missing.paginate('/search', { method: 'POST', readOnly: true }), /cursor/i);

  let calls = 0;
  const repeated = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch(() => {
      calls += 1;
      return jsonResponse({
        object: 'list',
        results: [],
        has_more: true,
        next_cursor: 'same',
      });
    }),
  });
  await assert.rejects(
    repeated.paginate('/search', { method: 'POST', readOnly: true }),
    /cursor/i,
  );
  assert.equal(calls, 2);
});

test('client rejects unsafe routes, redirects, read-only bypasses, and oversized payloads', async () => {
  const client = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 1,
    fetch: fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })),
  });
  await assert.rejects(client.request('https://evil.example/pages/1'), /relative|route|URL/i);
  await assert.rejects(client.request('//evil.example/pages/1'), /relative|route|URL/i);
  await assert.rejects(client.request('/pages/../users'), /traversal|route/i);
  await assert.rejects(client.request(`/pages/${id(1)}#fragment`), /fragment|route/i);
  await assert.rejects(
    client.request(`/pages/${id(1)}`, { method: 'PATCH', readOnly: true }),
    /read.only/i,
  );
  await assert.rejects(client.request(`/pages/${id(1)}`), /redirect/i);
  await assert.rejects(
    client.request(`/blocks/${id(1)}/children`, {
      method: 'PATCH',
      body: { children: Array.from({ length: 101 }, () => ({ type: 'paragraph' })) },
    }),
    /100/,
  );
  await assert.rejects(
    client.request(`/blocks/${id(1)}`, {
      method: 'PATCH',
      body: { paragraph: { rich_text: [{ text: { content: 'x'.repeat(2001) } }] } },
    }),
    /2000/,
  );
  await assert.rejects(
    client.request(`/pages/${id(1)}`, {
      method: 'PATCH',
      body: { payload: 'x'.repeat(500 * 1024) },
    }),
    /500/,
  );
  await assert.rejects(
    client.request(`/blocks/${id(1)}/children`, {
      method: 'PATCH',
      body: {
        sections: Array.from({ length: 11 }, () => ({
          children: Array.from({ length: 100 }, () => ({ type: 'paragraph' })),
        })),
      },
    }),
    /1000/,
  );
  let paginationFetches = 0;
  const unsafePagination = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch(() => {
      paginationFetches += 1;
      return jsonResponse({ object: 'page', id: id(1) });
    }),
  });
  await assert.rejects(
    unsafePagination.paginate('/pages', { method: 'POST', body: { parent: {} } }),
    /read.only/i,
  );
  assert.equal(paginationFetches, 0);
});

test('client owns the API version default and honors a distinct explicit override', async () => {
  const versions: Array<string | null> = [];
  const client = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch((_url, init) => {
      versions.push(new Headers(init?.headers).get('notion-version'));
      return jsonResponse({ object: 'user', id: id(1) });
    }),
  });
  await client.request('/users/me');
  await client.request('/users/me', { version: '2025-09-03' });
  assert.deepEqual(versions, ['2026-03-11', '2025-09-03']);
});

test('client stops at the configured retry budget rather than the default budget', async () => {
  for (const [maxAttempts, expected] of [[undefined, 4], [2, 2]] as const) {
    let calls = 0;
    const client = new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      sleep: async () => {},
      fetch: fakeFetch(() => {
        calls += 1;
        return jsonResponse({ code: 'rate_limited' }, 429, { 'retry-after': '0' });
      }),
    });
    await assert.rejects(client.request('/users/me'), error => error instanceof NotionError && error.code === 'RATE_LIMITED');
    assert.equal(calls, expected);
  }
});

test('client retries rate limits but never blindly retries ambiguous mutations', async () => {
  const sleeps: number[] = [];
  let rateLimitCalls = 0;
  const rateLimited = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 2,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
    },
    fetch: fakeFetch(() => {
      rateLimitCalls += 1;
      return rateLimitCalls === 1
        ? jsonResponse({ code: 'rate_limited', message: 'slow down' }, 429, { 'retry-after': '0' })
        : jsonResponse({ object: 'page', id: id(1) });
    }),
  });
  assert.equal((await rateLimited.request(`/pages/${id(1)}`)).id, id(1));
  assert.equal(rateLimitCalls, 2);
  assert.deepEqual(sleeps, [0]);

  let mutationCalls = 0;
  const ambiguous = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 4,
    fetch: fakeFetch(() => {
      mutationCalls += 1;
      throw new TypeError('socket reset with secret_abcdefghijklmnopqrstuvwxyz123456');
    }),
  });
  await assert.rejects(
    ambiguous.request(`/pages/${id(1)}`, {
      method: 'PATCH',
      body: { archived: true },
    }),
    (error: unknown) => error instanceof NotionError && error.code === 'UNCERTAIN',
  );
  assert.equal(mutationCalls, 1);

  let serverErrorCalls = 0;
  const serverError = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 4,
    fetch: fakeFetch(() => {
      serverErrorCalls += 1;
      return jsonResponse({ code: 'internal_server_error', message: 'unknown outcome' }, 500);
    }),
  });
  await assert.rejects(
    serverError.request(`/pages/${id(1)}`, {
      method: 'PATCH',
      body: { archived: true },
    }),
    (error: unknown) => error instanceof NotionError && error.code === 'UNCERTAIN',
  );
  assert.equal(serverErrorCalls, 1);

  let overloadedMutationCalls = 0;
  const overloadedMutation = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 4,
    fetch: fakeFetch(() => {
      overloadedMutationCalls += 1;
      return jsonResponse({ code: 'service_unavailable', message: 'overloaded' }, 529, {
        'retry-after': '0',
      });
    }),
  });
  await assert.rejects(
    overloadedMutation.request(`/pages/${id(1)}`, {
      method: 'PATCH',
      body: { archived: true },
    }),
    (error: unknown) => error instanceof NotionError && error.code === 'UNCERTAIN',
  );
  assert.equal(overloadedMutationCalls, 1);

  let bodyReadCalls = 0;
  const unreadableMutation = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    maxAttempts: 4,
    fetch: fakeFetch(() => {
      bodyReadCalls += 1;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('response body interrupted'));
          },
        }),
        { status: 200 },
      );
    }),
  });
  await assert.rejects(
    unreadableMutation.request(`/pages/${id(1)}`, {
      method: 'PATCH',
      body: { archived: true },
    }),
    (error: unknown) => error instanceof NotionError && error.code === 'UNCERTAIN',
  );
  assert.equal(bodyReadCalls, 1);
});

test('client reserves throttle intervals across concurrent requests', async () => {
  const sleeps: number[] = [];
  const client = new NotionClient('synthetic-token', {
    minIntervalMs: 50,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
    },
    fetch: fakeFetch(() => jsonResponse({ object: 'page', id: id(1) })),
  });
  await Promise.all([
    client.request(`/pages/${id(1)}`),
    client.request(`/pages/${id(2)}`),
    client.request(`/pages/${id(3)}`),
  ]);
  assert.equal(sleeps.length, 2);
  assert.ok((sleeps[0] ?? 0) >= 49);
  assert.ok((sleeps[1] ?? 0) >= 99);
});

function scopedFetch(
  routes: Record<string, JsonObject | ((url: URL, init: RequestInit | undefined) => JsonObject)>,
): typeof globalThis.fetch {
  return fakeFetch((url, init) => {
    const route = routes[url.pathname];
    if (route === undefined) {
      return jsonResponse({ code: 'object_not_found', message: 'not found' }, 404);
    }
    return jsonResponse(typeof route === 'function' ? route(url, init) : route);
  });
}

function connection(): JsonObject {
  return {
    object: 'user',
    id: id(90),
    type: 'bot',
    bot: { workspace_id: id(91) },
  };
}

function page(pageId: string, parent: JsonObject): JsonObject {
  return { object: 'page', id: pageId, parent, properties: {} };
}

function block(blockId: string, parent: JsonObject, type = 'paragraph'): JsonObject {
  return {
    object: 'block',
    id: blockId,
    parent,
    type,
    has_children: false,
    [type]: { rich_text: [] },
  };
}

function scope(profileValue: Profile, routes: Record<string, JsonObject>): ScopedNotion {
  return new ScopedNotion(
    profileValue,
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      fetch: scopedFetch({ '/v1/users/me': connection(), ...routes }),
    }),
  );
}

test('scope caches identity while rereading ancestry and invalidates failed explicit refreshes', async () => {
  let identities = 0;
  let childReads = 0;
  let parent = id(1);
  let unavailable = false;
  const scoped = new ScopedNotion(profile(), new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: fakeFetch(url => {
      if (url.pathname === '/v1/users/me') {
        identities += 1;
        return unavailable
          ? jsonResponse({ code: 'restricted_resource', message: 'unavailable' }, 403)
          : jsonResponse(connection());
      }
      if (url.pathname === `/v1/pages/${id(7)}`) {
        childReads += 1;
        return jsonResponse(page(id(7), { type: 'page_id', page_id: parent }));
      }
      return jsonResponse(page(id(20), { type: 'workspace', workspace: true }));
    }),
  }));
  const child = { kind: 'page', id: id(7) } as const;
  await scoped.read(child);
  await scoped.read(child);
  assert.equal(identities, 1);
  assert.equal(childReads, 2);
  parent = id(20);
  await assert.rejects(scoped.read(child), /scope|root/i);
  assert.equal(childReads, 3);
  unavailable = true;
  await assert.rejects(scoped.verifyConnection(), { code: 'AUTH' });
  unavailable = false;
  parent = id(1);
  await scoped.read(child);
  assert.equal(identities, 3);
  scoped.profile.connection.botId = id(92);
  await assert.rejects(scoped.read(child), /bot|connection/i);
});

test('comment listing authorizes the exact target before querying comments', async () => {
  let queries = 0;
  const comments = [{ object: 'comment', id: id(8), rich_text: richText('Reviewed') }];
  const scoped = new ScopedNotion(profile(), new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: scopedFetch({
      '/v1/users/me': connection(),
      [`/v1/pages/${id(1)}`]: page(id(1), { type: 'workspace', workspace: true }),
      [`/v1/pages/${id(20)}`]: page(id(20), { type: 'workspace', workspace: true }),
      '/v1/comments': url => {
        queries += 1;
        assert.equal(url.searchParams.get('block_id'), id(1));
        return { object: 'list', results: comments, has_more: false, next_cursor: null };
      },
    }),
  }));
  assert.deepEqual(await scoped.comments({ kind: 'page', id: id(1) }), comments);
  await assert.rejects(scoped.comments({ kind: 'page', id: id(20) }), /scope|root/i);
  await assert.rejects(scoped.comments({ kind: 'database', id: id(1) }), /page or block/i);
  assert.equal(queries, 1);
});

test('scope rejects the wrong bot, foreign roots, and protected descendants', async () => {
  const root = id(1);
  const wrongBot = scope(profile(), {
    '/v1/users/me': { ...connection(), id: id(999) },
    [`/v1/pages/${root}`]: page(root, { type: 'workspace', workspace: true }),
  });
  await assert.rejects(wrongBot.read({ kind: 'page', id: root }), /bot|connection/i);

  let wrongWorkspaceReads = 0;
  const wrongWorkspace = new ScopedNotion(profile(), new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: scopedFetch({
      '/v1/users/me': { ...connection(), bot: { workspace_id: id(999) } },
      [`/v1/pages/${root}`]: () => {
        wrongWorkspaceReads += 1;
        return page(root, { type: 'workspace', workspace: true });
      },
    }),
  }));
  await assert.rejects(wrongWorkspace.read({ kind: 'page', id: root }), /workspace/i);
  assert.equal(wrongWorkspaceReads, 0);

  const foreignRoot = id(20);
  const foreignChild = id(21);
  const foreign = scope(profile(), {
    [`/v1/pages/${foreignChild}`]: page(foreignChild, {
      type: 'page_id',
      page_id: foreignRoot,
    }),
    [`/v1/pages/${foreignRoot}`]: page(foreignRoot, { type: 'workspace', workspace: true }),
  });
  await assert.rejects(foreign.read({ kind: 'page', id: foreignChild }), /scope|root/i);

  const protectedId = id(30);
  const protectedChild = id(31);
  const protectedScope = scope(
    profile({ protected: [{ kind: 'block', id: protectedId }] }),
    {
      [`/v1/blocks/${protectedChild}`]: block(protectedChild, {
        type: 'block_id',
        block_id: protectedId,
      }),
      [`/v1/blocks/${protectedId}`]: block(protectedId, {
        type: 'page_id',
        page_id: root,
      }),
    },
  );
  await assert.rejects(
    protectedScope.read({ kind: 'block', id: protectedChild }),
    /protected/i,
  );

  const protectedPage = id(32);
  const representedPage = scope(
    profile({ protected: [{ kind: 'page', id: protectedPage }] }),
    {
      [`/v1/blocks/${protectedPage}`]: {
        object: 'block',
        id: protectedPage,
        parent: { type: 'page_id', page_id: root },
        type: 'child_page',
        child_page: { title: 'Protected page' },
        has_children: true,
      },
    },
  );
  await assert.rejects(
    representedPage.read({ kind: 'block', id: protectedPage }),
    /protected/i,
  );
});

test('scope follows block columns to page roots and does not reuse authorization across profiles', async () => {
  const root = id(1);
  const column = id(40);
  const child = id(41);
  const routes = {
    '/v1/users/me': connection(),
    [`/v1/blocks/${child}`]: block(child, { type: 'block_id', block_id: column }),
    [`/v1/blocks/${column}`]: block(
      column,
      { type: 'page_id', page_id: root },
      'column',
    ),
    [`/v1/pages/${root}`]: page(root, { type: 'workspace', workspace: true }),
  };
  const client = new NotionClient('synthetic-token', {
    minIntervalMs: 0,
    fetch: scopedFetch(routes),
  });
  const first = new ScopedNotion(profile(), client);
  assert.equal((await first.read({ kind: 'block', id: child })).id, child);

  const second = new ScopedNotion(
    profile({ key: 'other', aliases: [], roots: [{ kind: 'page', id: id(2) }] }),
    client,
  );
  await assert.rejects(second.read({ kind: 'block', id: child }), /scope|root/i);

  const differentBot = new ScopedNotion(
    profile({
      key: 'praetor',
      aliases: ['addy-law'],
      connection: { botId: id(92), workspaceId: id(91) },
    }),
    client,
  );
  await assert.rejects(
    differentBot.read({ kind: 'block', id: child }),
    /bot|connection/i,
  );
});

test('page containers retain date-mention paragraphs when listing children', async () => {
  const root = id(1);
  const mention = block(id(50), { type: 'page_id', page_id: root });
  mention.paragraph = {
    rich_text: [
      {
        type: 'mention',
        mention: { type: 'date', date: { start: '2026-09-06' } },
      },
    ],
  };
  const scoped = new ScopedNotion(
    profile(),
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      fetch: scopedFetch({
        '/v1/users/me': connection(),
        [`/v1/pages/${root}`]: page(root, { type: 'workspace', workspace: true }),
        [`/v1/blocks/${root}/children`]: {
          object: 'list',
          results: [mention],
          has_more: false,
          next_cursor: null,
        },
      }),
    }),
  );
  const children = await scoped.children(root);
  assert.deepEqual(children, [mention]);
  assert.equal(blockText(children[0] ?? {}), '2026-09-06');
});

test('data-source queries are scoped through their database and preserve the query body', async () => {
  const root = id(1);
  const database = id(60);
  const sourceId = id(61);
  const seenBodies: JsonObject[] = [];
  let queryRows = [page(id(62), { type: 'data_source_id', data_source_id: sourceId })];
  const scoped = new ScopedNotion(
    profile(),
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      fetch: scopedFetch({
        '/v1/users/me': connection(),
        [`/v1/data_sources/${sourceId}`]: {
          object: 'data_source',
          id: sourceId,
          parent: { type: 'database_id', database_id: database },
        },
        [`/v1/databases/${database}`]: {
          object: 'database',
          id: database,
          parent: { type: 'page_id', page_id: root },
        },
        [`/v1/data_sources/${sourceId}/query`]: (_url, init) => {
          const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
          seenBodies.push(object(parsed));
          return {
            object: 'list',
            results: queryRows,
            has_more: false,
            next_cursor: null,
          };
        },
      }),
    }),
  );
  const results = await scoped.query(sourceId, {
    filter: { property: 'Status', status: { equals: 'Pending' } },
  });
  assert.equal(results.length, 1);
  const firstBody = seenBodies[0];
  assert.ok(firstBody);
  assert.equal(firstBody.page_size, 100);
  assert.equal('start_cursor' in firstBody, false);
  assert.deepEqual(firstBody.filter, {
    property: 'Status',
    status: { equals: 'Pending' },
  });
  queryRows = [page(id(62), { type: 'workspace', workspace: true })];
  await assert.rejects(scoped.query(sourceId), /scope|root/i);
});

test('search skips known out-of-scope results but propagates transport failures', async () => {
  const root = id(1);
  const inside = id(70);
  const outside = id(71);
  const database = id(72);
  const dataSource = id(73);
  const dataSourceResult: JsonObject = {
    object: 'data_source',
    id: dataSource,
    parent: { type: 'database_id', database_id: database },
    title: [{ type: 'text', text: { content: 'Tasks database' } }],
    properties: { Task: { type: 'title', title: {} } },
  };
  const scoped = new ScopedNotion(
    profile(),
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      fetch: scopedFetch({
        '/v1/users/me': connection(),
        '/v1/search': {
          object: 'list',
          results: [
            page(inside, { type: 'page_id', page_id: root }),
            dataSourceResult,
            page(outside, { type: 'workspace', workspace: true }),
          ],
          has_more: false,
          next_cursor: null,
        },
        [`/v1/databases/${database}`]: {
          object: 'database',
          id: database,
          parent: { type: 'page_id', page_id: root },
        },
      }),
    }),
  );
  assert.deepEqual(await scoped.search('economics'), [
    page(inside, { type: 'page_id', page_id: root }),
    dataSourceResult,
  ]);

  const malformed = new ScopedNotion(
    profile(),
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      fetch: scopedFetch({
        '/v1/users/me': connection(),
        '/v1/search': {
          object: 'list',
          results: [{ object: 'page', id: id(74), properties: {} }],
          has_more: false,
          next_cursor: null,
        },
      }),
    }),
  );
  await assert.rejects(malformed.search('economics'), /malformed|parent/i);

  const failed = new ScopedNotion(
    profile(),
    new NotionClient('synthetic-token', {
      minIntervalMs: 0,
      maxAttempts: 1,
      fetch: fakeFetch(() => {
        throw new TypeError('network unavailable');
      }),
    }),
  );
  await assert.rejects(failed.search('economics'), /network|request|transport/i);
});
