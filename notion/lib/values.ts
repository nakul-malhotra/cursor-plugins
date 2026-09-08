import { createHash } from 'node:crypto';
import { NotionError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';

export function object(value: unknown, label = 'value'): JsonObject {
  const validated = validateJson(value, label, new Set());
  if (validated === null || Array.isArray(validated) || typeof validated !== 'object') {
    throw new NotionError('INVALID_VALUE', `${label} must be a JSON object.`);
  }
  return validated;
}

export function array(value: unknown, label = 'value'): JsonValue[] {
  const validated = validateJson(value, label, new Set());
  if (!Array.isArray(validated)) {
    throw new NotionError('INVALID_VALUE', `${label} must be a JSON array.`);
  }
  return validated;
}

export function string(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') {
    throw new NotionError('INVALID_VALUE', `${label} must be a string.`);
  }
  return value;
}

export function isObject(value: unknown): value is JsonObject {
  try {
    const validated = validateJson(value, 'value', new Set());
    return validated !== null && typeof validated === 'object' && !Array.isArray(validated);
  } catch (error) {
    if (error instanceof NotionError && error.code === 'INVALID_VALUE') return false;
    throw error;
  }
}

export function notionId(value: string): string {
  const candidate = value.trim();
  const direct = exactId(candidate);
  if (direct !== undefined) return direct;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new NotionError('INVALID_NOTION_ID', 'Expected a Notion UUID or known Notion URL.');
  }
  if (url.protocol !== 'https:') {
    throw new NotionError('INVALID_NOTION_ID', 'Notion URLs must use HTTPS.');
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== 'notion.so'
    && host !== 'www.notion.so'
    && host !== 'app.notion.com'
    && host !== 'notion.site'
    && !host.endsWith('.notion.site')
  ) {
    throw new NotionError('INVALID_NOTION_ID', 'Expected a URL hosted by Notion.');
  }
  const pathId = url.pathname.match(
    /([a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})(?:\/)?$/,
  )?.[1];
  if (pathId === undefined) {
    throw new NotionError('INVALID_NOTION_ID', 'The Notion URL does not contain an exact page ID.');
  }
  const normalized = exactId(pathId);
  if (normalized === undefined) {
    throw new NotionError('INVALID_NOTION_ID', 'The Notion URL contains an invalid page ID.');
  }
  if (url.hash) {
    const blockId = exactId(url.hash.slice(1));
    if (blockId === undefined) {
      throw new NotionError('INVALID_NOTION_ID', 'The Notion URL fragment must identify an exact block.');
    }
    return blockId;
  }
  return normalized;
}

export function richText(text: string): JsonValue[] {
  return [{ type: 'text', text: { content: text } }];
}

export function blockText(block: JsonObject): string {
  const type = typeof block.type === 'string' ? block.type : undefined;
  const content = type === undefined ? block : block[type];
  return textFrom(content).join('');
}

export function pageTitle(page: JsonObject): string {
  const properties = page.properties;
  if (isObject(properties)) {
    for (const property of Object.values(properties)) {
      if (isObject(property) && property.type === 'title' && Array.isArray(property.title)) {
        const title = textFrom(property.title).join('');
        if (title.length > 0) return title;
      }
    }
  }
  if (Array.isArray(page.title)) return textFrom(page.title).join('');
  if (typeof page.title === 'string') return page.title;
  return '';
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(validateJson(value, 'value', new Set())));
  if (serialized === undefined) {
    throw new NotionError('INVALID_VALUE', 'Value cannot be represented as JSON.');
  }
  return serialized;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateJson(value: unknown, label: string, seen: Set<object>): JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NotionError('INVALID_VALUE', `${label} must contain finite JSON numbers.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new NotionError('INVALID_VALUE', `${label} must not contain cycles.`);
    }
    seen.add(value);
    const result = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) {
        throw new NotionError('INVALID_VALUE', `${label}[${index}] must contain a JSON value.`);
      }
      return validateJson(value[index], `${label}[${index}]`, seen);
    });
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (seen.has(value)) {
      throw new NotionError('INVALID_VALUE', `${label} must not contain cycles.`);
    }
    seen.add(value);
    const result = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        validateJson(entry, `${label}.${key}`, seen),
      ]),
    );
    seen.delete(value);
    return result;
  }
  throw new NotionError('INVALID_VALUE', `${label} must contain JSON-compatible values.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactId(value: string): string | undefined {
  if (
    !/^[a-fA-F0-9]{32}$/.test(value)
    && !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value)
  ) {
    return undefined;
  }
  const compact = value.replaceAll('-', '');
  const lower = compact.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

function textFrom(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || value === undefined || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(textFrom);
  if (typeof value.plain_text === 'string') return [value.plain_text];
  if (isObject(value.text) && typeof value.text.content === 'string') {
    return [value.text.content];
  }
  if (
    isObject(value.mention)
    && value.mention.type === 'date'
    && isObject(value.mention.date)
    && typeof value.mention.date.start === 'string'
  ) {
    return [value.mention.date.start];
  }
  if (typeof value.title === 'string') return [value.title];
  if (Array.isArray(value.rich_text)) return textFrom(value.rich_text);
  return [];
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalize(value[key] ?? null)]),
  );
}
