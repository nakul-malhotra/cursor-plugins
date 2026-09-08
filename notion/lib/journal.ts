import type { JsonObject, JsonValue, ResourceRef } from './types.js';
import type { Operation } from './operations.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readPrivateJson } from './config.js';
import { NotionError } from './errors.js';
import { assertNoSecrets } from './operations.js';
import { canonicalJson, isObject, object, string } from './values.js';

export interface Observation {
  key: string;
  kind: 'resource' | 'children' | 'tree' | 'query';
  ref: ResourceRef;
  before: JsonValue;
  fingerprint: string;
  source?: 'planner';
}
export interface Plan {
  version: 1;
  id: string;
  workspace: string;
  summary: string;
  binding: JsonObject;
  requestKey?: string;
  requestDigest: string;
  createdAt: string;
  operations: Operation[];
  steps: Array<{ index: number; operation: Operation; noOp: boolean }>;
  destructive: boolean;
  noOps: number[];
  observations: Observation[];
  digest: string;
}
export type JournalStatus = 'planned' | 'running' | 'applied' | 'partial' | 'uncertain' | 'failed';
export interface StepResult {
  index: number;
  status: 'attempting' | 'applied' | 'no-op' | 'failed' | 'uncertain';
  resultIds: string[];
  before: Record<string, string>;
  after?: Record<string, string>;
}
export interface Journal {
  version: 1;
  planId: string;
  planDigest: string;
  workspace: string;
  status: JournalStatus;
  steps: StepResult[];
  updatedAt: string;
  error?: { code: string; message: string; causeCode?: string };
  limitations?: string[];
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function validatePlanId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new NotionError('INVALID_PLAN_ID', 'Plan ID must be a normalized UUID.');
  }
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!errno(error, 'EEXIST')) throw error; }
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new NotionError('UNSAFE_STATE', 'Private directory cannot be a symlink.');
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new NotionError('UNSAFE_STATE', 'Private state directories require owner-only mode 700.');
  }
}

export async function stateDirectory(home: string, create = false): Promise<string> {
  const root = resolve(home);
  await privateDirectory(root, false);
  const state = join(root, '.state');
  await privateDirectory(state, create);
  for (const name of ['plans', 'journals', 'locks']) await privateDirectory(join(state, name), create);
  return state;
}

async function validateExistingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new NotionError('UNSAFE_STATE', 'Private file cannot be a symlink.');
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
      throw new NotionError('UNSAFE_STATE', 'Private files require one link, current ownership and mode 600.');
    }
    return true;
  } catch (error) {
    if (errno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${canonicalJson(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if (!errno(error, 'ENOENT')) throw error; }
}

async function key(state: string, create: boolean): Promise<string> {
  const path = join(state, 'integrity.json');
  if (create && !(await validateExistingFile(path))) {
    try { await writeExclusive(path, { key: randomBytes(32).toString('hex') }); await syncDirectory(state); }
    catch (error) { if (!errno(error, 'EEXIST')) throw error; }
  }
  if (!(await validateExistingFile(path))) throw new NotionError('TAMPERED_STATE', 'State integrity key is missing.');
  const value = object(await readPrivateJson(path));
  const secret = string(value.key);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new NotionError('TAMPERED_STATE', 'Invalid state integrity key.');
  return secret;
}

function signature(value: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(value)).digest('hex');
}

export async function writeState(home: string, kind: 'plans' | 'journals', id: string, value: unknown): Promise<void> {
  validatePlanId(id);
  const payload = object(value);
  assertNoSecrets(payload);
  const state = await stateDirectory(home, true);
  const envelope = { payload, signature: signature(payload, await key(state, true)) };
  const directory = join(state, kind);
  const path = join(directory, `${id}.json`);
  if (kind === 'plans') {
    await writeExclusive(path, envelope);
  } else {
    await validateExistingFile(path);
    const temporary = join(directory, `${id}.${randomUUID()}.tmp`);
    await writeExclusive(temporary, envelope);
    try {
      await validateExistingFile(path);
      await rename(temporary, path);
    } finally { await unlinkIfPresent(temporary); }
  }
  await syncDirectory(directory);
}

export async function readState(home: string, kind: 'plans' | 'journals', id: string): Promise<JsonObject> {
  validatePlanId(id);
  let state: string;
  try { state = await stateDirectory(home); }
  catch (error) {
    if (errno(error, 'ENOENT')) throw new NotionError(kind === 'plans' ? 'PLAN_NOT_FOUND' : 'JOURNAL_NOT_FOUND', 'Private state does not exist.');
    throw error;
  }
  const path = join(state, kind, `${id}.json`);
  if (!(await validateExistingFile(path))) throw new NotionError(kind === 'plans' ? 'PLAN_NOT_FOUND' : 'JOURNAL_NOT_FOUND', 'Requested state file does not exist.');
  const envelope = object(await readPrivateJson(path));
  const payload = object(envelope.payload);
  const expected = signature(payload, await key(state, false));
  const actual = string(envelope.signature);
  if (!/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new NotionError('TAMPERED_STATE', 'Private state integrity validation failed.');
  }
  return payload;
}

export async function acquireLock(home: string, scopeKey: string, planId: string): Promise<() => Promise<void>> {
  const state = await stateDirectory(home, true);
  if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new NotionError('UNSAFE_STATE', 'Invalid scope lock key.');
  const path = join(state, 'locks', `${scopeKey}.json`);
  const owner = randomUUID();
  try {
    await writeExclusive(path, { owner, pid: process.pid, planId, startedAt: new Date().toISOString() });
    await syncDirectory(join(state, 'locks'));
  } catch (error) {
    if (!errno(error, 'EEXIST')) throw error;
    await validateExistingFile(path);
    const existing = object(await readPrivateJson(path));
    const pid = existing.pid;
    let dead = false;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (probeError) {
        if (errno(probeError, 'ESRCH')) dead = true;
        else if (!errno(probeError, 'EPERM')) throw probeError;
      }
    }
    // Never race an automatic unlink against a recovering or PID-reused owner.
    throw new NotionError('BUSY', dead
      ? 'The lock owner PID is dead. Inspect its journal read-only, then explicitly remove this stale lock before proceeding.'
      : 'This scope has a live or unverifiable mutation lock; no mutation was attempted.',
    { lockPath: path, ownerPid: typeof pid === 'number' ? pid : null, stale: dead });
  }
  const acquired = await lstat(path);
  return async () => {
    if (!(await validateExistingFile(path))) throw new NotionError('LOCK_LOST', 'Mutation lock disappeared; owner cannot release it.');
    const current = await lstat(path);
    const record = await readPrivateJson(path);
    if (current.ino !== acquired.ino || current.dev !== acquired.dev || !isObject(record) || record.owner !== owner) {
      throw new NotionError('LOCK_LOST', 'Mutation lock was replaced; refusing to release another owner.');
    }
    await unlink(path);
    await syncDirectory(join(state, 'locks'));
  };
}
