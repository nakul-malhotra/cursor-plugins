import { NotionError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';
import { array, isObject, object } from './values.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: JsonObject;
  version?: string;
  readOnly?: boolean;
}

export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  minIntervalMs?: number;
}

export class NotionClient {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #minIntervalMs: number;
  #nextRequestAt = 0;

  constructor(token: string, options: ClientOptions = {}) {
    if (token.trim().length === 0) {
      throw new NotionError('CLIENT_CONFIG', 'A Notion token is required.');
    }
    const maxAttempts = options.maxAttempts ?? 4;
    const minIntervalMs = options.minIntervalMs ?? 350;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new NotionError('CLIENT_CONFIG', 'maxAttempts must be an integer from 1 to 10.');
    }
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new NotionError('CLIENT_CONFIG', 'minIntervalMs must be a non-negative number.');
    }
    this.#token = token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? sleep;
    this.#maxAttempts = maxAttempts;
    this.#minIntervalMs = minIntervalMs;
  }

  assertNoCredentialContent(value: JsonValue): void {
    const pending: JsonValue[] = [value];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'string' && current.includes(this.#token)) {
        throw new NotionError('CREDENTIAL_CONTENT', 'The selected credential cannot appear in persisted Notion state.');
      }
      if (current === null || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const child of current) pending.push(child);
      } else {
        for (const [key, child] of Object.entries(current)) pending.push(key, child);
      }
    }
  }

  async request(path: string, options: RequestOptions = {}): Promise<JsonObject> {
    const route = routeUrl(path);
    const method = options.method ?? 'GET';
    const readOnly = options.readOnly ?? false;
    assertReadOnly(method, route.pathname.slice(3), readOnly);
    if (method === 'GET' && options.body !== undefined) {
      throw new NotionError('UNSAFE_REQUEST', 'GET requests cannot contain a request body.');
    }
    const serialized =
      options.body === undefined ? undefined : serializePayload(options.body);
    const idempotent = method === 'GET' || readOnly;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#throttle();
      let response: Response;
      try {
        response = await this.#fetch(route, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${this.#token}`,
            'notion-version': options.version ?? '2026-03-11',
            ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(serialized === undefined ? {} : { body: serialized }),
        });
      } catch {
        if (!idempotent) {
          throw uncertain(method, path);
        }
        if (attempt < this.#maxAttempts) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        throw new NotionError('TRANSPORT', 'Notion request failed before a response was received.', {
          method,
          path: safePath(path),
        });
      }

      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new NotionError('REDIRECT', 'Notion redirects are not allowed.', {
          status: response.status,
          path: safePath(path),
        });
      }
      if (response.ok) {
        let source: string;
        try {
          source = await response.text();
        } catch {
          if (!idempotent) throw uncertain(method, path, response.status);
          if (attempt < this.#maxAttempts) {
            await this.#sleep(backoff(attempt));
            continue;
          }
          throw new NotionError('TRANSPORT', 'Notion response body could not be read.', {
            method,
            path: safePath(path),
            status: response.status,
          });
        }
        try {
          return parseResponse(source, path);
        } catch (error) {
          if (!idempotent && error instanceof NotionError && error.code === 'MALFORMED_RESPONSE') {
            throw uncertain(method, path, response.status);
          }
          throw error;
        }
      }

      const failure = await responseError(response);
      const apiCode = failure.code;
      const details: JsonObject = {
        status: response.status,
        path: safePath(path),
        ...(apiCode === undefined ? {} : { apiCode }),
      };
      const pageId = /^\/v1\/pages\/([0-9a-f-]{36})$/.exec(route.pathname)?.[1];
      if (method === 'GET' && response.status === 400 && apiCode === 'validation_error'
        && pageId !== undefined && failure.message?.startsWith(`Provided ID ${pageId} is a block, not a page.`)) {
        throw new NotionError('WRONG_RESOURCE_KIND', 'This ID identifies a block rather than a page.', details);
      }
      if (response.status === 429 || response.status === 529) {
        if (!idempotent && response.status === 529) {
          throw uncertain(method, path, response.status);
        }
        if (attempt < this.#maxAttempts) {
          await this.#sleep(retryDelay(response, attempt));
          continue;
        }
        throw new NotionError('RATE_LIMITED', 'Notion remained unavailable after bounded retries.', details);
      }
      if (response.status >= 500 && response.status <= 599) {
        if (idempotent && attempt < this.#maxAttempts) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        if (!idempotent) throw uncertain(method, path, response.status);
      }
      const code = errorCode(response.status);
      throw new NotionError(code, `Notion request failed with status ${response.status}.`, details);
    }
    throw new NotionError('TRANSPORT', 'Notion request attempts were exhausted.');
  }

  async paginate(path: string, options: RequestOptions = {}): Promise<JsonObject[]> {
    routeUrl(path);
    const method = options.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      throw new NotionError('PAGINATION', 'Pagination supports GET and POST requests only.');
    }
    if (method === 'POST' && options.readOnly !== true) {
      throw new NotionError('PAGINATION', 'POST pagination requires an allowed read-only route.');
    }
    const results: JsonObject[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    if (method === 'POST' && typeof options.body?.start_cursor === 'string') {
      cursor = options.body.start_cursor;
      seen.add(cursor);
    }
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      let response: JsonObject;
      if (method === 'GET') {
        response = await this.request(withCursor(path, cursor), {
          ...options,
          method: 'GET',
          body: undefined,
        });
      } else {
        response = await this.request(path, {
          ...options,
          method: 'POST',
          body: {
            ...(options.body ?? {}),
            page_size: 100,
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
        });
      }
      const pageResults = array(response.results, 'pagination results').map((entry, index) =>
        object(entry, `pagination results[${index}]`),
      );
      results.push(...pageResults);
      if (typeof response.has_more !== 'boolean') {
        throw new NotionError('PAGINATION', 'Pagination response has malformed has_more.');
      }
      if (!response.has_more) return results;
      if (typeof response.next_cursor !== 'string' || response.next_cursor.length === 0) {
        throw new NotionError('PAGINATION', 'Pagination response is missing next_cursor.');
      }
      if (seen.has(response.next_cursor)) {
        throw new NotionError('PAGINATION', 'Pagination response repeated next_cursor.');
      }
      seen.add(response.next_cursor);
      cursor = response.next_cursor;
    }
    throw new NotionError('PAGINATION', 'Pagination exceeded the bounded page limit.');
  }

  async #throttle(): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.#nextRequestAt);
    this.#nextRequestAt = scheduled + this.#minIntervalMs;
    const delay = scheduled - now;
    if (delay > 0) await this.#sleep(delay);
  }
}

function routeUrl(path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new NotionError('UNSAFE_ROUTE', 'Notion routes must be relative paths beginning with one slash.');
  }
  if (path.includes('#')) {
    throw new NotionError('UNSAFE_ROUTE', 'Notion routes cannot contain fragments.');
  }
  const rawPath = path.split('?', 1)[0] ?? '';
  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new NotionError('UNSAFE_ROUTE', 'Notion route contains invalid encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new NotionError('UNSAFE_ROUTE', 'Notion route traversal is not allowed.');
    }
  }
  const route = new URL(`/v1${path}`, 'https://api.notion.com');
  if (
    route.origin !== 'https://api.notion.com'
    || route.username.length > 0
    || route.password.length > 0
    || !route.pathname.startsWith('/v1/')
  ) {
    throw new NotionError('UNSAFE_ROUTE', 'Notion route escaped the fixed API origin.');
  }
  for (const key of route.searchParams.keys()) {
    if (/^(?:access_?token|authorization|api_?key|password)$/i.test(key)) {
      throw new NotionError('UNSAFE_ROUTE', 'Credentials are not allowed in Notion routes.');
    }
  }
  return route;
}

function assertReadOnly(method: string, path: string, readOnly: boolean): void {
  if (!readOnly) return;
  if (
    method !== 'POST'
    || (path !== '/search' && !/^\/data_sources\/[^/]+\/query$/.test(path))
  ) {
    throw new NotionError('UNSAFE_REQUEST', 'readOnly is allowed only for known read-only POST routes.');
  }
}

function serializePayload(body: JsonObject): string {
  const validated = object(body, 'request body');
  const serialized = JSON.stringify(validated);
  if (serialized === undefined) {
    throw new NotionError('INVALID_VALUE', 'Notion request body cannot be represented as JSON.');
  }
  if (Buffer.byteLength(serialized) > 500 * 1024) {
    throw new NotionError('PAYLOAD_LIMIT', 'Notion request payload exceeds 500KB.');
  }
  if (inspectPayload(validated) > 1000) {
    throw new NotionError('PAYLOAD_LIMIT', 'Notion request payload exceeds 1000 total blocks.');
  }
  return serialized;
}

function inspectPayload(value: JsonValue, key?: string): number {
  if (typeof value === 'string') {
    if (key === 'content' && [...value].length > 2000) {
      throw new NotionError('PAYLOAD_LIMIT', 'Notion text.content exceeds 2000 characters.');
    }
    return 0;
  }
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    if (key === 'children') {
      if (value.length > 100) {
        throw new NotionError('PAYLOAD_LIMIT', 'A Notion children append cannot exceed 100 blocks.');
      }
    }
    let blocks = key === 'children' ? value.length : 0;
    for (const entry of value) {
      blocks += inspectPayload(entry);
    }
    return blocks;
  }
  let blocks = 0;
  for (const [childKey, entry] of Object.entries(value)) {
    blocks += inspectPayload(entry, childKey);
  }
  return blocks;
}

function parseResponse(source: string, path: string): JsonObject {
  if (source.length === 0) {
    throw new NotionError('MALFORMED_RESPONSE', 'Notion returned an empty response.', {
      path: safePath(path),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new NotionError('MALFORMED_RESPONSE', 'Notion returned malformed JSON.', {
      path: safePath(path),
    });
  }
  return object(parsed, 'Notion response');
}

async function responseError(response: Response): Promise<{ code?: string; message?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return {};
  }
  if (!isObject(parsed)) return {};
  return {
    ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
  };
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header === null) return backoff(attempt);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : backoff(attempt);
}

function backoff(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** (attempt - 1));
}

function errorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  return 'API_ERROR';
}

function withCursor(path: string, cursor: string | undefined): string {
  const route = new URL(path, 'https://pagination.invalid');
  route.searchParams.set('page_size', '100');
  if (cursor === undefined) route.searchParams.delete('start_cursor');
  else route.searchParams.set('start_cursor', cursor);
  return `${route.pathname}${route.search}`;
}

function safePath(path: string): string {
  return path.split('?', 1)[0] ?? '/';
}

function uncertain(method: string, path: string, status?: number): NotionError {
  return new NotionError('UNCERTAIN', 'The outcome of the Notion mutation is uncertain.', {
    method,
    path: safePath(path),
    ...(status === undefined ? {} : { status }),
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
