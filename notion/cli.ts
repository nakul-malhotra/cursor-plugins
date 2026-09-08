import { parseArgs } from 'node:util';
import { NotionClient } from './lib/client.js';
import { defaultHome, loadProfiles, readCredential, readPrivateJson, resolveProfile } from './lib/config.js';
import { NotionError, redactJson, safeError } from './lib/errors.js';
import { createPlan, applyPlan, readPlan, readJournal } from './lib/engine.js';
import { parseOperations } from './lib/operations.js';
import { gardenFindings, inspect, nodeTitle } from './lib/read.js';
import { ScopedNotion } from './lib/scope.js';
import { listTodos, parseTodoRequest, planTodos } from './lib/todos.js';
import type { ResourceRef } from './lib/types.js';
import { object, notionId } from './lib/values.js';

export interface CliIO {
  home?: string;
  cwd?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const out = io.out ?? ((text: string) => { process.stdout.write(text); });
  const err = io.err ?? ((text: string) => { process.stderr.write(text); });
  const secrets: string[] = [];
  function emit(value: unknown, failed = false): void {
    const envelope = object(JSON.parse(JSON.stringify(value)));
    const text = `${JSON.stringify(redactJson(envelope, secrets), null, 2)}\n`;
    (failed ? err : out)(text);
  }
  try {
    const { values, positionals } = parseArguments(args);
    const command = positionals[0] ?? 'help';
    if (values.help || command === 'help') {
      out(HELP);
      return 0;
    }
    const flags: Record<string, string | boolean | undefined> = values;
    const option = (name: string): string | undefined => {
      const value = flags[name];
      return typeof value === 'string' ? value : undefined;
    };
    const required = (name: string): string => {
      const value = option(name);
      if (!value?.trim()) throw new NotionError('USAGE', `--${name} is required.`);
      return value;
    };
    const leaf = command === 'todos' ? `${command}:${positionals[1] ?? ''}` : command;
    const allowed = COMMAND_FLAGS[leaf];
    if (!allowed) throw new NotionError('USAGE', `Unknown command "${positionals.join(' ')}". Run --help.`);
    for (const name of Object.keys(values)) {
      if (!['workspace', 'home', 'help', ...allowed].includes(name)) {
        throw new NotionError('USAGE', `--${name} is not supported by ${leaf}.`);
      }
    }
    const expectedPositionals = command === 'todos' || ['apply', 'show-plan', 'journal'].includes(command) ? 2 : 1;
    if (positionals.length !== expectedPositionals) throw new NotionError('USAGE', `Unexpected arguments for ${leaf}. Run --help.`);
    const home = option('home') ?? io.home ?? defaultHome();
    const selector = option('workspace');
    async function context(workspace = selector): Promise<ScopedNotion> {
      const profile = await resolveProfile(home, workspace, io.cwd);
      const token = await readCredential(home, profile.credentialRef);
      secrets.push(token);
      return new ScopedNotion(profile, new NotionClient(token, {
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
      }));
    }
    if (command === 'workspaces') {
      const profiles = await loadProfiles(home);
      emit({ ok: true, workspaces: profiles.map(profile => ({ key: profile.key, label: profile.label, aliases: profile.aliases, repositories: profile.repositories })) });
      return 0;
    }
    if (command === 'profile') {
      emit({ ok: true, profile: await resolveProfile(home, selector, io.cwd) });
      return 0;
    }
    if (command === 'show-plan' || command === 'journal') {
      const profile = await resolveProfile(home, selector, io.cwd);
      const id = positionals[1]!;
      const plan = await readPlan(home, id);
      if (plan.workspace !== profile.key) throw new NotionError('OUT_OF_SCOPE', 'The plan belongs to another profile.');
      if (command === 'journal') {
        emit({ ok: true, journal: await readJournal(home, id) });
      } else {
        emit({ ok: true, plan });
      }
      return 0;
    }
    if (command === 'doctor' || command === 'garden') {
      if (values.all && selector) throw new NotionError('USAGE', 'Choose --all or --workspace, not both.');
      if (values.all && option('id')) throw new NotionError('USAGE', '--all uses registered roots; do not also provide --id.');
      const profiles = values.all ? await loadProfiles(home) : [await resolveProfile(home, selector, io.cwd)];
      const reports: unknown[] = [];
      let failed = false;
      for (const profile of profiles) {
        try {
          const scope = await context(profile.key);
          const roots = option('id') ? [reference(required('id'), option('kind'))] : profile.roots;
          if (command === 'doctor') {
            await scope.verifyConnection();
            for (const root of roots) await scope.read(root);
            reports.push({ workspace: profile.key, status: 'ready', roots: profile.roots, todos: profile.todos?.kind ?? null });
          } else {
            for (const root of roots) {
              const result = await inspect(scope, root, { depth: Number(option('depth') ?? '2'), maxNodes: Number(option('max-nodes') ?? '100') });
              const readFailed = result.gaps.some(gap => gap.reason === 'read-error');
              failed ||= readFailed;
              reports.push({
                workspace: profile.key, root, status: result.status, gaps: result.gaps,
                nodes: result.nodes.map(node => ({ ref: node.ref, parent: node.parent, depth: node.depth, title: nodeTitle(node), references: node.references })),
                findings: gardenFindings(result),
              });
            }
          }
        } catch (error) {
          failed = true;
          reports.push({ workspace: profile.key, status: 'failed', error: safeError(error, secrets) });
        }
      }
      emit({ ok: !failed, reports });
      return failed ? 1 : 0;
    }
    const scope = await context();
    if (command === 'inspect') {
      const inspection = await inspect(scope, reference(required('id'), option('kind')), { depth: Number(option('depth') ?? '1'), maxNodes: Number(option('max-nodes') ?? '100') });
      const failed = inspection.gaps.some(gap => gap.reason === 'read-error');
      emit({ ok: !failed, inspection });
      return failed ? 1 : 0;
    } else if (command === 'search') {
      emit({ ok: true, resources: await scope.search(required('query')) });
    } else if (command === 'query') {
      const body = option('file') ? object(await readPrivateJson(required('file')), 'query') : {};
      emit({ ok: true, rows: await scope.query(notionId(required('id')), body) });
    } else if (command === 'comments') {
      const target = reference(required('id'), option('kind'));
      emit({ ok: true, comments: await scope.comments(target) });
    } else if (command === 'todos' && positionals[1] === 'list') {
      emit({ ok: true, todos: await listTodos(scope, {
        ...(option('owner') ? { owner: option('owner') } : {}),
        ...(option('container') ? { container: option('container') } : {}),
        ...(option('section') ? { section: option('section') } : {}),
        ...(option('date') ? { date: option('date') } : {}),
      }) });
    } else if (command === 'plan' || command === 'todos') {
      const request = await readPrivateJson(required('file'));
      const operations = command === 'todos' ? await planTodos(scope, parseTodoRequest(request)) : parseOperations(request);
      if (operations.length === 0) {
        emit({ ok: true, status: 'no-op', message: 'The requested todo content is already present.' });
        return 0;
      }
      const plan = await createPlan(scope, home, operations, {
        ...(option('summary') ? { summary: option('summary') } : {}),
        ...(option('request-key') ? { requestKey: option('request-key') } : {}),
      });
      emit({ ok: true, plan });
    } else if (command === 'apply') {
      const journal = await applyPlan(scope, home, positionals[1]!, { approveDestructive: values['approve-destructive'] === true });
      const ok = journal.status === 'applied';
      emit({ ok, journal });
      return ok ? 0 : 1;
    }
    return 0;
  } catch (error) {
    const safe = safeError(error, secrets);
    emit({ ok: false, error: safe }, true);
    return safe.code === 'USAGE' ? 2 : 1;
  }
}

function parseArguments(args: string[]) {
  try {
    return parseArgs({
      args, allowPositionals: true, strict: true,
      options: {
        help: { type: 'boolean', short: 'h' }, workspace: { type: 'string' }, home: { type: 'string' },
        file: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' },
        owner: { type: 'string' }, container: { type: 'string' }, section: { type: 'string' },
        date: { type: 'string' }, query: { type: 'string' }, summary: { type: 'string' },
        'request-key': { type: 'string' }, depth: { type: 'string' }, 'max-nodes': { type: 'string' },
        all: { type: 'boolean' }, 'approve-destructive': { type: 'boolean' },
      },
    });
  } catch {
    throw new NotionError('USAGE', 'Invalid command options. Run --help.');
  }
}

function reference(id: string, kind = 'page'): ResourceRef {
  switch (kind) {
    case 'page':
    case 'block':
    case 'database':
    case 'data_source':
      return { kind, id: notionId(id) };
    default:
      throw new NotionError('USAGE', 'Kind must be page, block, database, or data_source.');
  }
}

const COMMAND_FLAGS: Record<string, string[]> = {
  workspaces: [], profile: [], doctor: ['all'], inspect: ['id', 'kind', 'depth', 'max-nodes'],
  garden: ['all', 'id', 'kind', 'depth', 'max-nodes'], search: ['query'], query: ['id', 'file'],
  comments: ['id', 'kind'], 'todos:list': ['owner', 'container', 'section', 'date'],
  'todos:plan': ['file', 'summary', 'request-key'], plan: ['file', 'summary', 'request-key'],
  apply: ['approve-destructive'], 'show-plan': [], journal: [],
};

const HELP = `Notion workspace tools

  workspaces                         List configured scopes without reading tokens
  profile --workspace NAME           Read one workspace profile
  doctor --workspace NAME | --all     Verify connection identity and configured roots
  inspect --workspace NAME --id ID [--kind page|block|database|data_source] [--depth 1]
  garden --workspace NAME [--id ID] [--depth 2] [--max-nodes 100]
  garden --all                       Read-only review of registered roots
  search --workspace NAME --query TEXT
  query --workspace NAME --id SOURCE [--file query.json]
  comments --workspace NAME --id ID [--kind page|block]
  todos list --workspace NAME [--owner OWNER] [--date DATE] [--section SECTION]
  todos plan --workspace NAME --file request.json
  plan --workspace NAME --file operations.json [--request-key KEY]
  show-plan ID --workspace NAME
  apply ID --workspace NAME [--approve-destructive]
  journal ID --workspace NAME

Request JSON files must be owned by you and private (chmod 600).
Plans and journals stay in NOTION_HOME/.state. Default home: ~/.copilot/notion.
All commands emit JSON except help. Review/advice commands never apply a plan.
`;
