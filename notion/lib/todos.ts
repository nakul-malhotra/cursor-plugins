import {
  stateFingerprint,
  type Operation,
  type Position,
  type Precondition,
} from './operations.js';
import { NotionError } from './errors.js';
import type { ScopedNotion } from './scope.js';
import type {
  BlockTodoProfile,
  DatabaseTodoProfile,
  JsonObject,
  JsonValue,
} from './types.js';
import { blockText, isObject, notionId, richText } from './values.js';

class TodoError extends NotionError {
  constructor(message: string) {
    super('TODO_VALIDATION', message);
  }
}

export interface TodoItem {
  text: string;
  subitems?: string[];
}

export interface TodoRequest {
  intent: 'plan' | 'backlog' | 'log' | 'complete' | 'update';
  owner?: string;
  container?: string;
  section?: string;
  date?: string;
  items?: TodoItem[];
  id?: string;
  text?: string;
  checked?: boolean;
}

export type TodoScope = Pick<ScopedNotion, 'profile' | 'read' | 'children' | 'query'>;

export function parseTodoRequest(value: unknown): TodoRequest {
  const input = requireObject(value, 'Todo request');
  const allowed = new Set([
    'intent',
    'owner',
    'container',
    'section',
    'date',
    'items',
    'id',
    'text',
    'checked',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TodoError(`Unknown todo request field "${key}".`);
  }

  const intent = requireEnum(input.intent, 'intent', [
    'plan',
    'backlog',
    'log',
    'complete',
    'update',
  ]);
  if (intent === 'plan' || intent === 'backlog' || intent === 'log') {
    rejectPresent(input, ['id', 'text', 'checked'], intent);
    const itemsValue = input.items;
    if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
      throw new TodoError(`${intent} requires a nonempty items array.`);
    }
    const items = itemsValue.map((item, index) => parseTodoItem(item, index));
    const request: TodoRequest = { intent, items };
    assignOptionalString(request, 'owner', input.owner);
    assignOptionalString(request, 'container', input.container);
    assignOptionalString(request, 'section', input.section);
    assignOptionalDate(request, input.date);
    return request;
  }

  const id = notionId(requireNonemptyString(input.id, 'id'));
  rejectPresent(input, ['owner', 'container', 'section', 'date', 'items'], intent);
  if (intent === 'complete') {
    if (input.text !== undefined) throw new TodoError('complete does not accept text; use update.');
    if (input.checked !== undefined && typeof input.checked !== 'boolean') {
      throw new TodoError('checked must be a boolean.');
    }
    return input.checked === undefined ? { intent, id } : { intent, id, checked: input.checked };
  }

  const text = input.text === undefined ? undefined : requireTodoText(input.text, 'text');
  const checked = input.checked;
  if (checked !== undefined && typeof checked !== 'boolean') {
    throw new TodoError('checked must be a boolean.');
  }
  if (text === undefined && checked === undefined) {
    throw new TodoError('update requires text, checked, or both.');
  }
  return {
    intent,
    id,
    ...(text === undefined ? {} : { text }),
    ...(checked === undefined ? {} : { checked }),
  };
}

export function resolveDate(
  input: string | undefined,
  timezone: string,
  now: Date = new Date(),
): string {
  if (Number.isNaN(now.getTime())) throw new TodoError('now must be a valid Date.');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = dateParts(formatter, now);
  const normalized = input?.trim().toLocaleLowerCase('en-US');
  if (normalized === undefined || normalized === '' || normalized === 'today') return today;
  if (normalized === 'tomorrow') return addDays(today, 1);
  return validateCalendarDate(normalized, 'date');
}

export async function planTodos(
  scope: TodoScope,
  request: TodoRequest,
  now: Date = new Date(),
): Promise<Operation[]> {
  const todos = scope.profile.todos;
  if (todos === null) throw new TodoError(`Profile "${scope.profile.key}" has no todo configuration.`);
  const operations = await (todos.kind === 'blocks'
    ? planBlockTodos(scope, todos, request, now)
    : planDatabaseTodos(scope, todos, request, now));
  if (operations.length > 100) {
    throw new TodoError(`Todo request requires ${operations.length} operations; the plan limit is 100.`);
  }
  return operations;
}

export async function listTodos(
  scope: TodoScope,
  options: { owner?: string; container?: string; date?: string; section?: string } = {},
): Promise<JsonObject> {
  const todos = scope.profile.todos;
  if (todos === null) throw new TodoError(`Profile "${scope.profile.key}" has no todo configuration.`);
  if (todos.kind === 'blocks') {
    const profile = todos;
    const owner = selectedOwner(profile, options);
    const selected = resolveContainer(profile, owner, options.container, false);
    const blocks = await scope.children(selected.container.id);
    const section = selectedSection(selected.container, owner, options.section);
    const band = sectionBand(blocks, selected.container, section);
    if (options.date !== undefined && selected.container.layout !== 'dated') {
      throw new TodoError(`Container "${selected.key}" is not dated and does not accept date.`);
    }
    const date = options.date === undefined ? undefined : resolveDate(options.date, scope.profile.timezone);
    let selectedBlocks = blocks.slice(section === undefined ? band.start : band.start - 1, band.end);
    if (date !== undefined) {
      const headings = dateHeadings(blocks, band);
      const index = findDateIndex(headings, date);
      if (index === undefined) selectedBlocks = [];
      else {
        const range = dateRange(headings, index, band);
        selectedBlocks = blocks.slice(range.start - 1, range.end);
      }
    }
    return {
      layout: 'blocks',
      container: {
        key: selected.key,
        id: selected.container.id,
        layout: selected.container.layout,
        owner,
        ...(section === undefined ? {} : { section }),
        ...(date === undefined ? {} : { date }),
      },
      blocks: selectedBlocks,
    };
  }

  const source = await scope.read({ kind: 'data_source', id: todos.dataSourceId });
  validateDatabaseSchema(todos, source);
  if (options.container !== undefined || options.section !== undefined) {
    throw new TodoError('Database todo lists do not support container or section selectors.');
  }
  const owner = cleanOptional(options.owner);
  let mappedOwner: string | undefined;
  if (owner !== undefined) {
    if (todos.ownerProperty === undefined || todos.ownerType === undefined) {
      throw new TodoError('This todo database has no configured owner property.');
    }
    mappedOwner = exactRecordValue(todos.owners, owner);
    if (mappedOwner === undefined) throw new TodoError(`No database owner mapping exists for "${owner}".`);
    if (todos.ownerType === 'people') mappedOwner = notionId(mappedOwner);
  }
  if (options.date !== undefined && todos.dateProperty === undefined) {
    throw new TodoError('This todo database has no configured date property.');
  }
  const date = options.date === undefined ? undefined : resolveDate(options.date, scope.profile.timezone);
  const rows = (await scope.query(todos.dataSourceId)).filter(row =>
    databaseRowInListScope(todos, row, date, mappedOwner));
  return {
    layout: 'database',
    dataSourceId: todos.dataSourceId,
    ...(owner === undefined ? {} : { owner }),
    ...(date === undefined ? {} : { date }),
    rows,
  };
}

type TodoIntent = TodoRequest['intent'];
type CollectionIntent = Extract<TodoIntent, 'plan' | 'backlog' | 'log'>;
type PlannedOperation = Operation;
type BlockProfile = BlockTodoProfile;
type DatabaseProfile = DatabaseTodoProfile;
type BlockContainer = BlockTodoProfile['containers'][string];

interface SelectedContainer {
  key: string;
  container: BlockContainer;
}

interface Band {
  start: number;
  end: number;
}

interface DateHeading {
  index: number;
  id: string;
  date: string;
}

interface DatabaseSchema {
  source: JsonObject;
  properties: JsonObject;
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new TodoError(`${label} must be an object.`);
  return value;
}

function requireEnum<const Values extends readonly string[]>(
  value: JsonValue | undefined,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new TodoError(`${label} must be one of ${values.join(', ')}.`);
  }
  return value;
}

function requireNonemptyString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TodoError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function requireTodoText(value: JsonValue | undefined, label: string): string {
  return validatedTodoText(requireNonemptyString(value, label), label);
}

function validatedTodoText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new TodoError(`${label} must be a nonempty string.`);
  if ([...trimmed].length > 2000) {
    throw new TodoError(`${label} exceeds Notion's 2000-character rich-text limit.`);
  }
  return trimmed;
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function assignOptionalString(
  request: TodoRequest,
  key: 'owner' | 'container' | 'section',
  value: JsonValue | undefined,
): void {
  if (value === undefined) return;
  request[key] = requireNonemptyString(value, key);
}

function assignOptionalDate(request: TodoRequest, value: JsonValue | undefined): void {
  if (value === undefined) return;
  const date = requireNonemptyString(value, 'date');
  const normalized = date.toLocaleLowerCase('en-US');
  if (normalized !== 'today' && normalized !== 'tomorrow') validateCalendarDate(date, 'date');
  request.date = date;
}

function rejectPresent(input: JsonObject, fields: string[], intent: TodoIntent): void {
  for (const field of fields) {
    if (input[field] !== undefined) {
      throw new TodoError(`${intent} does not accept ${field}.`);
    }
  }
}

function parseTodoItem(value: JsonValue, index: number): TodoItem {
  const item = requireObject(value, `items[${index}]`);
  for (const key of Object.keys(item)) {
    if (key !== 'text' && key !== 'subitems') {
      throw new TodoError(`Unknown items[${index}] field "${key}".`);
    }
  }
  const text = requireTodoText(item.text, `items[${index}].text`);
  if (item.subitems === undefined) return { text };
  if (!Array.isArray(item.subitems)) {
    throw new TodoError(`items[${index}].subitems must be an array.`);
  }
  const subitems = item.subitems.map((subitem, subitemIndex) =>
    requireTodoText(subitem, `items[${index}].subitems[${subitemIndex}]`));
  if (subitems.length === 0) {
    throw new TodoError(`items[${index}].subitems must not be empty when supplied.`);
  }
  const unique = new Set(subitems.map(taskKey));
  if (unique.size !== subitems.length) {
    throw new TodoError(`items[${index}].subitems contains duplicate exact text.`);
  }
  return { text, subitems };
}

function dateParts(formatter: Intl.DateTimeFormat, value: Date): string {
  const parts = new Map(
    formatter.formatToParts(value)
      .filter(part => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map(part => [part.type, part.value]),
  );
  const year = parts.get('year');
  const month = parts.get('month');
  const day = parts.get('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new TodoError('Unable to resolve the date in the configured timezone.');
  }
  return validateCalendarDate(`${year}-${month}-${day}`, 'date');
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new TodoError(`Invalid date "${value}".`);
  }
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(result.getUTCFullYear()).padStart(4, '0'),
    String(result.getUTCMonth() + 1).padStart(2, '0'),
    String(result.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function validateCalendarDate(value: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new TodoError(`${label} must be today, tomorrow, or YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    throw new TodoError(`Invalid calendar date "${value}".`);
  }
  return value;
}

function labelKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function taskKey(value: string): string {
  return value.trim();
}

function exactRecordValue(record: Record<string, string>, selector: string): string | undefined {
  const normalized = labelKey(selector);
  const matches = Object.entries(record).filter(([key]) => labelKey(key) === normalized);
  if (matches.length > 1) throw new TodoError(`Configured selector "${selector}" is ambiguous.`);
  return matches[0]?.[1];
}

function resolveContainer(
  profile: BlockProfile,
  owner: string,
  requestedContainer: string | undefined,
  backlog: boolean,
): SelectedContainer {
  let selector = cleanOptional(requestedContainer);
  if (selector === undefined && backlog) {
    selector = profile.backlogContainers === undefined
      ? undefined
      : exactRecordValue(profile.backlogContainers, owner);
    selector ??= profile.backlogContainer;
  }
  selector ??= owner;

  const normalized = labelKey(selector);
  const matches = Object.entries(profile.containers).filter(([key, container]) =>
    labelKey(key) === normalized || labelKey(container.id) === normalized);
  if (matches.length > 1) throw new TodoError(`Todo container "${selector}" is ambiguous.`);
  const selected = matches[0];
  if (selected !== undefined) return { key: selected[0], container: selected[1] };

  const entries = Object.entries(profile.containers);
  if (requestedContainer === undefined && entries.length === 1) {
    const only = entries[0];
    if (only !== undefined) return { key: only[0], container: only[1] };
  }
  throw new TodoError(`No todo container matches "${selector}".`);
}

function selectedOwner(profile: BlockProfile, request: Pick<TodoRequest, 'owner'>): string {
  return cleanOptional(request.owner) ?? profile.defaultOwner;
}

function selectedSection(
  container: BlockContainer,
  owner: string,
  requestedSection: string | undefined,
): string | undefined {
  return cleanOptional(requestedSection)
    ?? container.section
    ?? (container.layout === 'sections' ? owner : undefined);
}

function requestedUpdate(request: TodoRequest): { checked: boolean | undefined; text: string | undefined } {
  return {
    checked: request.intent === 'complete' ? request.checked ?? true : request.checked,
    text: request.intent === 'update' && request.text !== undefined
      ? validatedTodoText(request.text, 'Todo text')
      : undefined,
  };
}

function blockId(block: JsonObject, label = 'block'): string {
  if (typeof block.id !== 'string' || block.id === '') throw new TodoError(`${label} has no id.`);
  return block.id;
}

function blockType(block: JsonObject): string | undefined {
  return typeof block.type === 'string' ? block.type : undefined;
}

function blockBody(block: JsonObject): JsonObject | undefined {
  const type = blockType(block);
  if (type === undefined) return undefined;
  const body = block[type];
  return isObject(body) ? body : undefined;
}

function blockChecked(block: JsonObject): boolean | undefined {
  const body = blockType(block) === 'to_do' ? blockBody(block) : undefined;
  return typeof body?.checked === 'boolean' ? body.checked : undefined;
}

function isSectionLabelBlock(block: JsonObject): boolean {
  const type = blockType(block);
  return type === 'paragraph'
    || type === 'heading_1'
    || type === 'heading_2'
    || type === 'heading_3';
}

function dateHeadingValue(block: JsonObject): string | undefined {
  if (blockType(block) !== 'paragraph') return undefined;
  const body = blockBody(block);
  const richTextValue = body?.rich_text;
  if (!Array.isArray(richTextValue)) return undefined;
  const mentions = richTextValue.flatMap(value => {
    if (!isObject(value) || value.type !== 'mention' || !isObject(value.mention)) return [];
    const mention = value.mention;
    if (mention.type !== 'date' || !isObject(mention.date) || typeof mention.date.start !== 'string') {
      return [];
    }
    return [mention.date.start];
  });
  if (mentions.length === 1 && richTextValue.length === 1) {
    return calendarDateOrUndefined(mentions[0] ?? '');
  }
  return calendarDateOrUndefined(blockText(block).trim());
}

function calendarDateOrUndefined(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day
    ? value
    : undefined;
}

function sectionBand(
  blocks: JsonObject[],
  container: BlockContainer,
  requestedSection: string | undefined,
): Band {
  const section = cleanOptional(requestedSection);
  if (section === undefined) return { start: 0, end: blocks.length };
  const labels = new Set(
    (container.sectionLabels ?? [section]).map(label => labelKey(label)),
  );
  labels.add(labelKey(section));
  const matchingIndexes = blocks.flatMap((block, index) =>
    isSectionLabelBlock(block) && labelKey(blockText(block)) === labelKey(section)
      ? [index]
      : []);
  if (matchingIndexes.length !== 1) {
    throw new TodoError(
      matchingIndexes.length === 0
        ? `Todo section "${section}" was not found.`
        : `Todo section "${section}" is ambiguous.`,
    );
  }
  const headingIndex = matchingIndexes[0];
  if (headingIndex === undefined) throw new TodoError(`Todo section "${section}" was not found.`);
  let end = blocks.length;
  for (let index = headingIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (
      block !== undefined
      && (
        (container.layout === 'sections' && dateHeadingValue(block) !== undefined)
        || (isSectionLabelBlock(block) && labels.has(labelKey(blockText(block))))
      )
    ) {
      end = index;
      break;
    }
  }
  return { start: headingIndex + 1, end };
}

function dateHeadings(blocks: JsonObject[], band: Band): DateHeading[] {
  const headings: DateHeading[] = [];
  for (let index = band.start; index < band.end; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    const date = dateHeadingValue(block);
    if (date !== undefined) headings.push({ index, id: blockId(block, 'date heading'), date });
  }
  return headings;
}

function findDateIndex(headings: DateHeading[], date: string): number | undefined {
  const indexes = headings.flatMap((heading, index) => heading.date === date ? [index] : []);
  if (indexes.length > 1) throw new TodoError(`Multiple date headings exist for ${date}.`);
  return indexes[0];
}

function validateDateOrder(headings: DateHeading[], order: BlockContainer['dateOrder']): void {
  if (order !== 'descending') return;
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1];
    const current = headings[index];
    if (previous !== undefined && current !== undefined && previous.date <= current.date) {
      throw new TodoError('Existing date headings are not in strict descending order.');
    }
  }
}

function dateRange(headings: DateHeading[], targetIndex: number, band: Band): Band {
  const target = headings[targetIndex];
  if (target === undefined) throw new TodoError('Date heading selection is invalid.');
  return {
    start: target.index + 1,
    end: headings[targetIndex + 1]?.index ?? band.end,
  };
}

function findNewDateIndex(headings: DateHeading[], date: string, band: Band): number {
  return headings.find(heading => heading.date < date)?.index ?? band.end;
}

function positionBefore(blocks: JsonObject[], index: number): Position {
  if (index <= 0) return { type: 'start' };
  if (index >= blocks.length) return { type: 'end' };
  const previous = blocks[index - 1];
  if (previous === undefined) throw new TodoError('Unable to resolve the insertion anchor.');
  return { type: 'after_block', after_block: { id: blockId(previous, 'insertion anchor') } };
}

function positionAfterRelevant(blocks: JsonObject[], band: Band): Position {
  for (let index = band.end - 1; index >= band.start; index -= 1) {
    const block = blocks[index];
    if (block !== undefined && blockType(block) === 'to_do') {
      return { type: 'after_block', after_block: { id: blockId(block, 'todo') } };
    }
  }
  return positionBefore(blocks, band.start);
}

function precondition(
  kind: Precondition['kind'],
  id: string,
  value: unknown,
): Precondition {
  return { kind, id, hash: stateFingerprint(value) };
}

function appendOperations(
  parentId: string,
  children: JsonObject[],
  position: Position,
  preconditions: Precondition[],
): PlannedOperation[] {
  if (children.length === 0) return [];
  const chunks: JsonObject[][] = [];
  for (let index = 0; index < children.length; index += 100) {
    chunks.push(children.slice(index, index + 100));
  }
  if (position.type !== 'end') chunks.reverse();
  return chunks.map(chunk => ({
    kind: 'append-blocks',
    parentId,
    children: chunk,
    position,
    preconditions,
  }));
}

function todoBlock(item: TodoItem, checked: boolean): JsonObject {
  const text = validatedTodoText(item.text, 'Todo text');
  const subitems = item.subitems ?? [];
  if (subitems.length > 100) {
    throw new TodoError(`A todo can contain at most 100 direct subitems; "${item.text}" has ${subitems.length}.`);
  }
  const body: JsonObject = {
    rich_text: richText(text),
    checked,
    ...(subitems.length === 0
      ? {}
      : {
          children: subitems.map(text => todoBlock({ text }, checked)),
        }),
  };
  return { object: 'block', type: 'to_do', to_do: body };
}

function dateHeadingBlock(date: string): JsonObject {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'mention',
        mention: { type: 'date', date: { start: date } },
      }],
    },
  };
}

function requestItems(request: TodoRequest): TodoItem[] {
  if (request.items === undefined || request.items.length === 0) {
    throw new TodoError(`${request.intent} requires items.`);
  }
  const items = request.items.map((item, index): TodoItem => {
    const text = validatedTodoText(item.text, `items[${index}].text`);
    const subitems = item.subitems?.map((subitem, subitemIndex) =>
      validatedTodoText(subitem, `items[${index}].subitems[${subitemIndex}]`));
    if (subitems !== undefined && new Set(subitems.map(taskKey)).size !== subitems.length) {
      throw new TodoError(`items[${index}].subitems contains duplicate exact text.`);
    }
    return subitems === undefined ? { text } : { text, subitems };
  });
  const unique = new Set(items.map(item => taskKey(item.text)));
  if (unique.size !== items.length) {
    throw new TodoError(`${request.intent} contains duplicate exact task text.`);
  }
  return items;
}

function collectionIntent(request: TodoRequest): CollectionIntent {
  if (request.intent === 'complete' || request.intent === 'update') {
    throw new TodoError(`${request.intent} is not a collection intent.`);
  }
  return request.intent;
}

async function planBlockTodos(
  scope: TodoScope,
  profile: BlockProfile,
  request: TodoRequest,
  now: Date,
): Promise<PlannedOperation[]> {
  if (request.intent === 'complete' || request.intent === 'update') {
    return planBlockUpdate(scope, profile, request);
  }
  const intent = collectionIntent(request);
  const owner = selectedOwner(profile, request);
  const selected = resolveContainer(profile, owner, request.container, intent === 'backlog');
  const blocks = await scope.children(selected.container.id);
  const layoutRead = precondition('children', selected.container.id, blocks);
  const section = selectedSection(selected.container, owner, request.section);
  const band = sectionBand(blocks, selected.container, section);

  if (selected.container.layout !== 'dated') {
    if (request.date !== undefined) {
      throw new TodoError(`Container "${selected.key}" is not dated and does not accept date.`);
    }
    if (intent === 'log' && profile.logBuckets.length > 0) {
      throw new TodoError('Configured log buckets require a dated container.');
    }
    return planFlatBlockItems(
      scope,
      selected.container.id,
      blocks,
      band,
      requestItems(request),
      intent === 'log',
      [layoutRead],
    );
  }

  const date = resolveDate(request.date, scope.profile.timezone, now);
  const headings = dateHeadings(blocks, band);
  validateDateOrder(headings, selected.container.dateOrder);
  const targetIndex = findDateIndex(headings, date);
  if (targetIndex !== undefined) {
    const range = dateRange(headings, targetIndex, band);
    return intent === 'log' && profile.logBuckets.length > 0
      ? planGroupedLog(scope, profile, selected.container.id, blocks, range, requestItems(request), [layoutRead])
      : planFlatBlockItems(
          scope,
          selected.container.id,
          blocks,
          range,
          requestItems(request),
          intent === 'log',
          [layoutRead],
        );
  }

  const items = requestItems(request);
  const children = intent === 'log' && profile.logBuckets.length > 0
    ? [
        dateHeadingBlock(date),
        ...newLogBuckets(profile, items),
      ]
    : [
        dateHeadingBlock(date),
        ...items.map(item => todoBlock(item, intent === 'log')),
      ];
  const insertionIndex = findNewDateIndex(headings, date, band);
  return appendOperations(
    selected.container.id,
    children,
    positionBefore(blocks, insertionIndex),
    [layoutRead],
  );
}

async function planFlatBlockItems(
  scope: TodoScope,
  parentId: string,
  blocks: JsonObject[],
  band: Band,
  items: TodoItem[],
  checked: boolean,
  preconditions: Precondition[],
): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  const additions: TodoItem[] = [];
  for (const item of items) {
    const matches = taskMatches(blocks, band, item.text);
    if (matches.length > 1) throw new TodoError(`Multiple exact todo matches exist for "${item.text}".`);
    const existing = matches[0];
    if (existing === undefined) {
      additions.push(item);
      continue;
    }
    if (item.subitems !== undefined) {
      operations.push(...await growTaskChildren(
        scope,
        blockId(existing),
        item.subitems,
        checked,
        preconditions,
      ));
    }
  }
  if (additions.length > 0) {
    operations.push(...appendOperations(
      parentId,
      additions.map(item => todoBlock(item, checked)),
      positionAfterRelevant(blocks, band),
      preconditions,
    ));
  }
  return operations;
}

function taskMatches(blocks: JsonObject[], band: Band, text: string): JsonObject[] {
  const normalized = taskKey(text);
  return blocks.slice(band.start, band.end).filter(block =>
    blockType(block) === 'to_do' && taskKey(blockText(block)) === normalized);
}

async function growTaskChildren(
  scope: TodoScope,
  taskId: string,
  requested: string[],
  checked: boolean,
  inheritedPreconditions: Precondition[],
): Promise<PlannedOperation[]> {
  const existing = await scope.children(taskId);
  const additions: string[] = [];
  for (const text of requested) {
    const matches = existing.filter(block =>
      blockType(block) === 'to_do' && taskKey(blockText(block)) === taskKey(text));
    if (matches.length > 1) throw new TodoError(`Multiple exact subitem matches exist for "${text}".`);
    if (matches.length === 0) additions.push(text);
  }
  return appendOperations(
    taskId,
    additions.map(text => todoBlock({ text }, checked)),
    { type: 'end' },
    [...inheritedPreconditions, precondition('children', taskId, existing)],
  );
}

function newLogBuckets(profile: BlockProfile, items: TodoItem[]): JsonObject[] {
  const configured = new Set(profile.logBuckets.map(labelKey));
  const seen = new Set<string>();
  return items.map(item => {
    validateLogBucket(item, configured, seen);
    return todoBlock(item, true);
  });
}

function validateLogBucket(
  item: TodoItem,
  configured: Set<string>,
  seen: Set<string>,
): asserts item is TodoItem & { subitems: string[] } {
  const normalized = labelKey(item.text);
  if (!configured.has(normalized)) {
    throw new TodoError(`"${item.text}" is not a configured log bucket.`);
  }
  if (seen.has(normalized)) throw new TodoError(`Duplicate log bucket "${item.text}" in request.`);
  seen.add(normalized);
  if (item.subitems === undefined || item.subitems.length === 0) {
    throw new TodoError(`Log bucket "${item.text}" requires nonempty subitems.`);
  }
}

async function planGroupedLog(
  scope: TodoScope,
  profile: BlockProfile,
  parentId: string,
  blocks: JsonObject[],
  range: Band,
  items: TodoItem[],
  preconditions: Precondition[],
): Promise<PlannedOperation[]> {
  const configured = new Set(profile.logBuckets.map(labelKey));
  const seen = new Set<string>();
  const additions: TodoItem[] = [];
  const operations: PlannedOperation[] = [];
  for (const item of items) {
    validateLogBucket(item, configured, seen);
    const matches = taskMatches(blocks, range, item.text);
    if (matches.length > 1) throw new TodoError(`Multiple exact log buckets exist for "${item.text}".`);
    const existing = matches[0];
    if (existing === undefined) {
      additions.push(item);
      continue;
    }
    operations.push(...await growTaskChildren(
      scope,
      blockId(existing),
      item.subitems,
      true,
      preconditions,
    ));
  }
  if (additions.length > 0) {
    operations.push(...appendOperations(
      parentId,
      additions.map(item => todoBlock(item, true)),
      positionAfterRelevant(blocks, range),
      preconditions,
    ));
  }
  return operations;
}

async function planBlockUpdate(
  scope: TodoScope,
  profile: BlockProfile,
  request: TodoRequest,
): Promise<PlannedOperation[]> {
  if (request.id === undefined) throw new TodoError(`${request.intent} requires an exact task id.`);
  const task = await scope.read({ kind: 'block', id: request.id });
  if (task.object !== 'block' || blockType(task) !== 'to_do') {
    throw new TodoError(`Block ${request.id} is not a to_do task.`);
  }
  const ancestryReads = await todoAncestryPreconditions(scope, task, profile.pageId);
  const { checked: desiredChecked, text: desiredText } = requestedUpdate(request);
  if (
    (desiredChecked === undefined || desiredChecked === blockChecked(task))
    && (desiredText === undefined || desiredText === blockText(task))
  ) {
    return [];
  }
  const body: JsonObject = {
    ...(desiredText === undefined ? {} : { rich_text: richText(desiredText) }),
    ...(desiredChecked === undefined ? {} : { checked: desiredChecked }),
  };
  return [{
    kind: 'update-block',
    id: request.id,
    patch: { to_do: body },
    preconditions: [precondition('block', request.id, task), ...ancestryReads],
  }];
}

async function todoAncestryPreconditions(
  scope: TodoScope,
  task: JsonObject,
  todoPageId: string,
): Promise<Precondition[]> {
  const seen = new Set<string>();
  const reads: Precondition[] = [];
  let current = task;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = isObject(current.parent) ? current.parent : undefined;
    if (parent === undefined || typeof parent.type !== 'string') break;
    if (parent.type === 'page_id' && parent.page_id === todoPageId) return reads;

    let kind: 'block' | 'page';
    let parentId: JsonValue | undefined;
    if (parent.type === 'block_id') {
      kind = 'block';
      parentId = parent.block_id;
    } else if (parent.type === 'page_id') {
      kind = 'page';
      parentId = parent.page_id;
    } else {
      break;
    }
    if (typeof parentId !== 'string') break;
    if (parentId === todoPageId) return reads;
    if (seen.has(parentId)) throw new TodoError('Todo ancestry contains a cycle.');
    seen.add(parentId);
    current = await scope.read({ kind, id: parentId });
    reads.push(precondition(kind, parentId, current));
  }
  throw new TodoError(`Task is not under configured todo page ${todoPageId}.`);
}

async function planDatabaseTodos(
  scope: TodoScope,
  profile: DatabaseProfile,
  request: TodoRequest,
  now: Date,
): Promise<PlannedOperation[]> {
  const source = await scope.read({ kind: 'data_source', id: profile.dataSourceId });
  const schema = validateDatabaseSchema(profile, source);
  if (request.intent === 'complete' || request.intent === 'update') {
    return planDatabaseUpdate(scope, profile, schema, request);
  }

  const intent = collectionIntent(request);
  if (request.container !== undefined || request.section !== undefined) {
    throw new TodoError('Database todo requests do not support container or section selectors.');
  }
  const items = requestItems(request);
  const owner = resolveDatabaseOwner(profile, request.owner);
  const date = resolveDatabaseDate(profile, request, intent, scope.profile.timezone, now);
  const checked = intent === 'log';
  const rows = await scope.query(profile.dataSourceId);
  const reads = [
    precondition('data_source', profile.dataSourceId, source),
    precondition('query', profile.dataSourceId, rows),
  ];
  const operations: PlannedOperation[] = [];
  for (const item of items) {
    const matches = rows.filter(row => databaseRowMatches(profile, row, item.text, date, owner));
    if (matches.length > 1) throw new TodoError(`Multiple exact database tasks exist for "${item.text}".`);
    const existing = matches[0];
    if (existing !== undefined) {
      if (item.subitems !== undefined) {
        const rowId = requireResourceId(existing, 'database row');
        operations.push(...await growTaskChildren(scope, rowId, item.subitems, checked, reads));
      }
      continue;
    }
    if ((item.subitems?.length ?? 0) > 100) {
      throw new TodoError(`A new database task can contain at most 100 direct subitems.`);
    }
    operations.push({
      kind: 'create-page',
      parent: { kind: 'data_source', id: profile.dataSourceId },
      properties: databaseProperties(profile, item.text, checked, date, owner),
      ...(item.subitems === undefined
        ? {}
        : { children: item.subitems.map(text => todoBlock({ text }, checked)) }),
      preconditions: reads,
    });
  }
  return operations;
}

function validateDatabaseSchema(profile: DatabaseProfile, source: JsonObject): DatabaseSchema {
  if (source.object !== 'data_source' || source.id !== profile.dataSourceId) {
    throw new TodoError(`Configured data source ${profile.dataSourceId} was not returned.`);
  }
  const properties = requireObject(source.properties, 'data source properties');
  requirePropertyType(properties, profile.titleProperty, 'title');
  const status = requirePropertyType(properties, profile.statusProperty, profile.statusType);
  validateStatusValues(profile, status);

  if (profile.dateProperty !== undefined) {
    requirePropertyType(properties, profile.dateProperty, 'date');
  }
  if ((profile.ownerProperty === undefined) !== (profile.ownerType === undefined)) {
    throw new TodoError('ownerProperty and ownerType must be configured together.');
  }
  if (profile.ownerProperty !== undefined && profile.ownerType !== undefined) {
    const owner = requirePropertyType(properties, profile.ownerProperty, profile.ownerType);
    if (profile.ownerType === 'select') {
      for (const value of Object.values(profile.owners)) {
        requireOption(owner, 'select', value, profile.ownerProperty);
      }
    }
  }
  return { source, properties };
}

function requirePropertyType(
  properties: JsonObject,
  propertyName: string,
  expectedType: string,
): JsonObject {
  const property = requireObject(properties[propertyName], `Property "${propertyName}"`);
  if (property.type !== expectedType) {
    throw new TodoError(`Property "${propertyName}" must have type ${expectedType}.`);
  }
  return property;
}

function validateStatusValues(profile: DatabaseProfile, property: JsonObject): void {
  if (profile.statusType === 'checkbox') {
    if (typeof profile.pendingValue !== 'boolean' || typeof profile.doneValue !== 'boolean') {
      throw new TodoError('Checkbox todo status values must be booleans.');
    }
    if (profile.pendingValue === profile.doneValue) {
      throw new TodoError('Pending and done checkbox values must differ.');
    }
    return;
  }
  if (typeof profile.pendingValue !== 'string' || typeof profile.doneValue !== 'string') {
    throw new TodoError(`${profile.statusType} todo status values must be strings.`);
  }
  if (profile.pendingValue === profile.doneValue) {
    throw new TodoError('Pending and done status values must differ.');
  }
  requireOption(property, profile.statusType, profile.pendingValue, profile.statusProperty);
  requireOption(property, profile.statusType, profile.doneValue, profile.statusProperty);
}

function requireOption(
  property: JsonObject,
  propertyType: 'status' | 'select',
  value: string,
  propertyName: string,
): void {
  const configuration = requireObject(property[propertyType], `Property "${propertyName}" options`);
  if (!Array.isArray(configuration.options)) {
    throw new TodoError(`Property "${propertyName}" has no ${propertyType} options.`);
  }
  const matches = configuration.options.filter(option =>
    isObject(option) && option.name === value);
  if (matches.length !== 1) {
    throw new TodoError(`Property "${propertyName}" must contain one option named "${value}".`);
  }
}

function resolveDatabaseOwner(
  profile: DatabaseProfile,
  requestedOwner: string | undefined,
): string | undefined {
  const owner = cleanOptional(requestedOwner);
  if (profile.ownerProperty === undefined) {
    if (owner !== undefined) {
      throw new TodoError('This todo database has no configured owner property.');
    }
    return undefined;
  }
  if (owner !== undefined) {
    const mapped = exactRecordValue(profile.owners, owner);
    if (mapped === undefined) throw new TodoError(`No database owner mapping exists for "${owner}".`);
    return profile.ownerType === 'people' ? notionId(mapped) : mapped;
  }
  const values = Object.values(profile.owners);
  if (values.length === 1) {
    const only = values[0];
    if (only === undefined) return undefined;
    return profile.ownerType === 'people' ? notionId(only) : only;
  }
  throw new TodoError('owner is required for this todo database.');
}

function resolveDatabaseDate(
  profile: DatabaseProfile,
  request: TodoRequest,
  intent: CollectionIntent,
  timezone: string,
  now: Date,
): string | undefined {
  if (profile.dateProperty === undefined) {
    if (request.date !== undefined) {
      throw new TodoError('This todo database has no configured date property.');
    }
    return undefined;
  }
  if (intent === 'backlog' && request.date === undefined) return undefined;
  return resolveDate(request.date, timezone, now);
}

function databaseProperties(
  profile: DatabaseProfile,
  title: string,
  checked: boolean,
  date: string | undefined,
  owner: string | undefined,
): JsonObject {
  const properties: JsonObject = {
    [profile.titleProperty]: { title: richText(title) },
    [profile.statusProperty]: statusPropertyValue(profile, checked),
  };
  if (profile.dateProperty !== undefined) {
    properties[profile.dateProperty] = { date: date === undefined ? null : { start: date } };
  }
  if (
    profile.ownerProperty !== undefined
    && profile.ownerType !== undefined
    && owner !== undefined
  ) {
    properties[profile.ownerProperty] = profile.ownerType === 'people'
      ? { people: [{ id: owner }] }
      : { select: { name: owner } };
  }
  return properties;
}

function statusPropertyValue(profile: DatabaseProfile, checked: boolean): JsonObject {
  const value = checked ? profile.doneValue : profile.pendingValue;
  if (profile.statusType === 'checkbox') return { checkbox: value };
  if (typeof value !== 'string') throw new TodoError(`${profile.statusType} todo status must be a string.`);
  return { [profile.statusType]: { name: value } };
}

function databaseRowMatches(
  profile: DatabaseProfile,
  row: JsonObject,
  title: string,
  date: string | undefined,
  owner: string | undefined,
): boolean {
  const properties = databaseRowProperties(profile, row);
  if (properties === undefined) return false;
  if (taskKey(propertyText(properties[profile.titleProperty])) !== taskKey(title)) {
    return false;
  }
  if (profile.dateProperty !== undefined && propertyDate(properties[profile.dateProperty]) !== date) {
    return false;
  }
  if (
    profile.ownerProperty !== undefined
    && profile.ownerType !== undefined
    && !ownerMatches(properties[profile.ownerProperty], profile.ownerType, owner)
  ) {
    return false;
  }
  return true;
}

function databaseRowInListScope(
  profile: DatabaseProfile,
  row: JsonObject,
  date: string | undefined,
  owner: string | undefined,
): boolean {
  const properties = databaseRowProperties(profile, row);
  if (properties === undefined) return false;
  if (
    date !== undefined
    && profile.dateProperty !== undefined
    && propertyDate(properties[profile.dateProperty]) !== date
  ) {
    return false;
  }
  if (owner === undefined) return true;
  if (profile.ownerProperty === undefined || profile.ownerType === undefined) return false;
  return ownerMatches(properties[profile.ownerProperty], profile.ownerType, owner);
}

function databaseRowProperties(
  profile: DatabaseProfile,
  row: JsonObject,
): JsonObject | undefined {
  if (
    row.object !== 'page'
    || !isObject(row.parent)
    || row.parent.type !== 'data_source_id'
    || row.parent.data_source_id !== profile.dataSourceId
    || !isObject(row.properties)
  ) {
    return undefined;
  }
  return row.properties;
}

function propertyText(property: JsonValue | undefined): string {
  if (!isObject(property) || !Array.isArray(property.title)) return '';
  return property.title.map(richTextPart).join('');
}

function richTextPart(value: JsonValue): string {
  if (!isObject(value)) return '';
  if (typeof value.plain_text === 'string') return value.plain_text;
  if (isObject(value.text) && typeof value.text.content === 'string') return value.text.content;
  return '';
}

function statusMatches(
  profile: DatabaseProfile,
  property: JsonValue | undefined,
  checked: boolean,
): boolean {
  if (!isObject(property)) return false;
  const expected = checked ? profile.doneValue : profile.pendingValue;
  if (profile.statusType === 'checkbox') return property.checkbox === expected;
  const status = property[profile.statusType];
  return isObject(status) && status.name === expected;
}

function propertyDate(property: JsonValue | undefined): string | undefined {
  if (!isObject(property)) return undefined;
  return isObject(property.date) && typeof property.date.start === 'string'
    ? property.date.start
    : undefined;
}

function ownerMatches(
  property: JsonValue | undefined,
  ownerType: 'people' | 'select',
  owner: string | undefined,
): boolean {
  if (!isObject(property)) return owner === undefined;
  if (ownerType === 'select') {
    if (owner === undefined) return property.select === null;
    return isObject(property.select) && property.select.name === owner;
  }
  if (!Array.isArray(property.people)) return owner === undefined;
  if (owner === undefined) return property.people.length === 0;
  return property.people.some(person => isObject(person) && person.id === owner);
}

async function planDatabaseUpdate(
  scope: TodoScope,
  profile: DatabaseProfile,
  schema: DatabaseSchema,
  request: TodoRequest,
): Promise<PlannedOperation[]> {
  if (request.id === undefined) throw new TodoError(`${request.intent} requires an exact task id.`);
  const page = await scope.read({ kind: 'page', id: request.id });
  if (
    page.object !== 'page'
    || !isObject(page.parent)
    || page.parent.type !== 'data_source_id'
    || page.parent.data_source_id !== profile.dataSourceId
  ) {
    throw new TodoError(`Page ${request.id} is not a task row in the configured data source.`);
  }
  if (!isObject(page.properties)) throw new TodoError(`Task row ${request.id} has no properties.`);
  const { checked: desiredChecked, text: desiredText } = requestedUpdate(request);
  const currentText = propertyText(page.properties[profile.titleProperty]);
  const patch: JsonObject = {};
  if (desiredText !== undefined && desiredText !== currentText) {
    patch[profile.titleProperty] = { title: richText(desiredText) };
  }
  if (
    desiredChecked !== undefined
    && !statusMatches(profile, page.properties[profile.statusProperty], desiredChecked)
  ) {
    patch[profile.statusProperty] = statusPropertyValue(profile, desiredChecked);
  }
  if (Object.keys(patch).length === 0) return [];
  return [{
    kind: 'update-page',
    id: request.id,
    patch: { properties: patch },
    preconditions: [
      precondition('data_source', profile.dataSourceId, schema.source),
      precondition('page', request.id, page),
    ],
  }];
}

function requireResourceId(resource: JsonObject, label: string): string {
  if (typeof resource.id !== 'string' || resource.id === '') {
    throw new TodoError(`${label} has no id.`);
  }
  return resource.id;
}
