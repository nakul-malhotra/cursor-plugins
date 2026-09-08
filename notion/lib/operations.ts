import { NotionError } from './errors.js';
import type { JsonObject, JsonValue, ResourceKind, ResourceRef } from './types.js';
import { array, fingerprint, isObject, notionId, object, string } from './values.js';

export type PageParent = ResourceRef & { kind: 'page' | 'data_source' };
export type Position =
  | { type: 'start' }
  | { type: 'end' }
  | { type: 'after_block'; after_block: { id: string } };
export interface Precondition {
  kind: ResourceKind | 'children' | 'query';
  id: string;
  hash: string;
}
export type Operation = (
  | { kind: 'append-blocks'; parentId: string; children: JsonObject[]; position?: Position }
  | { kind: 'update-block'; id: string; patch: JsonObject }
  | { kind: 'archive-block'; id: string }
  | { kind: 'create-page'; parent: PageParent; properties: JsonObject; children?: JsonObject[]; icon?: JsonValue; cover?: JsonValue }
  | { kind: 'update-page'; id: string; patch: JsonObject }
  | { kind: 'move-page'; id: string; parent: PageParent }
  | { kind: 'archive-page'; id: string }
  | { kind: 'create-database'; parent: ResourceRef & { kind: 'page' }; title: JsonValue[]; properties: JsonObject }
  | { kind: 'update-data-source'; id: string; patch: JsonObject; allowDeleteProperties?: string[] }
  | { kind: 'update-database'; id: string; patch: JsonObject }
  | { kind: 'create-comment'; parentId: string; richText: JsonValue[] }
) & {
  watches?: Array<{ ref: ResourceRef; children?: boolean }>;
  preconditions?: Precondition[];
};

export function stateFingerprint(value: unknown): string {
  return fingerprint(stateSnapshot(value));
}

export function stateSnapshot(value: unknown): JsonValue {
  const validated = object({ value }).value;
  if (validated === undefined) throw new NotionError('INVALID_VALUE', 'State must be JSON-compatible.');
  function stable(value: JsonValue, propertyNames = false): JsonValue {
    if (Array.isArray(value)) return value.map(item => stable(item));
    if (!isObject(value)) return value;
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      // Preserve user-defined column names while excluding generated metadata values.
      if (propertyNames || !['created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'request_id'].includes(key)) {
        result[key] = stable(item, key === 'properties');
      }
    }
    // Resource self-links change with titles; user-defined URL properties remain content.
    if (!propertyNames && typeof value.id === 'string' && typeof value.object === 'string'
      && ['page', 'database', 'data_source'].includes(value.object)) {
      delete result.url;
    }
    if (value.type === 'file' && isObject(result.file)) {
      const file = result.file;
      delete file.expiry_time;
      if (typeof file.url === 'string' && URL.canParse(file.url)) {
        const url = new URL(file.url);
        const hosted = url.hostname === 'file.notion.so'
          || url.hostname === 'secure.notion-static.com'
          || /^prod-files-secure\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
          || (/^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && url.pathname.startsWith('/secure.notion-static.com/'));
        if (url.protocol === 'https:' && hosted) {
          for (const key of [...url.searchParams.keys()]) {
            if (/^x-amz-/i.test(key) || ['awsaccesskeyid', 'signature', 'expires', 'policy', 'key-pair-id'].includes(key.toLowerCase())) url.searchParams.delete(key);
          }
          file.url = url.toString();
        }
      }
    }
    return result;
  }
  return stable(validated);
}

export function parseOperations(value: unknown): Operation[] {
  assertNoSecrets(value);
  try {
    let entries = value;
    if (!Array.isArray(entries)) {
      const wrapper = object(entries);
      keys(wrapper, ['operations']);
      entries = wrapper.operations;
    }
    const result = array(entries).map(parseOperation);
    requireOperation(result.length > 0 && result.length <= 100, 'A plan requires 1 to 100 operations.');
    return result;
  } catch (error) {
    if (error instanceof NotionError && ['INVALID_VALUE', 'INVALID_NOTION_ID'].includes(error.code)) {
      throw new NotionError('INVALID_OPERATION', 'Operation contains an invalid value or resource ID.');
    }
    throw error;
  }
}

export function requireOperation(condition: boolean, message: string): asserts condition {
  if (!condition) throw new NotionError('INVALID_OPERATION', message);
}

export function assertNoSecrets(value: unknown, depth = 0, seen = new Set<object>()): void {
  requireOperation(depth <= 40, 'Payload nesting exceeds the safe limit.');
  if (typeof value === 'string') {
    requireOperation(!/(?:secret_|ntn_)[a-zA-Z0-9_-]{16,}|bearer\s+\S+/i.test(value), 'API credentials cannot appear in persisted payloads.');
  } else if (value !== null && typeof value === 'object') {
    requireOperation(!seen.has(value), 'Payload must not contain cycles.');
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      requireOperation(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe payload key.');
      requireOperation(!/^(authorization|access_token|refresh_token|api[_-]?key|token|secret)$/i.test(key), 'Credential fields are prohibited.');
      assertNoSecrets(key, depth + 1, seen);
      assertNoSecrets(entry, depth + 1, seen);
    }
    seen.delete(value);
  }
}

function keys(value: JsonObject, allowed: string[]): void {
  requireOperation(Object.keys(value).every(key => allowed.includes(key)), 'Operation contains an unsupported field.');
}
function ref(value: unknown): ResourceRef {
  const item = object(value);
  keys(item, ['kind', 'id']);
  const kind = item.kind;
  requireOperation(kind === 'page' || kind === 'block' || kind === 'database' || kind === 'data_source', 'Unknown resource kind.');
  return { kind, id: notionId(string(item.id)) };
}
function pageParent(value: unknown): PageParent {
  const parent = ref(value);
  requireOperation(parent.kind === 'page' || parent.kind === 'data_source', 'Page parent must be a page or data source.');
  return { kind: parent.kind, id: parent.id };
}
function parseOperation(value: JsonValue): Operation {
  const item = object(value);
  const kind = string(item.kind);
  const common = ['kind', 'watches', 'preconditions'];
  const fields: Record<string, string[]> = {
    'append-blocks': ['parentId', 'children', 'position'],
    'update-block': ['id', 'patch'], 'archive-block': ['id'],
    'create-page': ['parent', 'properties', 'children', 'icon', 'cover'],
    'update-page': ['id', 'patch'], 'move-page': ['id', 'parent'], 'archive-page': ['id'],
    'create-database': ['parent', 'title', 'properties'],
    'update-data-source': ['id', 'patch', 'allowDeleteProperties'],
    'update-database': ['id', 'patch'], 'create-comment': ['parentId', 'richText'],
  };
  const allowed = fields[kind];
  requireOperation(allowed !== undefined, 'Unknown operation kind.');
  keys(item, [...common, ...allowed]);
  const watches = {
    ...(item.watches === undefined ? {} : { watches: array(item.watches).map(watch => {
      const w = object(watch);
      keys(w, ['ref', 'children']);
      requireOperation(w.children === undefined || typeof w.children === 'boolean', 'Watch children must be boolean.');
      return { ref: ref(w.ref), ...(w.children === undefined ? {} : { children: w.children }) };
    }) }),
    ...(item.preconditions === undefined ? {} : { preconditions: array(item.preconditions).map((entry): Precondition => {
      const condition = object(entry);
      keys(condition, ['kind', 'id', 'hash']);
      const kind = condition.kind;
      requireOperation(kind === 'page' || kind === 'block' || kind === 'database' || kind === 'data_source' || kind === 'children' || kind === 'query', 'Unknown precondition kind.');
      const hash = string(condition.hash);
      requireOperation(/^[a-f0-9]{64}$/.test(hash), 'Precondition hash must be a lowercase SHA-256 fingerprint.');
      return { kind, id: notionId(string(condition.id)), hash };
    }) }),
  };
  switch (kind) {
    case 'append-blocks': {
      const position = item.position === undefined ? undefined : object(item.position);
      let parsed: Position | undefined;
      if (position !== undefined) {
        if (position.type === 'start' || position.type === 'end') {
          keys(position, ['type']);
          parsed = { type: position.type };
        } else {
          keys(position, ['type', 'after_block']);
          requireOperation(position.type === 'after_block', 'Unknown append position.');
          const anchor = object(position.after_block);
          keys(anchor, ['id']);
          parsed = { type: 'after_block', after_block: { id: notionId(string(anchor.id)) } };
        }
      }
      return { kind, parentId: notionId(string(item.parentId)), children: blocks(item.children), ...(parsed ? { position: parsed } : {}), ...watches };
    }
    case 'archive-block': case 'archive-page':
      return { kind, id: notionId(string(item.id)), ...watches };
    case 'move-page':
      return { kind, id: notionId(string(item.id)), parent: pageParent(item.parent), ...watches };
    case 'create-page': {
      const properties = pageProperties(item.properties);
      return {
        kind, parent: pageParent(item.parent), properties, ...watches,
        ...(item.children === undefined ? {} : { children: blocks(item.children) }),
        ...(item.icon === undefined ? {} : { icon: image(item.icon, true) }),
        ...(item.cover === undefined ? {} : { cover: image(item.cover, false) }),
      };
    }
    case 'create-database': {
      const p = pageParent(item.parent);
      requireOperation(p.kind === 'page', 'Database parent must be a page.');
      return { kind, parent: { kind: 'page', id: p.id }, title: rich(item.title), properties: schema(item.properties), ...watches };
    }
    case 'create-comment':
      return { kind, parentId: notionId(string(item.parentId)), richText: rich(item.richText), ...watches };
    case 'update-block': {
      const patch = object(item.patch);
      const names = Object.keys(patch);
      requireOperation(names.length === 1, 'Block update must contain exactly its actual content type.');
      const type = names[0] ?? '';
      patch[type] = blockContent(type, patch[type], false, 0);
      return { kind, id: notionId(string(item.id)), patch, ...watches };
    }
    case 'update-page': case 'update-data-source': case 'update-database': {
      const patch = object(item.patch);
      keys(patch, kind === 'update-page' ? ['properties', 'icon', 'cover']
        : kind === 'update-data-source' ? ['properties', 'title', 'description', 'icon']
          : ['title', 'description', 'icon', 'cover', 'is_inline']);
      requireOperation(Object.keys(patch).length > 0, 'An update requires at least one field.');
      if (patch.properties !== undefined) requireOperation(Object.keys(object(patch.properties)).length > 0, 'Empty property updates have no reviewed effect.');
      if (patch.properties !== undefined) patch.properties = kind === 'update-page' ? pageProperties(patch.properties) : schema(patch.properties);
      if (patch.title !== undefined) patch.title = rich(patch.title);
      if (patch.description !== undefined) patch.description = rich(patch.description);
      if (patch.icon !== undefined) patch.icon = image(patch.icon, true);
      if (patch.cover !== undefined) patch.cover = image(patch.cover, false);
      if (patch.is_inline !== undefined) requireOperation(typeof patch.is_inline === 'boolean', 'is_inline must be boolean.');
      const base = { id: notionId(string(item.id)), patch, ...watches };
      if (kind !== 'update-data-source') return { kind, ...base };
      const allow = item.allowDeleteProperties === undefined ? undefined : array(item.allowDeleteProperties).map(entry => string(entry));
      if (allow) requireOperation(new Set(allow).size === allow.length && allow.every(name => name.length > 0), 'Deletion names must be exact and unique.');
      return { kind, ...base, ...(allow === undefined ? {} : { allowDeleteProperties: allow }) };
    }
    default: throw new NotionError('INVALID_OPERATION', 'Unknown operation kind.');
  }
}

export function richTextType(value: JsonObject): 'text' | 'mention' | 'equation' {
  let type = value.type;
  if (type === undefined || type === null) {
    if ('text' in value) type = 'text';
    else if ('mention' in value) type = 'mention';
    else type = 'equation';
  }
  requireOperation(type === 'text' || type === 'mention' || type === 'equation', 'Unsupported rich text type.');
  return type;
}

function rich(value: unknown): JsonValue[] {
  const entries = array(value);
  requireOperation(entries.length <= 100, 'Rich text is limited to 100 items.');
  return entries.map(entry => {
    const item = object(entry);
    keys(item, ['type', 'text', 'mention', 'equation', 'annotations']);
    const type = richTextType(item);
    requireOperation(['text', 'mention', 'equation'].filter(name => name in item).length === 1 && type in item, 'Rich text type and content must agree.');
    if (type === 'text') {
      const text = object(item.text);
      keys(text, ['content', 'link']);
      requireOperation(string(text.content).length <= 2000, 'Rich text content is limited to 2000 characters.');
      if (text.link !== undefined && text.link !== null) {
        const link = object(text.link); keys(link, ['url']); url(link.url);
      }
    } else if (type === 'equation') {
      const equation = object(item.equation); keys(equation, ['expression']); string(equation.expression);
    } else {
      const mention = object(item.mention);
      const mtype = string(mention.type);
      keys(mention, ['type', mtype]);
      requireOperation(['page', 'database', 'data_source', 'user', 'date'].includes(mtype), 'Unsupported mention type.');
      const target = object(mention[mtype]);
      if (mtype === 'date') validateDate(target);
      else { keys(target, ['id']); target.id = notionId(string(target.id)); mention[mtype] = target; }
      item.mention = mention;
    }
    if (item.annotations !== undefined) {
      const annotations = object(item.annotations);
      keys(annotations, ['bold', 'italic', 'strikethrough', 'underline', 'code', 'color']);
      for (const [key, v] of Object.entries(annotations)) requireOperation(key === 'color' ? typeof v === 'string' : typeof v === 'boolean', 'Invalid rich text annotation.');
    }
    return item;
  });
}
function url(value: unknown): void {
  const text = string(value);
  requireOperation(/^https?:\/\/[^\s]+$/i.test(text), 'Only HTTP(S) content URLs are supported.');
  const parsed = new URL(text);
  requireOperation(parsed.username === '' && parsed.password === '', 'Content URLs cannot contain credentials.');
}
function image(value: JsonValue, emoji: boolean): JsonValue {
  if (value === null) return null;
  const item = object(value);
  if (emoji && item.type === 'emoji') { keys(item, ['type', 'emoji']); string(item.emoji); return item; }
  requireOperation(item.type === 'external', 'Only external images and emoji icons are supported.');
  keys(item, ['type', 'external']);
  const external = object(item.external); keys(external, ['url']); url(external.url);
  return item;
}
function validateDate(value: JsonObject): void {
  keys(value, ['start', 'end', 'time_zone']);
  string(value.start);
  if (value.end !== undefined && value.end !== null) string(value.end);
  if (value.time_zone !== undefined && value.time_zone !== null) string(value.time_zone);
}

const contentFields: Record<string, string[]> = {
  paragraph: ['rich_text', 'color', 'children'],
  heading_1: ['rich_text', 'color', 'is_toggleable', 'children'],
  heading_2: ['rich_text', 'color', 'is_toggleable', 'children'],
  heading_3: ['rich_text', 'color', 'is_toggleable', 'children'],
  bulleted_list_item: ['rich_text', 'color', 'children'], numbered_list_item: ['rich_text', 'color', 'children'],
  to_do: ['rich_text', 'checked', 'color', 'children'], toggle: ['rich_text', 'color', 'children'],
  quote: ['rich_text', 'color', 'children'], callout: ['rich_text', 'icon', 'color', 'children'],
  code: ['rich_text', 'caption', 'language'], divider: [], breadcrumb: [],
  equation: ['expression'], bookmark: ['url', 'caption'], embed: ['url', 'caption'],
  image: ['type', 'external', 'caption'], video: ['type', 'external', 'caption'],
  file: ['type', 'external', 'caption', 'name'], pdf: ['type', 'external', 'caption'],
  column_list: ['children'], column: ['children'], table: ['table_width', 'has_column_header', 'has_row_header', 'children'],
  table_row: ['cells'], table_of_contents: ['color'], link_to_page: ['type', 'page_id'],
};
function blocks(value: unknown, depth = 0): JsonObject[] {
  const entries = array(value);
  requireOperation(entries.length > 0 && entries.length <= 100 && depth <= 1, 'Blocks require 1 to 100 children and at most two nesting levels.');
  return entries.map(entry => {
    const block = object(entry);
    const type = string(block.type);
    keys(block, ['object', 'type', type]);
    requireOperation(block.object === undefined || block.object === 'block', 'Expected a block object.');
    block[type] = blockContent(type, block[type], true, depth);
    return block;
  });
}
function blockContent(type: string, value: unknown, creating: boolean, depth: number): JsonObject {
  const allowed = contentFields[type];
  requireOperation(allowed !== undefined, 'Unsupported block content type.');
  const content = object(value);
  keys(content, creating ? allowed : allowed.filter(key => key !== 'children'));
  requireOperation(creating || Object.keys(content).length > 0, 'Empty block updates have no reviewed effect.');
  if (content.children !== undefined) content.children = blocks(content.children, depth + 1);
  if (content.rich_text !== undefined) content.rich_text = rich(content.rich_text);
  if (content.caption !== undefined) content.caption = rich(content.caption);
  if (content.icon !== undefined) image(content.icon, true);
  if (content.url !== undefined) url(content.url);
  if (content.external !== undefined) image({ type: content.type ?? null, external: content.external }, false);
  for (const field of ['checked', 'is_toggleable', 'has_column_header', 'has_row_header']) {
    if (content[field] !== undefined) requireOperation(typeof content[field] === 'boolean', `Invalid ${field}.`);
  }
  for (const field of ['color', 'language', 'expression', 'name']) if (content[field] !== undefined) string(content[field]);
  if (content.table_width !== undefined) requireOperation(typeof content.table_width === 'number' && Number.isInteger(content.table_width) && content.table_width > 0, 'Invalid table width.');
  if (content.cells !== undefined) content.cells = array(content.cells).map(cell => rich(cell));
  if (type === 'link_to_page') {
    requireOperation(creating && content.type === 'page_id', 'Only new page links are supported.');
    content.page_id = notionId(string(content.page_id));
  }
  return content;
}

function pageProperties(value: unknown): JsonObject {
  const properties = object(value);
  for (const [name, property] of Object.entries(properties)) {
    const p = object(property);
    const names = Object.keys(p).filter(key => key !== 'type');
    requireOperation(names.length === 1, 'Page property must have exactly one value type.');
    const type = names[0] ?? '';
    requireOperation(p.type === undefined || p.type === type, 'Page property type mismatch.');
    const v = p[type];
    switch (type) {
      case 'title': case 'rich_text': p[type] = rich(v); break;
      case 'number': requireOperation(v === null || typeof v === 'number', 'Invalid number property.'); break;
      case 'checkbox': requireOperation(typeof v === 'boolean', 'Invalid checkbox property.'); break;
      case 'url': case 'email': case 'phone_number': requireOperation(v === null || typeof v === 'string', 'Invalid text property.'); break;
      case 'date': if (v !== null) validateDate(object(v)); break;
      case 'select': case 'status': if (v !== null) option(v); break;
      case 'multi_select': array(v).forEach(option); break;
      case 'relation': case 'people':
        p[type] = array(v).map(entry => {
          const target = object(entry); keys(target, type === 'people' ? ['id', 'object'] : ['id']);
          requireOperation(target.object === undefined || target.object === 'user', 'People values must identify users.');
          return { ...target, id: notionId(string(target.id)) };
        });
        break;
      default: throw new NotionError('INVALID_OPERATION', 'Unsupported page property value.');
    }
    properties[name] = p;
  }
  return properties;
}
function option(value: unknown): void {
  const item = object(value); keys(item, ['id', 'name', 'color']);
  requireOperation(typeof item.id === 'string' || typeof item.name === 'string', 'An option requires an ID or name.');
  if (item.color !== undefined) string(item.color);
}

const schemaTypes = ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'people', 'files', 'checkbox', 'url', 'email', 'phone_number', 'relation'];
export function schemaPropertyType(value: JsonObject): string {
  if (typeof value.type === 'string') return value.type;
  const inferred = schemaTypes.find(type => type in value);
  requireOperation(inferred !== undefined, 'Schema property has no supported type.');
  return inferred;
}
function schema(value: unknown): JsonObject {
  const properties = object(value);
  for (const [name, property] of Object.entries(properties)) {
    if (property === null) continue;
    const p = object(property);
    const types = schemaTypes.filter(type => type in p);
    requireOperation(types.length === 1, 'Schema property requires one supported type; renames and computed/status schema changes are unsupported.');
    const type = types[0] ?? '';
    keys(p, ['type', type]);
    requireOperation(p.type === undefined || p.type === type, 'Schema property type mismatch.');
    const content = object(p[type]);
    if (type === 'select' || type === 'multi_select') {
      keys(content, ['options']);
      array(content.options).forEach(option);
    } else if (type === 'number') {
      keys(content, ['format']); if (content.format !== undefined) string(content.format);
    } else if (type === 'relation') {
      keys(content, ['type', 'data_source_id', 'single_property']);
      requireOperation(content.type === 'single_property', 'Only single-property relations are supported; reverse schema writes are prohibited.');
      content.data_source_id = notionId(string(content.data_source_id));
      keys(object(content.single_property), []);
    } else keys(content, []);
    p[type] = content;
    properties[name] = p;
  }
  return properties;
}

export function payloadReferences(operation: Operation): ResourceRef[] {
  const refs: ResourceRef[] = [];
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObject(value)) return;
    if (isObject(value.mention)) {
      const kind = value.mention.type;
      if (kind === 'page' || kind === 'database' || kind === 'data_source') {
        refs.push({ kind, id: notionId(string(object(value.mention[kind]).id)) });
      }
    }
    if (Array.isArray(value.relation)) {
      for (const entry of value.relation) refs.push({ kind: 'page', id: notionId(string(object(entry).id)) });
    }
    if (isObject(value.relation) && value.relation.data_source_id !== undefined) {
      refs.push({ kind: 'data_source', id: notionId(string(value.relation.data_source_id)) });
    }
    if (isObject(value.link_to_page)) refs.push({ kind: 'page', id: notionId(string(value.link_to_page.page_id)) });
    Object.values(value).forEach(walk);
  }
  walk(operation);
  return refs;
}
