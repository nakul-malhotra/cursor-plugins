import type { NotionClient } from './client.js';
import { isResourceLookupMiss, NotionError } from './errors.js';
import type { JsonObject, Profile, ResourceKind, ResourceRef } from './types.js';
import { isObject, notionId } from './values.js';

type ScopeContext = Map<string, JsonObject>;

const RESOURCE_PATH_SEGMENTS: Record<ResourceKind, string> = {
  page: 'pages',
  block: 'blocks',
  database: 'databases',
  data_source: 'data_sources',
};

export class ScopedNotion {
  #identity: JsonObject | undefined;

  constructor(
    public readonly profile: Profile,
    public readonly client: NotionClient,
  ) {}

  async verifyConnection(refresh = true): Promise<void> {
    if (refresh) this.#identity = undefined;
    const user = this.#identity ?? await this.client.request('/users/me');
    const actualBotId = resourceId(user, 'connection bot');
    if (actualBotId !== notionId(this.profile.connection.botId)) {
      throw new NotionError('CONNECTION_MISMATCH', 'The Notion connection uses the wrong bot.');
    }
    const expectedWorkspace = this.profile.connection.workspaceId;
    if (expectedWorkspace !== undefined) {
      const actualWorkspace = workspaceId(user);
      if (actualWorkspace === undefined || actualWorkspace !== notionId(expectedWorkspace)) {
        throw new NotionError(
          'CONNECTION_MISMATCH',
          'The Notion connection uses the wrong workspace.',
        );
      }
    }
    this.#identity = user;
  }

  async read(ref: ResourceRef): Promise<JsonObject> {
    await this.verifyConnection(false);
    const context: ScopeContext = new Map();
    const normalized = normalizeRef(ref);
    const resource = await this.#fetch(normalized, context);
    await this.#authorize(normalized, resource, context);
    return resource;
  }

  async children(id: string): Promise<JsonObject[]> {
    await this.verifyConnection(false);
    const context: ScopeContext = new Map();
    const normalizedId = notionId(id);
    let ref: ResourceRef = { kind: 'page', id: normalizedId };
    let resource: JsonObject;
    try {
      resource = await this.#fetch(ref, context);
    } catch (error) {
      if (!isResourceLookupMiss(error)) throw error;
      ref = { kind: 'block', id: normalizedId };
      resource = await this.#fetch(ref, context);
    }
    await this.#authorize(ref, resource, context);
    const children = await this.client.paginate(`/blocks/${normalizedId}/children`);
    const seen = new Set<string>();
    for (const child of children) {
      const childRef = actualRef(child);
      if (isProtectedResource(child, childRef, this.profile)) {
        throw new NotionError('PROTECTED', 'A protected Notion resource cannot be read.');
      }
      const childParent = parentRef(child);
      if (
        childRef.kind !== 'block'
        || childParent?.kind !== ref.kind
        || childParent.id !== ref.id
        || typeof child.has_children !== 'boolean'
        || childRef.id === ref.id
        || seen.has(childRef.id)
      ) {
        throw new NotionError('MALFORMED_RESPONSE', 'Notion returned an invalid child membership.');
      }
      seen.add(childRef.id);
    }
    return children;
  }

  async query(dataSourceId: string, body: JsonObject = {}): Promise<JsonObject[]> {
    await this.verifyConnection(false);
    const context: ScopeContext = new Map();
    const ref: ResourceRef = { kind: 'data_source', id: notionId(dataSourceId) };
    const source = await this.#fetch(ref, context);
    await this.#authorize(ref, source, context);
    const results = await this.client.paginate(`/data_sources/${ref.id}/query`, {
      method: 'POST',
      readOnly: true,
      body,
    });
    for (const result of results) {
      const resultRef = actualRef(result);
      context.set(refKey(resultRef), result);
      await this.#authorize(resultRef, result, context);
    }
    return results;
  }

  async search(query: string): Promise<JsonObject[]> {
    await this.verifyConnection(false);
    const results = await this.client.paginate('/search', {
      method: 'POST',
      readOnly: true,
      body: { query },
    });
    const scoped: JsonObject[] = [];
    for (const result of results) {
      const ref = actualRef(result);
      const context: ScopeContext = new Map();
      context.set(refKey(ref), result);
      try {
        await this.#authorize(ref, result, context);
        scoped.push(result);
      } catch (error) {
        if (
          error instanceof NotionError
          && (error.code === 'OUT_OF_SCOPE' || error.code === 'PROTECTED')
        ) {
          continue;
        }
        throw error;
      }
    }
    return scoped;
  }

  async comments(target: ResourceRef): Promise<JsonObject[]> {
    const ref = normalizeRef(target);
    if (ref.kind !== 'page' && ref.kind !== 'block') {
      throw new NotionError('INVALID_TARGET', 'Comments require a page or block target.');
    }
    await this.read(ref);
    return this.client.paginate(`/comments?block_id=${ref.id}`);
  }

  async #fetch(ref: ResourceRef, context: ScopeContext): Promise<JsonObject> {
    const key = refKey(ref);
    const cached = context.get(key);
    if (cached !== undefined) return cached;
    const resource = await this.client.request(resourcePath(ref));
    const actual = actualRef(resource);
    if (actual.kind !== ref.kind || actual.id !== ref.id) {
      throw new NotionError('KIND_MISMATCH', 'Notion returned a different resource kind or ID.');
    }
    context.set(key, resource);
    return resource;
  }

  async #authorize(
    startRef: ResourceRef,
    startResource: JsonObject,
    context: ScopeContext,
  ): Promise<void> {
    let ref = startRef;
    let resource = startResource;
    const visited = new Set<string>();
    for (let depth = 0; depth < 100; depth += 1) {
      const key = refKey(ref);
      if (visited.has(key)) {
        throw new NotionError('SCOPE_CYCLE', 'Notion ancestry contains a cycle.');
      }
      visited.add(key);
      if (isProtectedResource(resource, ref, this.profile)) {
        throw new NotionError('PROTECTED', 'A protected Notion resource cannot be read.');
      }
      if (isRoot(ref, this.profile)) return;
      const parent = parentRef(resource);
      if (parent === undefined) {
        throw new NotionError('OUT_OF_SCOPE', 'The Notion resource is outside configured roots.');
      }
      if (isProtected(parent, this.profile)) {
        throw new NotionError('PROTECTED', 'A protected Notion resource cannot be read.');
      }
      if (isRoot(parent, this.profile)) return;
      ref = parent;
      resource = await this.#fetch(ref, context);
    }
    throw new NotionError('SCOPE_DEPTH', 'Notion ancestry exceeded the bounded depth.');
  }
}

function normalizeRef(ref: ResourceRef): ResourceRef {
  return { kind: ref.kind, id: notionId(ref.id) };
}

function actualRef(resource: JsonObject): ResourceRef {
  const object = resource.object;
  if (!isResourceKind(object)) {
    throw new NotionError('MALFORMED_RESPONSE', 'Notion resource has an unknown object kind.');
  }
  return { kind: object, id: resourceId(resource, 'Notion resource') };
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === 'page' || value === 'block' || value === 'database' || value === 'data_source';
}

function resourceId(resource: JsonObject, label: string): string {
  if (typeof resource.id !== 'string') {
    throw new NotionError('MALFORMED_RESPONSE', `${label} is missing an ID.`);
  }
  return notionId(resource.id);
}

function workspaceId(user: JsonObject): string | undefined {
  const candidates: unknown[] = [user.workspace_id];
  if (isObject(user.bot)) {
    candidates.push(user.bot.workspace_id);
    if (isObject(user.bot.owner)) {
      candidates.push(user.bot.owner.workspace, user.bot.owner.workspace_id);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return notionId(candidate);
  }
  return undefined;
}

function resourcePath(ref: ResourceRef): string {
  return `/${RESOURCE_PATH_SEGMENTS[ref.kind]}/${ref.id}`;
}

function parentRef(resource: JsonObject): ResourceRef | undefined {
  if (!isObject(resource.parent) || typeof resource.parent.type !== 'string') {
    throw new NotionError('MALFORMED_RESPONSE', 'Notion resource is missing a valid parent reference.');
  }
  const parent = resource.parent;
  switch (parent.type) {
    case 'page_id':
      return parentId(parent.page_id, 'page');
    case 'block_id':
      return parentId(parent.block_id, 'block');
    case 'database_id':
      return parentId(parent.database_id, 'database');
    case 'data_source_id':
      return parentId(parent.data_source_id, 'data_source');
    case 'workspace':
      return undefined;
    default:
      throw new NotionError('MALFORMED_RESPONSE', 'Notion resource has an unknown parent type.');
  }
}

function parentId(value: unknown, kind: ResourceKind): ResourceRef {
  if (typeof value !== 'string') {
    throw new NotionError('MALFORMED_RESPONSE', 'Notion resource parent is missing an ID.');
  }
  return { kind, id: notionId(value) };
}

function refKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

function isRoot(ref: ResourceRef, profile: Profile): boolean {
  return containsRef(profile.roots, ref);
}

function isProtected(ref: ResourceRef, profile: Profile): boolean {
  return containsRef(profile.protected, ref);
}

function isProtectedResource(resource: JsonObject, ref: ResourceRef, profile: Profile): boolean {
  if (isProtected(ref, profile)) return true;
  if (ref.kind !== 'block') return false;
  const representedKind =
    resource.type === 'child_page'
      ? 'page'
      : resource.type === 'child_database'
        ? 'database'
        : undefined;
  return representedKind === undefined
    ? false
    : isProtected({ kind: representedKind, id: ref.id }, profile);
}

function containsRef(refs: ResourceRef[], target: ResourceRef): boolean {
  return refs.some(ref => ref.kind === target.kind && notionId(ref.id) === target.id);
}
