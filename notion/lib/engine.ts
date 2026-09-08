import { randomUUID } from 'node:crypto';
import { isResourceLookupMiss, NotionError } from './errors.js';
import type { ScopedNotion } from './scope.js';
import { assertNoSecrets, parseOperations, payloadReferences, requireOperation, richTextType, schemaPropertyType, stateSnapshot } from './operations.js';
import type { Operation, PageParent } from './operations.js';
import { acquireLock, readState, validatePlanId, writeState as writePrivateState } from './journal.js';
import type { Journal, Observation, Plan, StepResult } from './journal.js';
import type { JsonObject, JsonValue, ResourceRef } from './types.js';
import { array, canonicalJson, fingerprint, isObject, notionId, object, pageTitle, string } from './values.js';
export type { Journal, Plan } from './journal.js';

const segments = { page: 'pages', block: 'blocks', database: 'databases', data_source: 'data_sources' };
const route = (ref: ResourceRef): string => `/${segments[ref.kind]}/${ref.id}`;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const keyOf = (kind: Observation['kind'], ref: ResourceRef, source?: 'planner'): string => `${source === 'planner' ? 'planner:' : ''}${kind}:${ref.kind}:${ref.id}`;
const parentBody = (ref: ResourceRef): JsonObject => ({ type: `${ref.kind}_id`, [`${ref.kind}_id`]: ref.id });
const ARCHIVE_LIMITATION = 'Archive reconciliation verifies reviewed IDs, contents, parents, inherited trash flags and removal from the live parent. Archived child lists cannot be enumerated; concurrent unseen additions or order changes cannot be proven absent because Notion is not transactional.';

interface ExpectedObservation extends Observation {
  archiveReconciled?: true;
}

function writeScopedState(scope: ScopedNotion, home: string, kind: 'plans' | 'journals', id: string, value: unknown): Promise<void> {
  const payload = object(value);
  scope.client.assertNoCredentialContent(payload);
  return writePrivateState(home, kind, id, payload);
}

function binding(scope: ScopedNotion): JsonObject {
  const p = scope.profile;
  const refs = (values: ResourceRef[]): JsonValue[] => values
    .map(ref => ({ kind: ref.kind, id: notionId(ref.id) }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return {
    key: p.key, credentialRef: p.credentialRef,
    connection: { botId: notionId(p.connection.botId), ...(p.connection.workspaceId === undefined ? {} : { workspaceId: notionId(p.connection.workspaceId) }) },
    roots: refs(p.roots), protected: refs(p.protected),
    canonical: object(p.canonical),
  };
}
function checkBinding(scope: ScopedNotion, plan: Plan): void {
  if (!same(binding(scope), plan.binding)) throw new NotionError('SCOPE_MISMATCH', 'Plan belongs to a different profile, connection or root mapping.');
}
function scopeLock(scope: ScopedNotion): string { return fingerprint({ profileKey: scope.profile.key }); }
function parentRef(resource: JsonObject): ResourceRef | undefined {
  if (!isObject(resource.parent)) return undefined;
  const p = resource.parent;
  for (const kind of ['page', 'block', 'database', 'data_source'] as const) {
    if (p.type === `${kind}_id`) return { kind, id: notionId(string(p[`${kind}_id`])) };
  }
  return undefined;
}
function isParent(resource: JsonObject, ref: ResourceRef): boolean {
  const p = parentRef(resource);
  return p !== undefined && p.kind === ref.kind && p.id === ref.id;
}
function normalize(value: JsonValue): JsonValue {
  return withoutPresentation(stateSnapshot(value));
}
function withoutPresentation(value: JsonValue, propertyNames = false): JsonValue {
  if (Array.isArray(value)) return value.map(item => withoutPresentation(item));
  if (!isObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (propertyNames || !['plain_text', 'href', 'has_children'].includes(key)) {
      result[key] = withoutPresentation(item, key === 'properties');
    }
  }
  return result;
}
function resourceState(resource: JsonObject): JsonObject {
  const stable = object(stateSnapshot(resource));
  const fields = ['id', 'object', 'type', 'parent', 'properties', 'title', 'description', 'icon', 'cover', 'in_trash', 'archived', 'is_archived', 'is_inline', 'data_sources'];
  if (typeof resource.type === 'string') fields.push(resource.type);
  const state: JsonObject = {};
  for (const field of fields) if (stable[field] !== undefined) state[field] = withoutPresentation(stable[field], field === 'properties');
  return state;
}
async function flexibleRead(scope: ScopedNotion, id: string): Promise<{ ref: ResourceRef; value: JsonObject }> {
  const page = { kind: 'page' as const, id };
  try { return { ref: page, value: await scope.read(page) }; }
  catch (error) {
    if (!isResourceLookupMiss(error)) throw error;
    const block = { kind: 'block' as const, id };
    return { ref: block, value: await scope.read(block) };
  }
}
async function tree(scope: ScopedNotion, ref: ResourceRef, visited = new Set<string>()): Promise<JsonObject> {
  const key = `${ref.kind}:${ref.id}`;
  if (visited.has(key) || visited.size >= 1000) throw new NotionError('TREE_LIMIT', 'Source tree contains a cycle or exceeds the 1000-resource safety limit.');
  visited.add(key);
  const value = await scope.read(ref);
  const children: JsonValue[] = [];
  if (ref.kind === 'database') {
    for (const source of array(value.data_sources)) children.push(await tree(scope, { kind: 'data_source', id: notionId(string(object(source).id)) }, visited));
  } else if (ref.kind === 'data_source') {
    for (const page of await scope.query(ref.id)) children.push(await tree(scope, { kind: 'page', id: notionId(string(page.id)) }, visited));
  } else {
    for (const child of await scope.children(ref.id)) {
      const childId = notionId(string(child.id));
      const kind = child.type === 'child_page' ? 'page' : child.type === 'child_database' ? 'database' : 'block';
      if (child.has_children === true || kind !== 'block') children.push(await tree(scope, { kind, id: childId }, visited));
      else {
        if (visited.has(childId) || visited.size >= 1000) throw new NotionError('TREE_LIMIT', 'Source tree exceeds safety limits.');
        visited.add(childId);
        children.push({ resource: resourceState(await scope.read({ kind, id: childId })), children: [] });
      }
    }
  }
  return { resource: resourceState(value), children };
}
async function observe(scope: ScopedNotion, kind: Observation['kind'], ref: ResourceRef, source?: 'planner'): Promise<JsonValue> {
  if (source === 'planner') {
    if (kind === 'resource') return stateSnapshot(await scope.read(ref));
    if (kind === 'children') return stateSnapshot(await scope.children(ref.id));
    if (kind === 'query') return stateSnapshot(await scope.query(ref.id));
    throw new NotionError('INVALID_OPERATION', 'Planner preconditions cannot request recursive trees.');
  }
  if (kind === 'resource') return resourceState(await scope.read(ref));
  if (kind === 'tree') return tree(scope, ref);
  if (kind === 'query') return (await scope.query(ref.id)).map(row => notionId(string(row.id))).sort();
  return (await scope.children(ref.id)).map(resourceState);
}

// Archived listing endpoints can return 404. Reuse only reviewed topology, retrieving every
// exact ID through fresh scoped authorization; no missing resource is evidence of archival.
async function reviewedTree(scope: ScopedNotion, before: JsonValue, transitions?: Map<string, JsonObject>): Promise<JsonObject> {
  const node = object(before);
  const previous = object(node.resource);
  const ref = persistedRef({ kind: previous.object, id: previous.id });
  const resource = resourceState(await scope.read(ref));
  const databaseMetadataIsUntrashed = ref.kind === 'database' && resource.in_trash === false;
  if (databaseMetadataIsUntrashed) {
    // Container metadata can stay untrashed while its physical child_database block is in trash.
    const block = await scope.read({ kind: 'block', id: ref.id });
    const parent = parentRef(resource);
    requireReadback(block.type === 'child_database' && block.in_trash === true
      && parent !== undefined && isParent(block, parent)
      && string(object(block.child_database).title) === pageTitle(resource));
  }
  if (transitions !== undefined) {
    const expectedInTrash = !databaseMetadataIsUntrashed;
    transitions.set(ref.id, patched(previous, trashPatch(previous, resource, expectedInTrash), resource));
  }
  const children: JsonValue[] = [];
  for (const child of array(node.children)) children.push(await reviewedTree(scope, child, transitions));
  return { resource, children };
}

async function observeExpected(scope: ScopedNotion, observation: ExpectedObservation): Promise<JsonValue> {
  if (!observation.archiveReconciled) return observe(scope, observation.kind, observation.ref, observation.source);
  if (observation.kind === 'tree') return reviewedTree(scope, observation.before);
  requireReadback(observation.kind === 'children');
  const parent = await scope.read(observation.ref);
  if (parent.in_trash !== true) throw new NotionError('STALE_PLAN', 'A reconciled archived parent is no longer in trash.');
  const children: JsonValue[] = [];
  for (const child of array(observation.before)) {
    const value = await scope.read({ kind: 'block', id: notionId(string(object(child).id)) });
    children.push(observation.source === 'planner' ? stateSnapshot(value) : resourceState(value));
  }
  return children;
}

export async function createPlan(
  scope: ScopedNotion, home: string, operations: Operation[],
  options: { summary?: string; requestKey?: string } = {},
): Promise<Plan> {
  const parsed = parseOperations(operations);
  assertNoSecrets(options);
  requireOperation(options.summary === undefined || typeof options.summary === 'string', 'Plan summary must be text.');
  requireOperation(options.requestKey === undefined || (typeof options.requestKey === 'string' && options.requestKey.length > 0 && options.requestKey.length <= 200), 'Request key requires 1 to 200 characters.');
  const bound = binding(scope);
  const summary = options.summary ?? `${parsed.length} guarded Notion operation(s)`;
  const requestDigest = fingerprint({ operations: parsed, summary });
  const planId = options.requestKey === undefined ? randomUUID() : notionId(fingerprint({ key: options.requestKey, profile: scope.profile.key }).slice(0, 32));
  const release = await acquireLock(home, scopeLock(scope), planId);
  try {
    if (options.requestKey !== undefined) {
      try {
        const existing = await readPlan(home, planId);
        if (existing.requestDigest !== requestDigest || !same(existing.binding, bound)) throw new NotionError('REQUEST_KEY_MISMATCH', 'Request key is already bound to different operations or scope.');
        return existing;
      } catch (error) { if (!(error instanceof NotionError) || error.code !== 'PLAN_NOT_FOUND') throw error; }
    }
    await scope.verifyConnection();
    const observations = new Map<string, Observation>();
    async function watch(kind: Observation['kind'], ref: ResourceRef, source?: 'planner'): Promise<JsonValue> {
      const key = keyOf(kind, ref, source);
      const existing = observations.get(key);
      if (existing !== undefined) return existing.before;
      const before = await observe(scope, kind, ref, source);
      observations.set(key, { key, kind, ref, before, fingerprint: fingerprint(before), ...(source === undefined ? {} : { source }) });
      return before;
    }
    async function destination(ref: ResourceRef): Promise<JsonObject> {
      const value = object(await watch('resource', ref));
      await watch(ref.kind === 'data_source' ? 'query' : 'children', ref);
      return value;
    }
    for (const operation of parsed) {
      for (const condition of operation.preconditions ?? []) {
        const ref: ResourceRef = condition.kind === 'children' ? (await flexibleRead(scope, condition.id)).ref
          : { kind: condition.kind === 'query' ? 'data_source' : condition.kind, id: condition.id };
        const kind = condition.kind === 'children' || condition.kind === 'query' ? condition.kind : 'resource';
        const observed = await watch(kind, ref, 'planner');
        if (fingerprint(observed) !== condition.hash) {
          throw new NotionError('STALE_PLAN', 'Planner input changed before the plan could be persisted.', { observation: keyOf(kind, ref, 'planner') });
        }
      }
    }
    const prepared: Operation[] = [];
    const projectedParents = new Map<string, ResourceRef>();
    const projectedSchemas = new Map<string, JsonObject>();
    const noOps: number[] = [];
    let destructive = false;
    for (const [index, source] of parsed.entries()) {
      let op = source;
      for (const referenced of payloadReferences(op)) await watch('resource', referenced);
      for (const explicit of op.watches ?? []) {
        await watch('resource', explicit.ref);
        if (explicit.children) {
          requireOperation(explicit.ref.kind !== 'database', 'Database membership watches must name a data source.');
          await watch(explicit.ref.kind === 'data_source' ? 'query' : 'children', explicit.ref);
        }
      }
      switch (op.kind) {
        case 'append-blocks': {
          const target = await flexibleRead(scope, op.parentId);
          await watch('resource', target.ref);
          const children = array(await watch('children', target.ref));
          if (op.position?.type === 'after_block') {
            const anchor = op.position.after_block.id;
            const child = children.find(entry => object(entry).id === anchor);
            requireOperation(child !== undefined && parentRef(object(child))?.id === target.ref.id, 'Append anchor must be an immediate child of the intended parent.');
            await watch('resource', { kind: 'block', id: anchor });
          }
          break;
        }
        case 'create-page': {
          const parent = await destination(op.parent);
          const dataSource = op.parent.kind === 'data_source' ? projectedSchemas.get(op.parent.id) ?? parent : undefined;
          validatePageSchema(op.properties, dataSource, true);
          break;
        }
        case 'create-database':
          await destination(op.parent);
          requireOperation(Object.values(op.properties).every(value => value !== null), 'New database properties cannot be deletions.');
          break;
        case 'create-comment':
          await watch('resource', { kind: 'page', id: op.parentId });
          break;
        default: {
          const kind = op.kind.endsWith('block') ? 'block' : op.kind === 'update-data-source' ? 'data_source' : op.kind === 'update-database' ? 'database' : 'page';
          const ref: ResourceRef = { kind, id: op.id };
          if (op.kind === 'archive-page' || op.kind === 'archive-block' || op.kind === 'move-page') {
            requireOperation(!scope.profile.roots.some(root => notionId(root.id) === ref.id), 'Moving or archiving a configured root is prohibited.');
          }
          const target = object(await watch('resource', ref));
          requireOperation(target.in_trash !== true && target.archived !== true, 'Target is already in trash.');
          const parent = parentRef(target);
          if (parent !== undefined && (op.kind === 'move-page' || op.kind.startsWith('archive-') || op.kind === 'update-block')) await destination(parent);
          if (op.kind === 'move-page') {
            requireOperation(op.id !== op.parent.id, 'A page cannot move into itself.');
            await destination(op.parent);
            const before = await watch('tree', ref);
            requireOperation(!treeContains(before, op.parent.id), 'A page cannot move into its own descendants.');
            let ancestor: ResourceRef | undefined = op.parent;
            const visited = new Set<string>();
            while (ancestor !== undefined) {
              requireOperation(ancestor.id !== ref.id && !visited.has(ancestor.id), 'Projected moves cannot form a cycle.');
              visited.add(ancestor.id);
              requireOperation(visited.size <= 100, 'Projected ancestry exceeds the safety limit.');
              ancestor = projectedParents.get(ancestor.id) ?? parentRef(object(await watch('resource', ancestor)));
            }
            const previousParent = projectedParents.get(ref.id) ?? parentRef(target);
            if (previousParent !== undefined && previousParent.id === op.parent.id && previousParent.kind === op.parent.kind) noOps.push(index);
            projectedParents.set(ref.id, op.parent);
          } else if (op.kind === 'update-block') {
            requireOperation(typeof target.type === 'string' && Object.keys(op.patch)[0] === target.type, 'Block patch must match the actual target type.');
          } else if (op.kind === 'update-data-source') {
            const beforeSchema = projectedSchemas.get(ref.id) ?? target;
            op = { ...op, patch: prepareSchema(op, beforeSchema) };
            const projected = { ...beforeSchema, ...op.patch };
            if (op.patch.properties !== undefined) {
              const properties = object(beforeSchema.properties);
              for (const [name, change] of Object.entries(object(op.patch.properties))) {
                if (change === null) delete properties[name];
                else properties[name] = { ...(properties[name] === undefined ? {} : object(properties[name])), ...object(change), type: schemaPropertyType(object(change)) };
              }
              projected.properties = properties;
            }
            projectedSchemas.set(ref.id, projected);
            destructive ||= (op.allowDeleteProperties?.length ?? 0) > 0;
          } else if (op.kind === 'update-page' && op.patch.properties !== undefined) {
            const workspaceParent = isObject(target.parent) && target.parent.type === 'workspace' && target.parent.workspace === true;
            requireOperation(parent?.kind === 'page' || parent?.kind === 'data_source' || workspaceParent, 'Unsupported page property parent.');
            const dataSource = parent?.kind === 'data_source'
              ? projectedSchemas.get(parent.id) ?? object(await watch('resource', parent))
              : undefined;
            validatePageSchema(object(op.patch.properties), dataSource);
          } else if (op.kind === 'archive-page' || op.kind === 'archive-block') {
            destructive = true;
            await watch('tree', ref);
          }
        }
      }
      prepared.push(op);
    }
    // Re-read the complete observation set so a changing workspace cannot yield a mixed plan.
    await recheck(scope, [...observations.values()]);
    const unsigned = {
      version: 1 as const, id: planId, workspace: scope.profile.key, summary,
      binding: bound, requestDigest, ...(options.requestKey === undefined ? {} : { requestKey: options.requestKey }),
      createdAt: new Date().toISOString(), operations: prepared,
      steps: prepared.map((operation, index) => ({ index, operation, noOp: noOps.includes(index) })),
      destructive, noOps, observations: [...observations.values()],
    };
    const plan: Plan = { ...unsigned, digest: fingerprint(unsigned) };
    checkBinding(scope, plan);
    await writeScopedState(scope, home, 'plans', planId, plan);
    return plan;
  } finally { await release(); }
}
export async function applyPlan(
  scope: ScopedNotion, home: string, planId: string,
  options: { approveDestructive?: boolean } = {},
): Promise<Journal> {
  validatePlanId(planId);
  const release = await acquireLock(home, scopeLock(scope), planId);
  try {
    const plan = await readPlan(home, planId);
    checkBinding(scope, plan);
    await scope.verifyConnection();
    scope.client.assertNoCredentialContent(object(plan));
    let previous: Journal | undefined;
    try { previous = await readJournal(home, planId); }
    catch (error) { if (!(error instanceof NotionError) || error.code !== 'JOURNAL_NOT_FOUND') throw error; }
    if (previous !== undefined) {
      if (previous.planDigest !== plan.digest) throw new NotionError('TAMPERED_STATE', 'Journal and plan digests disagree.');
      if (previous.status === 'applied') return previous;
      if (previous.status === 'running') {
        previous.status = 'uncertain';
        previous.error = { code: 'INTERRUPTED', message: 'Prior attempt stopped while running; reconcile with read-only inspection.' };
        previous.updatedAt = new Date().toISOString();
        await writeScopedState(scope, home, 'journals', planId, previous);
      }
      if (previous.status !== 'planned') throw new NotionError('RECONCILIATION_REQUIRED', 'This plan has a prior attempt. Inspect its journal and current state read-only; it will not be retried.');
    }
    if (plan.destructive && options.approveDestructive !== true) throw new NotionError('APPROVAL_REQUIRED', 'Destructive operations require explicit approval.');
    const journal: Journal = {
      version: 1, planId, planDigest: plan.digest, workspace: plan.workspace,
      status: 'planned', steps: [], updatedAt: new Date().toISOString(),
      ...(plan.operations.some(op => op.kind === 'archive-page' || op.kind === 'archive-block') ? { limitations: [ARCHIVE_LIMITATION] } : {}),
    };
    const expected: ExpectedObservation[] = structuredClone(plan.observations);
    let active: StepResult | undefined;
    let issued = false;
    let responded = false;
    async function persist(): Promise<void> {
      journal.updatedAt = new Date().toISOString();
      await writeScopedState(scope, home, 'journals', planId, journal);
    }
    await persist();
    try {
      checkBinding(scope, plan);
      await recheck(scope, expected);
      journal.status = 'running';
      await persist();
      for (const step of plan.steps) {
        active = undefined; issued = false; responded = false;
        checkBinding(scope, plan);
        await recheck(scope, expected);
        if (step.noOp) {
          journal.steps.push({ index: step.index, status: 'no-op', resultIds: [], before: hashes(expected), after: hashes(expected) });
          await persist();
          continue;
        }
        active = { index: step.index, status: 'attempting', resultIds: [], before: hashes(expected) };
        journal.steps.push(active);
        await persist();
        const request = mutation(step.operation);
        issued = true;
        const response = await scope.client.request(request.path, { method: request.method, body: request.body });
        responded = true;
        const ids = resultIds(step.operation, response);
        scope.client.assertNoCredentialContent(ids);
        active.resultIds = ids;
        await persist();
        await verifyEffect(scope, step.operation, response, expected);
        active.status = 'applied';
        active.after = hashes(expected);
        await persist();
      }
      journal.status = 'applied';
      await persist();
      return journal;
    } catch (error) {
      const status = error instanceof NotionError ? error.details?.status : undefined;
      const definiteRefusal = typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
      const uncertain = issued && (responded || !definiteRefusal);
      const knownCode = error instanceof NotionError ? error.code : 'IO_FAILURE';
      const failure = uncertain
        ? new NotionError('UNCERTAIN', 'A mutation may have committed but its complete effect was not verified. Reconcile read-only before further work.')
        : error;
      journal.status = uncertain ? 'uncertain' : journal.steps.some(step => step.status === 'applied') ? 'partial' : 'failed';
      if (active !== undefined && active.status !== 'applied') active.status = uncertain ? 'uncertain' : 'failed';
      journal.error = { code: uncertain ? 'UNCERTAIN' : knownCode, message: uncertain ? 'Mutation outcome requires read-only reconciliation.' : 'The guarded attempt stopped; inspect observations before replanning.' };
      await persist();
      throw failure;
    }
  } finally { await release(); }
}
export async function readPlan(home: string, id: string): Promise<Plan> {
  const raw = await readState(home, 'plans', id);
  const { digest, ...unsigned } = raw;
  if (raw.version !== 1 || raw.id !== id || typeof digest !== 'string' || fingerprint(unsigned) !== digest) throw new NotionError('TAMPERED_STATE', 'Plan digest or identity is invalid.');
  const operations = parseOperations(raw.operations);
  const observations: Observation[] = array(raw.observations).map(entry => {
    const item = object(entry);
    const ref = persistedRef(item.ref);
    const kind = item.kind;
    if (kind !== 'resource' && kind !== 'children' && kind !== 'tree' && kind !== 'query') throw new NotionError('TAMPERED_STATE', 'Unknown observation kind.');
    const before = item.before;
    const source = item.source;
    if (source !== undefined && (source !== 'planner' || kind === 'tree')) throw new NotionError('TAMPERED_STATE', 'Unknown observation source.');
    if (before === undefined || item.fingerprint !== fingerprint(before) || item.key !== keyOf(kind, ref, source)) throw new NotionError('TAMPERED_STATE', 'Observation fingerprint is invalid.');
    return { key: string(item.key), kind, ref, before, fingerprint: string(item.fingerprint), ...(source === undefined ? {} : { source }) };
  });
  const steps = array(raw.steps).map((entry, index) => {
    const step = object(entry);
    const operation = operations[index];
    if (step.index !== index || typeof step.noOp !== 'boolean' || operation === undefined || !same(operation, step.operation)) throw new NotionError('TAMPERED_STATE', 'Plan steps do not match operations.');
    return { index, operation, noOp: step.noOp };
  });
  if (steps.length !== operations.length || typeof raw.destructive !== 'boolean') throw new NotionError('TAMPERED_STATE', 'Incomplete plan.');
  const noOps = steps.filter(step => step.noOp).map(step => step.index);
  if (!same(noOps, raw.noOps)) throw new NotionError('TAMPERED_STATE', 'Invalid no-op list.');
  return {
    version: 1, id, digest, workspace: string(raw.workspace), summary: string(raw.summary),
    binding: object(raw.binding), requestDigest: string(raw.requestDigest), createdAt: string(raw.createdAt),
    operations, observations, steps, destructive: raw.destructive, noOps,
    ...(raw.requestKey === undefined ? {} : { requestKey: string(raw.requestKey) }),
  };
}
export async function readJournal(home: string, id: string): Promise<Journal> {
  const raw = await readState(home, 'journals', id);
  const status = raw.status;
  if (raw.version !== 1 || raw.planId !== id || (status !== 'planned' && status !== 'running' && status !== 'applied' && status !== 'partial' && status !== 'uncertain' && status !== 'failed')) throw new NotionError('TAMPERED_STATE', 'Invalid journal identity or state.');
  const steps: StepResult[] = array(raw.steps).map(entry => {
    const step = object(entry);
    const status = step.status;
    if (typeof step.index !== 'number' || !Number.isSafeInteger(step.index) || (status !== 'attempting' && status !== 'applied' && status !== 'no-op' && status !== 'failed' && status !== 'uncertain')) throw new NotionError('TAMPERED_STATE', 'Invalid journal step.');
    const before = hashRecord(step.before);
    return { index: step.index, status, resultIds: array(step.resultIds).map(value => notionId(string(value))), before, ...(step.after === undefined ? {} : { after: hashRecord(step.after) }) };
  });
  return {
    version: 1, planId: id, planDigest: string(raw.planDigest), workspace: string(raw.workspace), status, steps, updatedAt: string(raw.updatedAt),
    ...(raw.error === undefined ? {} : { error: { code: string(object(raw.error).code), message: string(object(raw.error).message) } }),
    ...(raw.limitations === undefined ? {} : { limitations: array(raw.limitations).map(value => string(value)) }),
  };
}

function persistedRef(value: unknown): ResourceRef {
  const item = object(value);
  const kind = item.kind;
  if (kind !== 'page' && kind !== 'block' && kind !== 'database' && kind !== 'data_source') throw new NotionError('TAMPERED_STATE', 'Invalid persisted resource kind.');
  return { kind, id: notionId(string(item.id)) };
}
function hashRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, value]) => [key, string(value)]));
}
function hashes(observations: Observation[]): Record<string, string> {
  return Object.fromEntries(observations.map(item => [item.key, item.fingerprint]));
}
async function recheck(scope: ScopedNotion, observations: ExpectedObservation[]): Promise<void> {
  for (const item of observations) {
    const current = await observeExpected(scope, item);
    if (fingerprint(current) !== item.fingerprint) throw new NotionError('STALE_PLAN', 'Reviewed resource content, parent or child order changed.', { observation: item.key });
  }
}
function treeContains(value: JsonValue, id: string): boolean {
  if (Array.isArray(value)) return value.some(item => treeContains(item, id));
  if (!isObject(value)) return false;
  return (isObject(value.resource) && value.resource.id === id) || (Array.isArray(value.children) && value.children.some(item => treeContains(item, id)));
}

function prepareSchema(op: Extract<Operation, { kind: 'update-data-source' }>, target: JsonObject): JsonObject {
  const patch = structuredClone(op.patch);
  const existing = object(target.properties);
  const changes = patch.properties === undefined ? {} : object(patch.properties);
  const deleted = Object.entries(changes).filter(([, value]) => value === null).map(([name]) => name).sort();
  requireOperation(same(deleted, [...(op.allowDeleteProperties ?? [])].sort()), 'Schema deletion requires the exact named properties in allowDeleteProperties.');
  for (const [name, value] of Object.entries(changes)) {
    const old = existing[name];
    if (value === null) {
      requireOperation(old !== undefined && object(old).type !== 'title', 'Only an existing, non-title property can be deleted by exact name.');
      continue;
    }
    if (old === undefined) continue;
    const before = object(old);
    const next = object(value);
    const oldType = schemaPropertyType(before);
    const nextType = schemaPropertyType(next);
    requireOperation(oldType === nextType, 'Destructive schema type changes are unsupported.');
    if (oldType === 'relation') requireOperation(same(before.relation, next.relation), 'Changing existing relations is unsupported.');
    if (oldType !== 'select' && oldType !== 'multi_select') continue;
    const oldOptions = array(object(before[oldType]).options).map(objectOption);
    const additions: JsonObject[] = [];
    const used = new Set<string>();
    for (const option of array(object(next[oldType]).options).map(objectOption)) {
      const byId = option.id === undefined ? undefined : oldOptions.find(old => old.id === option.id);
      const byName = option.name === undefined ? undefined : oldOptions.find(old => old.name === option.name);
      requireOperation(byId === undefined || byName === undefined || byId === byName, 'Select option ID and name disagree.');
      const old = byId ?? byName;
      if (old !== undefined) {
        requireOperation((option.id === undefined || option.id === old.id) && (option.name === undefined || option.name === old.name) && (option.color === undefined || option.color === old.color), 'Existing select option names and exact colors must be preserved.');
      } else {
        requireOperation(option.id === undefined && typeof option.name === 'string' && typeof option.color === 'string', 'New select options require a name and explicit color, not an unknown ID.');
        requireOperation(!used.has(option.name), 'Duplicate new select option.');
        used.add(option.name);
        additions.push(option);
      }
    }
    next[oldType] = { options: [...oldOptions, ...additions] };
    changes[name] = next;
  }
  if (patch.properties !== undefined) patch.properties = changes;
  return patch;
}
function objectOption(value: JsonValue): JsonObject {
  const option = object(value);
  const result: JsonObject = {};
  for (const name of ['id', 'name', 'color']) if (option[name] !== undefined) result[name] = option[name];
  return result;
}
function validatePageSchema(properties: JsonObject, dataSource: JsonObject | undefined, creating = false): void {
  if (dataSource === undefined) {
    requireOperation(Object.values(properties).every(value => isObject(value) && Array.isArray(value.title)), 'Pages outside a data source only support the title property.');
    requireOperation(!creating || Object.keys(properties).length === 1, 'New pages require exactly one explicit title property.');
    return;
  }
  const schema = object(dataSource.properties);
  if (creating) {
    for (const [name, value] of Object.entries(schema)) {
      const definition = object(value);
      const supplied = properties[name] ?? Object.entries(properties).find(([key]) => key === definition.id)?.[1];
      requireOperation(supplied !== undefined || ['title', 'rich_text', 'multi_select', 'people', 'relation', 'files', 'checkbox', 'number', 'select', 'date', 'url', 'email', 'phone_number'].includes(schemaPropertyType(definition)),
        'New pages require explicit values for non-deterministic defaults; computed property schemas are unsupported.');
    }
  }
  for (const [name, value] of Object.entries(properties)) {
    const definition = schema[name] ?? Object.values(schema).find(entry => isObject(entry) && entry.id === name);
    requireOperation(definition !== undefined, 'Page property does not exist in its data source schema.');
    const type = schemaPropertyType(object(definition));
    const p = object(value);
    requireOperation(type in p, 'Page property type must match its data source schema.');
    if (type !== 'select' && type !== 'multi_select' && type !== 'status') continue;
    const known = array(object(object(definition)[type]).options).map(objectOption);
    const values = type === 'multi_select' ? array(p[type]) : p[type] === null ? [] : [p[type]];
    for (const option of values) {
      const proposed = object(option);
      requireOperation(known.some(old =>
        (proposed.id === undefined || old.id === proposed.id) &&
        (proposed.name === undefined || old.name === proposed.name) &&
        (proposed.color === undefined || old.color === proposed.color)),
      'Page updates cannot implicitly create or recolor data source options.');
    }
  }
}

function mutation(op: Operation): { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: JsonObject } {
  switch (op.kind) {
    case 'append-blocks': return { path: `/blocks/${op.parentId}/children`, method: 'PATCH', body: { children: op.children, position: op.position === undefined ? { type: 'end' } : object(op.position) } };
    case 'create-page': return { path: '/pages', method: 'POST', body: {
      parent: parentBody(op.parent), properties: op.properties,
      ...(op.children === undefined ? {} : { children: op.children }),
      ...(op.icon === undefined ? {} : { icon: op.icon }), ...(op.cover === undefined ? {} : { cover: op.cover }),
    } };
    case 'create-database': return { path: '/databases', method: 'POST', body: { parent: parentBody(op.parent), title: op.title, initial_data_source: { properties: op.properties } } };
    case 'create-comment': return { path: '/comments', method: 'POST', body: { parent: { page_id: op.parentId }, rich_text: op.richText } };
    case 'move-page': return { path: `/pages/${op.id}/move`, method: 'POST', body: { parent: parentBody(op.parent) } };
    case 'archive-page': return { path: `/pages/${op.id}`, method: 'PATCH', body: { in_trash: true } };
    case 'archive-block': return { path: `/blocks/${op.id}`, method: 'DELETE' };
    case 'update-block': return { path: `/blocks/${op.id}`, method: 'PATCH', body: op.patch };
    case 'update-page': return { path: `/pages/${op.id}`, method: 'PATCH', body: op.patch };
    case 'update-data-source': return { path: `/data_sources/${op.id}`, method: 'PATCH', body: op.patch };
    case 'update-database': return { path: `/databases/${op.id}`, method: 'PATCH', body: op.patch };
  }
}
function resultIds(op: Operation, response: JsonObject): string[] {
  const ids = op.kind === 'append-blocks'
    ? array(response.results).map(item => notionId(string(object(item).id)))
    : [notionId(string(response.id))];
  if (new Set(ids).size !== ids.length || ids.length === 0 || (op.kind === 'append-blocks' && ids.length !== op.children.length) || ('id' in op && ids[0] !== op.id)) {
    throw new NotionError('READBACK_MISMATCH', 'Mutation response has unexpected resource IDs.');
  }
  return ids;
}

function matches(actual: JsonValue | undefined, requested: JsonValue): boolean {
  if (Array.isArray(requested)) return Array.isArray(actual) && actual.length === requested.length && requested.every((item, i) => matches(actual[i], item));
  if (!isObject(requested)) return actual === requested;
  return isObject(actual) && Object.entries(requested).every(([key, value]) => matches(actual[key], value));
}
function requireReadback(condition: boolean): asserts condition {
  if (!condition) throw new NotionError('READBACK_MISMATCH', 'Notion readback differs from the exact intended mutation.');
}
function trashPatch(before: JsonObject, after: JsonObject, expectedInTrash = true): JsonObject {
  requireReadback(after.in_trash === expectedInTrash);
  const patch: JsonObject = { in_trash: expectedInTrash };
  for (const key of ['archived', 'is_archived']) {
    if (after[key] !== before[key]) {
      requireReadback(after[key] === true);
      patch[key] = true;
    }
  }
  return patch;
}
function canonicalRich(value: JsonValue): JsonValue {
  return array(value).map(entry => {
    const item = object(normalize(entry));
    const type = richTextType(item);
    item.type = type;
    item.annotations = {
      bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default',
      ...(item.annotations === undefined ? {} : object(item.annotations)),
    };
    if (type === 'text') item.text = { link: null, ...object(item.text) };
    if (type === 'mention' && isObject(item.mention) && item.mention.type === 'user') {
      item.mention = { type: 'user', user: { id: object(item.mention.user).id ?? null } };
    }
    if (type === 'mention' && isObject(item.mention) && item.mention.type === 'date') {
      item.mention = { ...item.mention, date: { end: null, time_zone: null, ...object(item.mention.date) } };
    }
    return item;
  });
}
function canonicalBlockContent(type: string, value: JsonValue): JsonObject {
  const content = object(normalize(value));
  delete content.children;
  const textBlocks = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code'];
  if (textBlocks.includes(type)) content.rich_text = canonicalRich(content.rich_text ?? []);
  if (textBlocks.includes(type) && type !== 'code') content.color ??= 'default';
  if (type === 'paragraph') content.icon ??= null;
  if (type === 'to_do') content.checked ??= false;
  if (type.startsWith('heading_')) content.is_toggleable ??= false;
  if (['code', 'bookmark', 'embed', 'image', 'video', 'file', 'pdf'].includes(type)) content.caption = canonicalRich(content.caption ?? []);
  if (content.cells !== undefined) content.cells = array(content.cells).map(canonicalRich);
  return content;
}
function canonicalProperty(value: JsonObject, definition?: JsonObject): JsonObject {
  const property = { ...value };
  delete property.id;
  if (property.has_more !== undefined) {
    requireReadback(property.has_more === false);
    delete property.has_more;
  }
  const type = typeof property.type === 'string' ? property.type : Object.keys(property).find(key => key !== 'id');
  requireReadback(typeof type === 'string');
  property.type = type;
  if (type === 'title' || type === 'rich_text') property[type] = canonicalRich(property[type] ?? []);
  if (type === 'date' && isObject(property.date)) property.date = { end: null, time_zone: null, ...property.date };
  if (type === 'people') property.people = array(property.people).map(person => ({ id: object(person).id ?? null }));
  if ((type === 'select' || type === 'multi_select' || type === 'status') && definition !== undefined) {
    const options = array(object(definition[type]).options).map(objectOption);
    const complete = (value: JsonValue): JsonObject => {
      const proposed = object(value);
      const option = options.find(option => (proposed.id === undefined || option.id === proposed.id) && (proposed.name === undefined || option.name === proposed.name));
      requireReadback(option !== undefined);
      return { ...option, ...proposed };
    };
    if (type === 'multi_select') property[type] = array(property[type]).map(complete);
    else if (property[type] !== null) property[type] = complete(property[type] ?? null);
  }
  return property;
}
function emptyProperty(type: string): JsonObject {
  if (['title', 'rich_text', 'multi_select', 'people', 'relation', 'files'].includes(type)) return { type, [type]: [] };
  if (type === 'checkbox') return { type, checkbox: false };
  requireReadback(['number', 'select', 'date', 'url', 'email', 'phone_number'].includes(type));
  return { type, [type]: null };
}
function verifyPageCreation(actual: JsonObject, requested: JsonObject, parent: PageParent, expected: Observation[]): void {
  const actualProperties = object(actual.properties);
  if (parent.kind === 'page') {
    requireReadback(Object.keys(actualProperties).length === 1 && Object.keys(requested).length === 1);
    const actualTitle = Object.values(actualProperties)[0];
    const requestedTitle = Object.values(requested)[0];
    requireReadback(same(canonicalProperty(object(actualTitle)), canonicalProperty(object(requestedTitle))));
    return;
  }
  const source = expected.find(item => item.kind === 'resource' && item.ref.kind === 'data_source' && item.ref.id === parent.id);
  requireReadback(source !== undefined);
  const schema = object(object(source.before).properties);
  requireReadback(same(Object.keys(actualProperties).sort(), Object.keys(schema).sort()));
  for (const [name, value] of Object.entries(schema)) {
    const definition = object(value);
    const supplied = requested[name] ?? Object.entries(requested).find(([key]) => key === definition.id)?.[1];
    const wanted = supplied === undefined ? emptyProperty(schemaPropertyType(definition)) : object(supplied);
    requireReadback(same(canonicalProperty(object(actualProperties[name]), definition), canonicalProperty(wanted, definition)));
  }
}
function canonicalSchema(properties: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = object(value);
    delete property.id;
    if (property.name !== undefined) { requireReadback(property.name === name); delete property.name; }
    property.description ??= null;
    const type = schemaPropertyType(property);
    property.type = type;
    if (type === 'number') property.number = { format: 'number', ...object(property.number) };
    if (type === 'select' || type === 'multi_select') {
      property[type] = {
        ...object(property[type]),
        options: array(object(property[type]).options).map(value => {
          const option = object(value);
          delete option.id;
          return { color: 'default', description: null, ...option };
        }),
      };
    }
    result[name] = property;
  }
  return result;
}
function patched(before: JsonObject, patch: JsonObject, after: JsonObject): JsonObject {
  const expected = structuredClone(before);
  for (const [name, value] of Object.entries(patch)) {
    if (name === 'properties') {
      const properties = object(expected.properties);
      const actual = object(after.properties);
      for (const [key, change] of Object.entries(object(value))) {
        if (change === null) { requireReadback(actual[key] === undefined); delete properties[key]; }
        else {
          const old = properties[key];
          const newValue = actual[key];
          requireReadback(matches(newValue, change));
          if (isObject(old) && isObject(newValue)) {
            const preserved = { ...old };
            for (const field of Object.keys(object(change))) preserved[field] = newValue[field] ?? null;
            requireReadback(same(preserved, newValue));
          }
          properties[key] = newValue ?? null;
        }
      }
      expected.properties = properties;
    } else if (name === before.type && isObject(value)) {
      const content = { ...object(before[name]) };
      const actual = object(after[name]);
      for (const [key, item] of Object.entries(value)) { requireReadback(matches(actual[key], item)); content[key] = actual[key] ?? null; }
      expected[name] = content;
    } else {
      requireReadback(matches(after[name], value));
      expected[name] = after[name] ?? null;
    }
  }
  requireReadback(same(expected, after));
  return after;
}
async function verifyCreatedBlocks(scope: ScopedNotion, ids: string[], requested: JsonObject[], parentId: string): Promise<JsonObject[]> {
  requireReadback(ids.length === requested.length);
  const verified: JsonObject[] = [];
  for (const [index, childId] of ids.entries()) {
    const wanted = requested[index];
    requireReadback(wanted !== undefined);
    const actual = await scope.read({ kind: 'block', id: childId });
    requireReadback(actual.id === childId && parentRef(actual)?.id === parentId && actual.type === wanted.type);
    const type = string(wanted.type);
    const content = object(wanted[type]);
    const { children, ...rest } = content;
    requireReadback(same(canonicalBlockContent(type, actual[type] ?? null), canonicalBlockContent(type, rest)));
    const nested = await scope.children(childId);
    const requestedChildren = children === undefined ? [] : array(children).map(item => object(item));
    const verifiedChildren = await verifyCreatedBlocks(scope, nested.map(item => notionId(string(item.id))), requestedChildren, childId);
    verified.push({ resource: resourceState(actual), children: verifiedChildren });
  }
  return verified;
}

async function verifyEffect(scope: ScopedNotion, op: Operation, response: JsonObject, expected: ExpectedObservation[]): Promise<void> {
  const ids = resultIds(op, response);
  const transitions = new Map<string, JsonObject>();
  const addedObservations: ExpectedObservation[] = [];
  const archiving = op.kind === 'archive-page' || op.kind === 'archive-block';
  function watchCreated(ref: ResourceRef, before: JsonObject): void {
    addedObservations.push({ kind: 'tree', ref, key: keyOf('tree', ref), before, fingerprint: fingerprint(before) });
  }
  let newResource: JsonObject | undefined;
  let sourceParent: ResourceRef | undefined;
  const changedId = 'id' in op ? op.id : undefined;
  const targetObservation = changedId === undefined ? undefined : expected.find(item => item.kind === 'resource' && item.source !== 'planner' && item.ref.id === changedId);
  if (targetObservation !== undefined) {
    const before = object(targetObservation.before);
    sourceParent = parentRef(before);
    // Trash readback is safe only for the exact target authorized immediately before the request.
    const after = resourceState(op.kind.startsWith('archive-')
      ? await scope.client.request(route(targetObservation.ref))
      : await scope.read(targetObservation.ref));
    let patch: JsonObject;
    if (op.kind === 'move-page') {
      requireReadback(isParent(after, op.parent));
      patch = { parent: after.parent ?? null };
    } else if (op.kind === 'archive-page' || op.kind === 'archive-block') {
      patch = trashPatch(before, after);
    } else if ('patch' in op) patch = op.patch;
    else throw new NotionError('READBACK_MISMATCH', 'Unexpected target operation.');
    transitions.set(changedId ?? '', patched(before, patch, after));
  } else if (op.kind === 'append-blocks') {
    const created = await verifyCreatedBlocks(scope, ids, op.children, op.parentId);
    for (const value of created) watchCreated({ kind: 'block', id: string(object(value.resource).id) }, value);
  } else if (op.kind === 'create-page' || op.kind === 'create-database') {
    const ref: ResourceRef = { kind: op.kind === 'create-page' ? 'page' : 'database', id: string(ids[0]) };
    newResource = resourceState(await scope.read(ref));
    requireReadback(newResource.id === ref.id && isParent(newResource, op.parent));
    if (op.kind === 'create-page') {
      verifyPageCreation(newResource, op.properties, op.parent, expected);
      requireReadback(same(newResource.icon ?? null, op.icon ?? null));
      requireReadback(same(newResource.cover ?? null, op.cover ?? null));
      requireReadback(newResource.in_trash !== true && newResource.archived !== true);
      const children = await scope.children(ref.id);
      const verified = await verifyCreatedBlocks(scope, children.map(child => notionId(string(child.id))), op.children ?? [], ref.id);
      watchCreated(ref, { resource: newResource, children: verified });
    } else {
      requireReadback(same(canonicalRich(newResource.title ?? []), canonicalRich(op.title)));
      requireReadback((newResource.icon ?? null) === null && (newResource.cover ?? null) === null && newResource.in_trash !== true);
      const sources = array(newResource.data_sources);
      requireReadback(sources.length === 1);
      const source = await scope.read({ kind: 'data_source', id: notionId(string(object(sources[0]).id)) });
      requireReadback(same(canonicalSchema(object(source.properties)), canonicalSchema(op.properties)));
      watchCreated(ref, { resource: newResource, children: [{ resource: resourceState(source), children: [] }] });
    }
  } else if (op.kind === 'create-comment') {
    await scope.read({ kind: 'page', id: op.parentId });
    const comments = await scope.client.paginate(`/comments?block_id=${op.parentId}`);
    const created = comments.find(comment => comment.id === ids[0]);
    requireReadback(created !== undefined && same(canonicalRich(created.rich_text ?? []), canonicalRich(op.richText)) && object(created.parent).page_id === op.parentId);
  }

  if (archiving) {
    const beforeTree = expected.find(item => item.kind === 'tree' && item.ref.id === op.id);
    requireReadback(beforeTree !== undefined);
    await reviewedTree(scope, beforeTree.before, transitions);
  }

  const actuals: Array<{ observation: ExpectedObservation; value: JsonValue; reconciled: boolean }> = [];
  for (const observation of [...expected, ...addedObservations]) {
    const reconciled = observation.archiveReconciled === true
      || (archiving && transitions.has(observation.ref.id) && (observation.kind === 'tree' || observation.kind === 'children'));
    const candidate: ExpectedObservation = { ...observation, ...(reconciled ? { archiveReconciled: true } : {}) };
    if (observation.source === 'planner') {
      const after = await observeExpected(scope, candidate);
      await verifyPlannerEffect(scope, observation, after, op, ids, transitions, sourceParent);
      actuals.push({ observation, value: after, reconciled });
      continue;
    }
    const after = op.kind.startsWith('archive-') && observation.ref.id === changedId
      && observation.kind === 'resource' ? transitions.get(changedId ?? '') ?? null
      : await observeExpected(scope, candidate);
    let wanted = structuredClone(observation.before);
    if (observation.kind === 'resource') {
      const updated = transitions.get(observation.ref.id);
      if (updated !== undefined) wanted = updated;
    } else if (observation.kind === 'tree') {
      wanted = transformTree(wanted, transitions, archiving ? op.id : undefined);
    } else if (observation.kind === 'children') {
      wanted = updateChildList(array(wanted), array(after), observation.ref.id, op, ids, transitions, sourceParent);
    } else if (observation.kind === 'query') {
      const members = new Set(array(wanted).map(value => string(value)));
      if ((op.kind === 'archive-page' || op.kind === 'move-page') && sourceParent?.id === observation.ref.id) members.delete(op.id);
      if ((op.kind === 'create-page' || op.kind === 'move-page') && op.parent.id === observation.ref.id) members.add(op.kind === 'move-page' ? op.id : string(ids[0]));
      wanted = [...members].sort();
    }
    requireReadback(same(wanted, after));
    actuals.push({ observation, value: after, reconciled });
  }
  // Only advance expectations after every unrelated observation and intended delta has matched.
  for (const { observation, value, reconciled } of actuals) {
    observation.before = value;
    observation.fingerprint = fingerprint(value);
    if (reconciled) observation.archiveReconciled = true;
  }
  expected.push(...addedObservations);
}

async function plannerResourceAfter(
  scope: ScopedNotion, before: JsonObject, after: JsonObject, op: Operation,
  transitions: Map<string, JsonObject>, sourceParent: ResourceRef | undefined,
): Promise<JsonObject> {
  const resourceId = string(before.id);
  let patch: JsonObject = {};
  if ((op.kind === 'archive-page' || op.kind === 'archive-block') && transitions.has(resourceId)) {
    const transition = object(transitions.get(resourceId));
    const matchingResourceKind = transition.object === before.object;
    const expectedInTrash = matchingResourceKind ? transition.in_trash : true;
    requireReadback(typeof expectedInTrash === 'boolean');
    patch = trashPatch(before, after, expectedInTrash);
  } else if ('id' in op && resourceId === op.id) {
    const transition = transitions.get(resourceId);
    requireReadback(transition !== undefined);
    if (op.kind === 'move-page') patch.parent = transition.parent ?? null;
    else if ('patch' in op) {
      if (before.type === 'child_page' && transition.object === 'page') {
        patch.child_page = { title: pageTitle(transition) };
      } else if (before.type === 'child_database' && transition.object === 'database') {
        patch.child_database = { title: pageTitle(transition) };
      } else patch = { ...op.patch };
    }
  }
  const ownMembershipChange =
    (op.kind === 'append-blocks' && op.parentId === resourceId)
    || ((op.kind === 'create-page' || op.kind === 'create-database' || op.kind === 'move-page') && op.parent.id === resourceId)
    || ((op.kind === 'move-page' || op.kind === 'archive-page' || op.kind === 'archive-block') && sourceParent?.id === resourceId);
  if (ownMembershipChange && typeof before.has_children === 'boolean') {
    patch.has_children = (await scope.children(resourceId)).length > 0;
  }
  const rowParent = parentRef(before);
  if (op.kind === 'update-data-source' && rowParent?.kind === 'data_source' && rowParent.id === op.id && op.patch.properties !== undefined) {
    const properties: JsonObject = {};
    const previous = object(before.properties);
    for (const [name, definition] of Object.entries(object(op.patch.properties))) {
      if (definition === null) properties[name] = null;
      else if (previous[name] === undefined) properties[name] = emptyProperty(schemaPropertyType(object(definition)));
    }
    if (Object.keys(properties).length > 0) patch.properties = properties;
  }
  return patched(before, patch, after);
}

async function verifyPlannerEffect(
  scope: ScopedNotion, observation: Observation, after: JsonValue, op: Operation, ids: string[],
  transitions: Map<string, JsonObject>, sourceParent: ResourceRef | undefined,
): Promise<void> {
  if (observation.kind === 'resource') {
    await plannerResourceAfter(scope, object(observation.before), object(after), op, transitions, sourceParent);
    return;
  }
  const before = array(observation.before).map(item => object(item));
  const current = array(after).map(item => object(item));
  const currentById = new Map(current.map(item => [string(item.id), item]));
  requireReadback(currentById.size === current.length);
  const removedId = (op.kind === 'move-page' || op.kind === 'archive-page' || op.kind === 'archive-block') && sourceParent?.id === observation.ref.id ? op.id : undefined;
  const expected: JsonObject[] = [];
  for (const entry of before) {
    if (entry.id === removedId) { expected.push(entry); continue; }
    const actual = currentById.get(string(entry.id));
    requireReadback(actual !== undefined);
    expected.push(await plannerResourceAfter(scope, entry, actual, op, transitions, sourceParent));
  }
  const wanted = updateChildList(expected, current, observation.ref.id, op, ids, new Map(), sourceParent).map(item => object(item));
  if (observation.kind === 'children') {
    requireReadback(same(wanted, current));
    return;
  }
  requireReadback(observation.kind === 'query');
  const actualIds = current.map(item => string(item.id));
  const wantedIds = wanted.map(item => string(item.id));
  requireReadback(same([...actualIds].sort(), [...wantedIds].sort()));
  const movedInOrder = op.kind === 'create-page' ? ids[0]
    : op.kind === 'update-page' || op.kind === 'move-page' ? op.id : undefined;
  // Default queries can reposition the row we edited; unaffected rows must retain their order.
  requireReadback(same(actualIds.filter(id => id !== movedInOrder), wantedIds.filter(id => id !== movedInOrder)));
  for (const entry of wanted) requireReadback(same(entry, currentById.get(string(entry.id))));
}

function transformTree(value: JsonValue, transitions: Map<string, JsonObject>, removedId?: string): JsonValue {
  const node = object(value);
  const resource = object(node.resource);
  return {
    ...node, resource: transitions.get(string(resource.id)) ?? resource,
    children: array(node.children)
      .filter(child => object(object(child).resource).id !== removedId)
      .map(child => transformTree(child, transitions, removedId)),
  };
}
function updateChildList(
  before: JsonValue[], after: JsonValue[], parentId: string, op: Operation, ids: string[],
  transitions: Map<string, JsonObject>, sourceParent: ResourceRef | undefined,
): JsonValue[] {
  let wanted: JsonObject[] = before.map(entry => {
    const old = object(entry);
    const updated = transitions.get(string(old.id));
    if (updated === undefined) return old;
    const inheritedTrash = (op.kind === 'archive-page' || op.kind === 'archive-block') && old.id !== op.id
      && (old.type === 'child_page' || old.type === 'child_database')
      ? trashPatch(old, object(after.find(entry => object(entry).id === old.id))) : {};
    if (old.type === 'child_page' && updated.object === 'page') return {
      ...old, ...inheritedTrash, child_page: { ...object(old.child_page), title: pageTitle(updated) },
    };
    if (old.type === 'child_database' && updated.object === 'database') return {
      ...old, ...inheritedTrash, child_database: { ...object(old.child_database), title: pageTitle(updated) },
    };
    if (old.object !== updated.object) return old;
    return updated;
  });
  if ((op.kind === 'move-page' || op.kind === 'archive-page' || op.kind === 'archive-block') && sourceParent?.id === parentId) {
    wanted = wanted.filter(entry => entry.id !== op.id);
  }
  if ((op.kind === 'create-page' || op.kind === 'create-database' || op.kind === 'move-page') && op.parent.id === parentId) {
    const id = op.kind === 'move-page' ? op.id : string(ids[0]);
    const added = after.find(entry => object(entry).id === id);
    requireReadback(added !== undefined && parentRef(object(added))?.id === parentId);
    wanted.push(object(added));
  }
  if (op.kind === 'append-blocks' && op.parentId === parentId) {
    const inserted = ids.map(id => {
      const entry = after.find(value => object(value).id === id);
      requireReadback(entry !== undefined && !before.some(value => object(value).id === id));
      return object(entry);
    });
    const position = op.position;
    const offset = position?.type === 'start' ? 0 : position?.type === 'after_block'
      ? wanted.findIndex(entry => entry.id === position.after_block.id) + 1 : wanted.length;
    requireReadback(position?.type !== 'after_block' || offset > 0);
    wanted.splice(offset, 0, ...inserted);
  }
  return wanted;
}
