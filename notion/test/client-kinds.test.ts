import assert from 'node:assert/strict';
import test from 'node:test';
import { NotionClient } from '../lib/client.js';
import { NotionError } from '../lib/errors.js';
import { ScopedNotion } from '../lib/scope.js';
import { fakeFetch, id, jsonResponse, profile } from './helpers.js';

test('real Notion block-as-page validation errors permit a scoped block lookup', async () => {
  const requests: string[] = [];
  const remote = fakeFetch(url => {
    requests.push(url.pathname);
    if (url.pathname === '/v1/users/me') return jsonResponse({ id: id(90), bot: { workspace_id: id(91) } });
    if (url.pathname === `/v1/pages/${id(2)}`) return jsonResponse({
      code: 'validation_error', message: `Provided ID ${id(2)} is a block, not a page. Use the retrieve block API instead`,
    }, 400);
    if (url.pathname === `/v1/blocks/${id(2)}`) return jsonResponse({
      object: 'block', id: id(2), parent: { type: 'page_id', page_id: id(1) }, type: 'column', column: {},
    });
    if (url.pathname === `/v1/blocks/${id(2)}/children`) return jsonResponse({
      object: 'list', results: [], has_more: false, next_cursor: null,
    });
    throw new Error('Unexpected request');
  });
  const scope = new ScopedNotion(profile(), new NotionClient('synthetic', { fetch: remote, sleep: async () => {} }));
  assert.deepEqual(await scope.children(id(2)), []);
  assert.ok(requests.includes(`/v1/blocks/${id(2)}`));
});

test('other validation and permission errors do not trigger a resource-kind fallback', async () => {
  for (const status of [400, 403]) {
    const requests: string[] = [];
    const remote = fakeFetch(url => {
      requests.push(url.pathname);
      if (url.pathname === '/v1/users/me') return jsonResponse({ id: id(90), bot: { workspace_id: id(91) } });
      return jsonResponse({ code: 'validation_error', message: 'Another validation error' }, status);
    });
    const scope = new ScopedNotion(profile(), new NotionClient('synthetic', { fetch: remote, sleep: async () => {} }));
    await assert.rejects(scope.children(id(2)), error => error instanceof NotionError && error.details?.status === status);
    assert.equal(requests.some(path => path.startsWith('/v1/blocks/')), false);
  }
});
