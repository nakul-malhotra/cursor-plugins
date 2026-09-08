import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotionClient } from '../lib/client.js';
import { ScopedNotion } from '../lib/scope.js';
import type { JsonObject, JsonValue, Profile, ResourceRef } from '../lib/types.js';

export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const text = (content: string): JsonObject[] => [{ type: 'text', text: { content } }];
export const paragraph = (content: string): JsonObject => ({
  object: 'block', type: 'paragraph', paragraph: { rich_text: text(content) },
});
function titleOf(value: JsonObject): string {
  const titles = value.object === 'page'
    ? Object.values(obj(value.properties)).find(property => Array.isArray(obj(property).title))
    : { title: value.title };
  const rich = titles === undefined ? [] : obj(titles).title;
  return Array.isArray(rich) ? rich.map(item => String(obj(obj(item).text).content)).join('') : '';
}
export function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    key: 'engine-test', label: 'Engine', aliases: ['et'], repositories: [],
    credentialRef: 'synthetic', connection: { botId: id(90), workspaceId: id(91) },
    roots: [{ kind: 'page', id: id(1) }], protected: [], canonical: {},
    timezone: 'UTC', todos: null, ...overrides,
  };
}
function obj(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Fixture expected object');
  return value as JsonObject;
}
function propertyType(value: JsonObject): string {
  return typeof value.type === 'string' ? value.type : Object.keys(value).find(key => key !== 'id') ?? '';
}
function emptyProperty(type: string): JsonObject {
  return { type, [type]: ['title', 'rich_text', 'multi_select', 'people', 'relation', 'files'].includes(type) ? [] : type === 'checkbox' ? false : null };
}
function response(value: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(responseDefaults(value)), { status, headers: { 'content-type': 'application/json' } });
}
function responseDefaults(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(responseDefaults);
  if (typeof value !== 'object' || value === null) return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, responseDefaults(child)]));
  if (result.object === 'page') {
    result.url ??= `https://app.notion.com/p/${encodeURIComponent(titleOf(result).replaceAll(' ', '-'))}-${String(result.id).replaceAll('-', '')}`;
  }
  if (result.type === 'paragraph') obj(result.paragraph).icon ??= null;
  if (result.type === 'mention' && obj(result.mention).type === 'date') {
    const date = obj(obj(result.mention).date);
    date.end ??= null;
    date.time_zone ??= null;
  }
  return result;
}
export function parent(ref: ResourceRef): JsonObject {
  return { type: `${ref.kind}_id`, [`${ref.kind}_id`]: ref.id };
}

export class FakeNotion {
  resources = new Map<string, JsonObject>();
  lists = new Map<string, string[]>();
  comments = new Map<string, JsonObject>();
  writes: Array<{ path: string; method: string; body: JsonObject }> = [];
  requests: string[] = [];
  pageSize = 2;
  nextId = 100;
  failWrite = 0;
  uncertainWrite = 0;
  onWrite?: () => Promise<void>;
  onRead?: (path: string) => Response | undefined | Promise<Response | undefined>;
  afterWrite?: (count: number) => void;
  corruptAppend = false;
  corruptMove = false;
  malformedWrite = 0;

  constructor() {
    this.page(1, null, 'Root');
    this.page(2, 1, 'Source');
    this.page(3, 1, 'Destination');
    this.page(4, 1, 'Destination'); // A title collision must not replace the exact ID.
    this.block(10, 2, { type: 'to_do', to_do: { rich_text: text('Keep checked'), checked: true } });
    this.block(11, 10, paragraph('Nested original'));
    this.block(12, 3, paragraph('Anchor'));
    this.resources.set(id(20), {
      object: 'database', id: id(20), parent: parent({ kind: 'page', id: id(1) }),
      title: text('Tasks'), data_sources: [{ id: id(21), name: 'Tasks' }], in_trash: false,
    });
    this.resources.set(id(21), {
      object: 'data_source', id: id(21), parent: parent({ kind: 'database', id: id(20) }),
      title: text('Tasks'), properties: {
        Name: { id: 'title', type: 'title', title: {} },
        State: { id: 'state', type: 'select', select: { options: [
          { id: 'pending', name: 'Pending', color: 'orange' },
          { id: 'done', name: 'Done', color: 'green' },
        ] } },
        Retire: { id: 'retire', type: 'number', number: { format: 'number' } },
      },
    });
  }
  get(resourceId: string): JsonObject {
    const found = this.resources.get(resourceId);
    if (!found) throw new Error(`Fixture missing resource ${resourceId}`);
    return found;
  }
  page(n: number, parentNumber: number | null, title: string): void {
    this.resources.set(id(n), {
      object: 'page', id: id(n),
      parent: parentNumber === null ? { type: 'workspace', workspace: true } : parent({ kind: 'page', id: id(parentNumber) }),
      properties: { title: { type: 'title', title: text(title) } }, icon: null, cover: null, in_trash: false,
    });
    if (parentNumber !== null) this.addToList(id(parentNumber), id(n));
  }
  addToList(parentId: string, childId: string): void {
    this.lists.set(parentId, [...(this.lists.get(parentId) ?? []), childId]);
    const parent = this.resources.get(parentId);
    if (parent?.object === 'block') parent.has_children = true;
  }
  block(n: number, parentNumber: number, content: JsonObject): void {
    this.resources.set(id(n), {
      object: 'block', ...content, id: id(n), parent: parent({
        kind: this.get(id(parentNumber)).object === 'page' ? 'page' : 'block', id: id(parentNumber),
      }), in_trash: false, has_children: false,
    });
    this.addToList(id(parentNumber), id(n));
  }
  childObjects(parentId: string): JsonObject[] {
    return (this.lists.get(parentId) ?? []).filter(child => this.get(child).in_trash !== true).map(child => this.blockView(child));
  }
  blockView(resourceId: string): JsonObject {
    const value = structuredClone(this.get(resourceId));
    if (value.object !== 'page' && value.object !== 'database') return value;
    const type = value.object === 'page' ? 'child_page' : 'child_database';
    return {
      object: 'block', id: resourceId, type, [type]: { title: titleOf(value) },
      parent: value.parent ?? null, has_children: (this.lists.get(resourceId)?.length ?? 0) > 0,
      in_trash: value.in_trash ?? false,
    };
  }
  addBlock(parentId: string, value: JsonObject): string {
    const childId = id(this.nextId++);
    const type = String(value.type);
    const content = obj(structuredClone(value[type]));
    const children = content.children;
    delete content.children;
    this.resources.set(childId, {
      object: 'block', type, [type]: content, id: childId,
      parent: parent({ kind: this.get(parentId).object === 'page' ? 'page' : 'block', id: parentId }),
      in_trash: false, has_children: Array.isArray(children) && children.length > 0,
    });
    if (Array.isArray(children)) {
      for (const nested of children) this.addToList(childId, this.addBlock(childId, obj(nested)));
    }
    return childId;
  }
  archive(resourceId: string): void {
    this.get(resourceId).in_trash = true;
    for (const [childId, child] of this.resources) {
      const p = obj(child.parent);
      if (p[String(p.type)] === resourceId) this.archive(childId);
    }
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.notion.com') throw new Error('Fixture refuses external origin');
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${path}${url.search}`);
    if (method === 'GET' && this.onRead) {
      const override = await this.onRead(path);
      if (override !== undefined) return override;
    }
    if (path === '/users/me') return response({
      object: 'user', id: id(90), type: 'bot', bot: { workspace_id: id(91) },
    });
    const parts = path.split('/').filter(Boolean);
    const resourceId = parts[1] ?? '';
    const body = typeof init?.body === 'string' ? obj(JSON.parse(init.body)) : {};
    if (method === 'GET' && parts[2] === 'children') {
      if (!this.resources.has(resourceId) || this.get(resourceId).in_trash === true) {
        return response({ code: 'object_not_found', message: 'Children unavailable for an archived resource' }, 404);
      }
      const all = this.childObjects(resourceId);
      const start = Number(url.searchParams.get('start_cursor') ?? 0);
      const more = start + this.pageSize < all.length;
      return response({ object: 'list', results: all.slice(start, start + this.pageSize), has_more: more, next_cursor: more ? String(start + this.pageSize) : null });
    }
    if (method === 'POST' && parts[2] === 'query') {
      const all = [...this.resources.values()].filter(item => {
        const p = obj(item.parent);
        return item.object === 'page' && p.data_source_id === resourceId && item.in_trash !== true;
      });
      const start = Number(body.start_cursor ?? 0);
      const more = start + this.pageSize < all.length;
      return response({ object: 'list', results: all.slice(start, start + this.pageSize), has_more: more, next_cursor: more ? String(start + this.pageSize) : null });
    }
    if (method === 'GET' && parts[0] === 'comments') {
      return response({ object: 'list', results: [...this.comments.values()].filter(item => obj(item.parent).page_id === url.searchParams.get('block_id')), has_more: false, next_cursor: null });
    }
    if (method === 'GET') {
      const value = this.resources.get(resourceId);
      if (!value) return response({ code: 'object_not_found', message: 'missing' }, 404);
      if (parts[0] === 'pages' && value.object === 'block') {
        return response({
          code: 'validation_error',
          message: `Provided ID ${resourceId} is a block, not a page. Use the retrieve block API instead`,
        }, 400);
      }
      if ((parts[0] === 'pages' && value.object !== 'page') ||
          (parts[0] === 'data_sources' && value.object !== 'data_source') ||
          (parts[0] === 'databases' && value.object !== 'database')) {
        return response({ code: 'object_not_found', message: 'wrong collection' }, 404);
      }
      if (parts[0] === 'blocks') return response(this.blockView(resourceId));
      return response(value);
    }
    this.writes.push({ path, method, body: structuredClone(body) });
    if (this.onWrite) await this.onWrite();
    const count = this.writes.length;
    if (this.failWrite === count) return response({ code: 'validation_error', message: 'definite refusal' }, 400);
    let result: JsonObject;
    if (parts[2] === 'move') {
      const page = this.get(resourceId);
      const old = obj(page.parent);
      const oldId = String(old[String(old.type)]);
      this.lists.set(oldId, (this.lists.get(oldId) ?? []).filter(child => child !== resourceId));
      page.parent = body.parent ?? null;
      const target = obj(body.parent);
      this.addToList(String(target[String(target.type)]), resourceId);
      if (this.corruptMove) obj(this.get(id(10)).to_do).checked = false;
      result = page;
    } else if (parts[2] === 'children') {
      if (!Array.isArray(body.children)) throw new Error('Fixture missing children');
      const old = this.lists.get(resourceId) ?? [];
      const created = body.children.map(child => this.addBlock(resourceId, obj(child)));
      const position = body.position === undefined ? { type: 'end' } : obj(body.position);
      const offset = position.type === 'start' ? 0 : position.type === 'after_block'
        ? old.indexOf(String(obj(position.after_block).id)) + 1 : old.length;
      this.lists.set(resourceId, [...old.slice(0, this.corruptAppend ? old.length : offset), ...created, ...old.slice(this.corruptAppend ? old.length : offset)]);
      if (this.get(resourceId).object === 'block') this.get(resourceId).has_children = true;
      result = { object: 'list', results: created.map(child => this.get(child)), has_more: false, next_cursor: null };
    } else if (path === '/pages') {
      const newId = id(this.nextId++);
      const p = obj(body.parent);
      const page: JsonObject = { object: 'page', id: newId, ...body, in_trash: false, icon: body.icon ?? null, cover: body.cover ?? null };
      delete page.children;
      if (p.type === 'data_source_id') {
        const properties: JsonObject = {};
        const requested = obj(body.properties);
        for (const [name, definition] of Object.entries(obj(this.get(String(p.data_source_id)).properties))) {
          const type = propertyType(obj(definition));
          properties[name] = requested[name] === undefined ? emptyProperty(type) : { type, ...obj(requested[name]) };
        }
        page.properties = properties;
      }
      this.resources.set(newId, page);
      this.addToList(String(p[String(p.type)]), newId);
      if (Array.isArray(body.children)) for (const child of body.children) this.addToList(newId, this.addBlock(newId, obj(child)));
      result = page;
    } else if (path === '/databases') {
      const newId = id(this.nextId++);
      const sourceId = id(this.nextId++);
      const p = obj(body.parent);
      const database: JsonObject = { object: 'database', id: newId, parent: p, title: body.title ?? [], data_sources: [{ id: sourceId }] };
      this.resources.set(newId, database);
      this.resources.set(sourceId, { object: 'data_source', id: sourceId, parent: { type: 'database_id', database_id: newId }, properties: obj(body.initial_data_source).properties ?? {} });
      this.addToList(String(p[String(p.type)]), newId);
      result = database;
    } else if (path === '/comments') {
      const newId = id(this.nextId++);
      result = { object: 'comment', id: newId, ...body };
      this.comments.set(newId, result);
    } else {
      const target = this.get(resourceId);
      if (method === 'DELETE') {
        target.in_trash = true;
        const p = obj(target.parent);
        const parentId = String(p[String(p.type)]);
        if (this.get(parentId).object === 'block') this.get(parentId).has_children = this.childObjects(parentId).length > 0;
      }
      else {
        for (const [key, value] of Object.entries(body)) {
          if (key === 'properties') {
            const properties = obj(target.properties);
            for (const [name, patch] of Object.entries(obj(value))) {
              if (patch === null) delete properties[name];
              else properties[name] = {
                ...(properties[name] ? obj(properties[name]) : {}),
                ...(target.object === 'data_source' ? { type: propertyType(obj(patch)) } : {}),
                ...obj(patch),
              };
            }
          } else if (key === target.type && typeof value === 'object' && value !== null) {
            target[key] = { ...obj(target[key]), ...obj(value) };
          } else target[key] = structuredClone(value);
        }
      }
      if (target.in_trash === true) this.archive(resourceId);
      result = target;
    }
    if (this.afterWrite) this.afterWrite(count);
    if (this.uncertainWrite === count) throw new TypeError('Synthetic disconnected write');
    if (this.malformedWrite === count) return new Response('{', { status: 200 });
    return response(result);
  };
}

export async function fixture(): Promise<{
  home: string; server: FakeNotion; scope: ScopedNotion; cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'notion-engine-'));
  const server = new FakeNotion();
  const scope = new ScopedNotion(profile(), new NotionClient('synthetic-token', {
    fetch: server.fetch, minIntervalMs: 0, maxAttempts: 1,
  }));
  return { home, server, scope, cleanup: async () => rm(home, { recursive: true }) };
}
