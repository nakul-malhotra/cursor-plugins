import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { NotionError } from './errors.js';
import type {
  BlockTodoProfile,
  DatabaseTodoProfile,
  JsonObject,
  Profile,
  ResourceKind,
  ResourceRef,
} from './types.js';
import {
  array as jsonArray,
  notionId,
  object as jsonObject,
  string as jsonString,
} from './values.js';

export function defaultHome(): string {
  return process.env.NOTION_HOME ?? join(homedir(), '.copilot', 'notion');
}

export async function readPrivateJson(file: string): Promise<unknown> {
  await assertPrivateFile(file, false);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    throw new NotionError('CONFIG_IO', `Unable to read private file ${basename(file)}.`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new NotionError('CONFIG_JSON', `Private file ${basename(file)} contains invalid JSON.`);
  }
}

export async function loadProfiles(home: string): Promise<Profile[]> {
  await assertPrivateDirectory(home);
  const profilesDirectory = join(home, 'profiles');
  await assertPrivateDirectory(profilesDirectory);
  const registryFile = join(home, '.workspaces.json');
  await assertPrivateFile(registryFile, true);
  const registry = jsonObject(await readPrivateJson(registryFile), 'workspace registry');
  if (registry.version !== 1) {
    throw new NotionError('CONFIG_SCHEMA', 'Workspace registry version must be 1.');
  }
  const slugs = stringList(registry.profiles, 'workspace registry profiles');
  if (slugs.length === 0) {
    throw new NotionError('CONFIG_SCHEMA', 'Workspace registry must list at least one profile.');
  }
  const uniqueSlugs = new Set<string>();
  const profiles: Profile[] = [];
  for (const slug of slugs) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new NotionError('CONFIG_SCHEMA', `Unsafe profile slug: ${slug}.`);
    }
    if (uniqueSlugs.has(slug)) {
      throw new NotionError('CONFIG_SCHEMA', `Duplicate profile slug: ${slug}.`);
    }
    uniqueSlugs.add(slug);
    const file = join(profilesDirectory, `${slug}.json`);
    await assertPrivateFile(file, true);
    profiles.push(parseProfile(await readPrivateJson(file), slug));
  }
  assertUniqueSelectors(profiles);
  return profiles;
}

export async function resolveProfile(
  home: string,
  selector?: string,
  cwd?: string,
): Promise<Profile> {
  const profiles = await loadProfiles(home);
  if (selector !== undefined) {
    const matches = profiles.filter(
      profile => profile.key === selector || profile.aliases.includes(selector),
    );
    if (matches.length !== 1) {
      throw new NotionError('PROFILE_NOT_FOUND', `No unique profile matches selector "${selector}".`);
    }
    return firstProfile(matches);
  }

  const directory = resolve(cwd ?? process.cwd());
  const matches = profiles.filter(profile =>
    profile.repositories.some(repository => repositoryMatches(repository, directory)),
  );
  if (matches.length === 0) {
    throw new NotionError(
      'PROFILE_NOT_FOUND',
      'No profile is associated with the current repository.',
    );
  }
  if (matches.length > 1) {
    throw new NotionError(
      'PROFILE_NOT_FOUND',
      'The current repository matches multiple profiles.',
    );
  }
  return firstProfile(matches);
}

export async function readCredential(home: string, ref: string): Promise<string> {
  await assertPrivateDirectory(home);
  const file = join(home, '.credentials.json');
  await assertPrivateFile(file, true);
  const credentialFile = jsonObject(await readPrivateJson(file), 'credential file');
  if (credentialFile.version !== 1) {
    throw new NotionError('CREDENTIAL_SCHEMA', 'Credential file version must be 1.');
  }
  const connections = jsonObject(credentialFile.connections, 'credential connections');
  for (const [key, value] of Object.entries(connections)) {
    const connection = jsonObject(value, `credential connection ${key}`);
    nonempty(connection.token, `credential connection ${key} token`);
  }
  const selected = connections[ref];
  if (selected === undefined) {
    throw new NotionError('CREDENTIAL_NOT_FOUND', `Credential reference "${ref}" is not configured.`);
  }
  return nonempty(jsonObject(selected, `credential connection ${ref}`).token, 'credential token');
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new NotionError('CONFIG_IO', `Private directory is unavailable: ${basename(path)}.`);
  }
  if (stat.isSymbolicLink()) {
    throw new NotionError('CONFIG_SECURITY', `Private directory cannot be a symbolic link: ${basename(path)}.`);
  }
  if (!stat.isDirectory()) {
    throw new NotionError('CONFIG_SECURITY', `Expected a private directory: ${basename(path)}.`);
  }
  assertOwner(stat.uid, `directory ${basename(path)}`);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new NotionError('CONFIG_SECURITY', `Private directory ${basename(path)} must have mode 700.`);
  }
}

async function assertPrivateFile(path: string, exactMode: boolean): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new NotionError('CONFIG_IO', `Private file is unavailable: ${basename(path)}.`);
  }
  if (stat.isSymbolicLink()) {
    throw new NotionError('CONFIG_SECURITY', `Private file cannot be a symbolic link: ${basename(path)}.`);
  }
  if (!stat.isFile()) {
    throw new NotionError('CONFIG_SECURITY', `Expected a regular file: ${basename(path)}.`);
  }
  assertOwner(stat.uid, `file ${basename(path)}`);
  const mode = stat.mode & 0o777;
  if ((exactMode && mode !== 0o600) || (!exactMode && (mode & 0o077) !== 0)) {
    throw new NotionError(
      'CONFIG_SECURITY',
      exactMode
        ? `Private file ${basename(path)} must have mode 600.`
        : `Private file ${basename(path)} must not allow group or other access.`,
    );
  }
}

function assertOwner(uid: number, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new NotionError('CONFIG_SECURITY', `Private ${label} must be owned by the current user.`);
  }
}

function parseProfile(value: unknown, slug: string): Profile {
  const raw = jsonObject(value, `profile ${slug}`);
  const key = nonempty(raw.key, `profile ${slug} key`);
  const label = nonempty(raw.label, `profile ${slug} label`);
  const aliases = stringList(raw.aliases, `profile ${slug} aliases`).map((alias, index) =>
    nonempty(alias, `profile ${slug} alias ${index}`),
  );
  const repositories = stringList(raw.repositories, `profile ${slug} repositories`).map(
    (repository, index) => nonempty(repository, `profile ${slug} repository ${index}`),
  );
  const credentialRef = nonempty(raw.credentialRef, `profile ${slug} credentialRef`);
  const connectionRaw = jsonObject(raw.connection, `profile ${slug} connection`);
  const workspaceIdValue = optionalNonempty(
    connectionRaw.workspaceId,
    `profile ${slug} workspaceId`,
  );
  const workspaceId = workspaceIdValue === undefined ? undefined : notionId(workspaceIdValue);
  const connection = {
    botId: notionId(nonempty(connectionRaw.botId, `profile ${slug} botId`)),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
  const roots = resourceList(raw.roots, `profile ${slug} roots`);
  if (roots.length === 0) {
    throw new NotionError('CONFIG_SCHEMA', `Profile ${slug} must have at least one root.`);
  }
  const protectedRefs = resourceList(raw.protected, `profile ${slug} protected`);
  const canonicalRaw = jsonObject(raw.canonical, `profile ${slug} canonical references`);
  const canonical = Object.fromEntries(
    Object.entries(canonicalRaw).map(([name, ref]) => [
      nonempty(name, `profile ${slug} canonical name`),
      parseResourceRef(ref, `profile ${slug} canonical ${name}`),
    ]),
  );
  const timezone = nonempty(raw.timezone, `profile ${slug} timezone`);
  assertTimezone(timezone, slug);
  let todos: Profile['todos'] = null;
  if (raw.todos !== null) {
    todos = parseTodos(jsonObject(raw.todos, `profile ${slug} todos`), slug);
  }
  return {
    key,
    label,
    aliases,
    repositories,
    credentialRef,
    connection,
    roots,
    protected: protectedRefs,
    canonical,
    timezone,
    todos,
  };
}

function parseTodos(value: JsonObject, slug: string): BlockTodoProfile | DatabaseTodoProfile {
  if (value.kind === 'blocks') {
    return parseBlockTodos(value, slug);
  }
  if (value.kind === 'database') {
    return parseDatabaseTodos(value, slug);
  }
  throw new NotionError('CONFIG_SCHEMA', `Profile ${slug} has an unknown todo kind.`);
}

function parseBlockTodos(value: JsonObject, slug: string): BlockTodoProfile {
  const containersRaw = jsonObject(value.containers, `profile ${slug} todo containers`);
  const entries: Array<[string, BlockTodoProfile['containers'][string]]> =
    Object.entries(containersRaw).map(([name, entry]) => {
      const container = jsonObject(entry, `profile ${slug} todo container ${name}`);
      const layout = nonempty(container.layout, `profile ${slug} todo container ${name} layout`);
      if (layout !== 'dated' && layout !== 'sections' && layout !== 'flat') {
        throw new NotionError('CONFIG_SCHEMA', `Unknown todo layout "${layout}".`);
      }
      const section = optionalNonempty(
        container.section,
        `profile ${slug} todo container ${name} section`,
      );
      const sectionLabels =
        container.sectionLabels === undefined
          ? undefined
          : uniqueStrings(
              container.sectionLabels,
              `profile ${slug} todo container ${name} sectionLabels`,
            );
      const dateOrder = optionalNonempty(
        container.dateOrder,
        `profile ${slug} todo container ${name} dateOrder`,
      );
      if (dateOrder !== undefined && dateOrder !== 'descending' && dateOrder !== 'preserve') {
        throw new NotionError('CONFIG_SCHEMA', `Unknown todo date order "${dateOrder}".`);
      }
      return [
        nonempty(name, `profile ${slug} todo container name`),
        {
          id: notionId(nonempty(container.id, `profile ${slug} todo container ${name} id`)),
          layout,
          ...(section === undefined ? {} : { section }),
          ...(sectionLabels === undefined ? {} : { sectionLabels }),
          ...(dateOrder === undefined ? {} : { dateOrder }),
        },
      ];
    });
  const containers = Object.fromEntries(entries);
  const backlogContainer = optionalNonempty(
    value.backlogContainer,
    `profile ${slug} backlogContainer`,
  );
  if (backlogContainer !== undefined && containers[backlogContainer] === undefined) {
    throw new NotionError('CONFIG_SCHEMA', 'Todo backlogContainer must name a configured container.');
  }
  const backlogContainers =
    value.backlogContainers === undefined
      ? undefined
      : parseBacklogContainers(value.backlogContainers, containers, slug);
  return {
    kind: 'blocks',
    pageId: notionId(nonempty(value.pageId, `profile ${slug} todo pageId`)),
    defaultOwner: nonempty(value.defaultOwner, `profile ${slug} defaultOwner`),
    containers,
    ...(backlogContainer === undefined ? {} : { backlogContainer }),
    ...(backlogContainers === undefined ? {} : { backlogContainers }),
    logBuckets: stringList(value.logBuckets, `profile ${slug} logBuckets`),
  };
}

function parseDatabaseTodos(value: JsonObject, slug: string): DatabaseTodoProfile {
  const statusType = nonempty(value.statusType, `profile ${slug} todo statusType`);
  if (statusType !== 'status' && statusType !== 'select' && statusType !== 'checkbox') {
    throw new NotionError('CONFIG_SCHEMA', `Unknown todo status type "${statusType}".`);
  }
  const pendingValue = statusValue(value.pendingValue, statusType, 'pendingValue', slug);
  const doneValue = statusValue(value.doneValue, statusType, 'doneValue', slug);
  const dateProperty = optionalNonempty(value.dateProperty, `profile ${slug} dateProperty`);
  const ownerProperty = optionalNonempty(value.ownerProperty, `profile ${slug} ownerProperty`);
  const ownerType = optionalNonempty(value.ownerType, `profile ${slug} ownerType`);
  if (ownerType !== undefined && ownerType !== 'people' && ownerType !== 'select') {
    throw new NotionError('CONFIG_SCHEMA', `Unknown todo owner type "${ownerType}".`);
  }
  if ((ownerProperty === undefined) !== (ownerType === undefined)) {
    throw new NotionError(
      'CONFIG_SCHEMA',
      'Todo ownerProperty and ownerType must be configured together.',
    );
  }
  const ownersRaw = jsonObject(value.owners, `profile ${slug} todo owners`);
  const owners = Object.fromEntries(
    Object.entries(ownersRaw).map(([owner, identifier]) => [
      nonempty(owner, `profile ${slug} owner name`),
      nonempty(identifier, `profile ${slug} owner ${owner}`),
    ]),
  );
  return {
    kind: 'database',
    dataSourceId: notionId(nonempty(value.dataSourceId, `profile ${slug} dataSourceId`)),
    titleProperty: nonempty(value.titleProperty, `profile ${slug} titleProperty`),
    statusProperty: nonempty(value.statusProperty, `profile ${slug} statusProperty`),
    statusType,
    pendingValue,
    doneValue,
    ...(dateProperty === undefined ? {} : { dateProperty }),
    ...(ownerProperty === undefined ? {} : { ownerProperty }),
    ...(ownerType === undefined ? {} : { ownerType }),
    owners,
  };
}

function statusValue(
  value: unknown,
  type: 'status' | 'select' | 'checkbox',
  label: string,
  slug: string,
): string | boolean {
  if (type === 'checkbox') {
    if (typeof value !== 'boolean') {
      throw new NotionError('CONFIG_SCHEMA', `Profile ${slug} ${label} must be boolean.`);
    }
    return value;
  }
  return nonempty(value, `profile ${slug} ${label}`);
}

function resourceList(value: unknown, label: string): ResourceRef[] {
  return jsonArray(value, label).map((entry, index) => parseResourceRef(entry, `${label}[${index}]`));
}

function parseResourceRef(value: unknown, label: string): ResourceRef {
  const raw = jsonObject(value, label);
  const kind = nonempty(raw.kind, `${label} kind`);
  if (!isResourceKind(kind)) {
    throw new NotionError('CONFIG_SCHEMA', `${label} has unknown resource kind "${kind}".`);
  }
  return { kind, id: notionId(nonempty(raw.id, `${label} id`)) };
}

function isResourceKind(value: string): value is ResourceKind {
  return value === 'page' || value === 'block' || value === 'database' || value === 'data_source';
}

function stringList(value: unknown, label: string): string[] {
  return jsonArray(value, label).map((entry, index) => jsonString(entry, `${label}[${index}]`));
}

function uniqueStrings(value: unknown, label: string): string[] {
  const values = stringList(value, label).map((entry, index) =>
    nonempty(entry, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new NotionError('CONFIG_SCHEMA', `${label} must contain unique values.`);
  }
  return values;
}

function parseBacklogContainers(
  value: unknown,
  containers: BlockTodoProfile['containers'],
  slug: string,
): Record<string, string> {
  const mappings = jsonObject(value, `profile ${slug} backlogContainers`);
  return Object.fromEntries(
    Object.entries(mappings).map(([owner, containerValue]) => {
      const ownerName = nonempty(owner, `profile ${slug} backlogContainers owner`);
      const container = nonempty(
        containerValue,
        `profile ${slug} backlog container for ${ownerName}`,
      );
      if (containers[container] === undefined) {
        throw new NotionError(
          'CONFIG_SCHEMA',
          `Backlog container for ${ownerName} must name a configured container.`,
        );
      }
      return [ownerName, container];
    }),
  );
}

function optionalNonempty(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonempty(value, label);
}

function nonempty(value: unknown, label: string): string {
  const result = jsonString(value, label).trim();
  if (result.length === 0) throw new NotionError('CONFIG_SCHEMA', `${label} must not be empty.`);
  return result;
}

function assertTimezone(timezone: string, slug: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new NotionError('CONFIG_SCHEMA', `Profile ${slug} has an invalid timezone.`);
  }
}

function assertUniqueSelectors(profiles: Profile[]): void {
  const selectors = new Map<string, string>();
  for (const profile of profiles) {
    for (const selector of [profile.key, ...profile.aliases]) {
      const owner = selectors.get(selector);
      if (owner !== undefined) {
        throw new NotionError(
          'CONFIG_SCHEMA',
          `Duplicate profile key or alias "${selector}" in ${owner} and ${profile.key}.`,
        );
      }
      selectors.set(selector, profile.key);
    }
  }
}

function firstProfile(profiles: Profile[]): Profile {
  const profile = profiles[0];
  if (profile === undefined) {
    throw new NotionError('PROFILE_NOT_FOUND', 'Profile resolution failed.');
  }
  return profile;
}

function repositoryMatches(repository: string, cwd: string): boolean {
  if (isAbsolute(repository)) {
    const root = resolve(repository);
    const path = relative(root, cwd);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  }
  if (
    repository.includes('/')
    || repository.includes('\\')
    || repository === '.'
    || repository === '..'
  ) {
    return false;
  }
  let current = cwd;
  while (true) {
    if (basename(current) === repository) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
