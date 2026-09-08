import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, Profile } from '../lib/types.js';

export function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

export function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    key: 'gantry',
    label: 'Gantry',
    aliases: ['g'],
    repositories: ['gantry'],
    credentialRef: 'gantry-bot',
    connection: { botId: id(90), workspaceId: id(91) },
    roots: [{ kind: 'page', id: id(1) }],
    protected: [],
    canonical: { home: { kind: 'page', id: id(1) } },
    timezone: 'America/Vancouver',
    todos: null,
    ...overrides,
  };
}

export async function profileHome(
  profiles: Array<{ slug: string; value: Profile }> = [{ slug: 'gantry', value: profile() }],
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'notion-foundation-'));
  const home = join(root, 'notion');
  await mkdir(join(home, 'profiles'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, '.workspaces.json'),
    JSON.stringify({ version: 1, profiles: profiles.map(item => item.slug) }),
    { mode: 0o600 },
  );
  for (const item of profiles) {
    await writeFile(join(home, 'profiles', `${item.slug}.json`), JSON.stringify(item.value), {
      mode: 0o600,
    });
  }
  await writeFile(
    join(home, '.credentials.json'),
    JSON.stringify({
      version: 1,
      connections: {
        'gantry-bot': { token: 'synthetic-gantry-token' },
        'other-bot': { token: 'synthetic-other-token' },
      },
    }),
    { mode: 0o600 },
  );
  async function cleanup(): Promise<void> {
    await rm(root, { recursive: true });
  }
  return {
    home,
    cleanup,
  };
}

export function jsonResponse(body: JsonObject, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function fakeFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return async function fetch(input, init) {
    if (input instanceof Request) return handler(new URL(input.url), init);
    if (input instanceof URL) return handler(input, init);
    return handler(new URL(input), init);
  };
}
