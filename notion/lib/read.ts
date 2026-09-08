import type { JsonObject, ResourceRef } from './types.js';
import type { ScopedNotion } from './scope.js';
import { NotionError, safeError } from './errors.js';
import { blockText, isObject, notionId, pageTitle, string } from './values.js';

export type ReadScope = Pick<ScopedNotion, 'read' | 'children' | 'query'>;
export interface InspectionNode {
  ref: ResourceRef;
  parent?: ResourceRef;
  resource: JsonObject;
  depth: number;
  references: ResourceRef[];
}
export interface Inspection {
  status: 'complete' | 'partial';
  nodes: InspectionNode[];
  gaps: { ref: ResourceRef; reason: string; message: string }[];
}
export interface Finding {
  kind: 'duplicate-title' | 'deliverable-under-task' | 'untitled-page';
  ids: string[];
  evidence: string;
  action: string;
  confidence: 'candidate';
}

export async function inspect(
  scope: ReadScope,
  ref: ResourceRef,
  options: { depth?: number; maxNodes?: number } = {},
): Promise<Inspection> {
  const depth = options.depth ?? 1;
  const maxNodes = options.maxNodes ?? 100;
  if (!Number.isInteger(depth) || depth < 0 || depth > 12 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 2000) {
    throw new NotionError('INVALID_OPTIONS', 'Depth must be 0-12 and maxNodes must be 1-2000.');
  }
  const result: Inspection = { status: 'complete', nodes: [], gaps: [] };
  const visited = new Set<string>();
  const root = { ...ref, id: notionId(ref.id) };
  const gap = (target: ResourceRef, reason: string, message: string) => {
    result.status = 'partial';
    result.gaps.push({ ref: target, reason, message });
  };

  async function walk(target: ResourceRef, resource: JsonObject, level: number, parent?: ResourceRef): Promise<void> {
    const key = `${target.kind}:${target.id}`;
    if (visited.has(key)) {
      gap(target, 'cycle', 'This resource was already visited.');
      return;
    }
    if (result.nodes.length >= maxNodes) {
      gap(target, 'node-limit', 'The inspection reached its node budget.');
      return;
    }
    visited.add(key);
    result.nodes.push({ ref: target, ...(parent ? { parent } : {}), resource, depth: level, references: references(resource) });
    const expandable = target.kind !== 'block' || resource.has_children === true;
    if (!expandable) return;
    if (level >= depth) {
      gap(target, 'depth-limit', 'Children were not inspected beyond the requested depth.');
      return;
    }
    try {
      if (target.kind === 'database') {
        const metadata = resource.object === 'database' ? resource : await scope.read(target);
        if (!Array.isArray(metadata.data_sources)) {
          throw new NotionError('MALFORMED_RESPONSE', 'Database response lacks its data sources.');
        }
        for (const value of metadata.data_sources) {
          if (!isObject(value)) throw new NotionError('MALFORMED_RESPONSE', 'Invalid database source reference.');
          const child: ResourceRef = { kind: 'data_source', id: notionId(string(value.id)) };
          if (result.nodes.length >= maxNodes) {
            gap(child, 'node-limit', 'Additional data sources remain outside the node budget.');
            break;
          }
          await walk(child, await scope.read(child), level + 1, target);
        }
        return;
      }
      const children = target.kind === 'data_source' ? await scope.query(target.id) : await scope.children(target.id);
      for (const child of children) {
        const childRef: ResourceRef = { kind: childKind(child), id: notionId(string(child.id)) };
        if (result.nodes.length >= maxNodes) {
          gap(childRef, 'node-limit', 'Additional children remain outside the node budget.');
          break;
        }
        await walk(childRef, child, level + 1, target);
      }
    } catch (error) {
      const safe = safeError(error);
      gap(target, 'read-error', `${safe.code}: ${safe.message}`);
    }
  }

  await walk(root, await scope.read(root), 0);
  return result;
}

export function gardenFindings(inspection: Inspection): Finding[] {
  const findings: Finding[] = [];
  const nodes = new Map(inspection.nodes.map(node => [`${node.ref.kind}:${node.ref.id}`, node]));
  const siblingTitles = new Map<string, InspectionNode[]>();
  for (const node of inspection.nodes) {
    if (node.ref.kind !== 'page' && node.ref.kind !== 'database' && node.ref.kind !== 'data_source') continue;
    const title = nodeTitle(node).trim();
    if (!title) {
      findings.push({ kind: 'untitled-page', ids: [node.ref.id], evidence: 'The returned page title is empty.', action: 'Inspect its purpose before assigning a descriptive title.', confidence: 'candidate' });
    }
    if (!node.parent) continue;
    const parentKey = `${node.parent.kind}:${node.parent.id}`;
    const parent = nodes.get(parentKey);
    if (parent?.resource.type === 'to_do') {
      const completed = isObject(parent.resource.to_do) && parent.resource.to_do.checked === true;
      findings.push({
        kind: 'deliverable-under-task', ids: [parent.ref.id, node.ref.id],
        evidence: `The document "${title}" is nested beneath ${completed ? 'a completed' : 'a pending'} task.`,
        action: 'Review whether the document needs a canonical home; preserve the task and link.',
        confidence: 'candidate',
      });
    }
    if (title) {
      const key = `${parentKey}:${title.toLowerCase().replace(/\s+/g, ' ')}`;
      siblingTitles.set(key, [...(siblingTitles.get(key) ?? []), node]);
    }
  }
  for (const siblings of siblingTitles.values()) {
    if (siblings.length < 2) continue;
    findings.push({
      kind: 'duplicate-title', ids: siblings.map(node => node.ref.id),
      evidence: `${siblings.length} sibling pages share the title "${nodeTitle(siblings[0]!)}".`,
      action: 'Compare purpose and content before deciding whether anything is duplicated.',
      confidence: 'candidate',
    });
  }
  return findings;
}

export function nodeTitle(node: InspectionNode): string {
  return node.resource.object === 'block' ? blockText(node.resource) : pageTitle(node.resource);
}

function childKind(child: JsonObject): ResourceRef['kind'] {
  if (child.object === 'page' || child.type === 'child_page') return 'page';
  if (child.type === 'child_database') return 'database';
  return 'block';
}

function references(resource: JsonObject): ResourceRef[] {
  const found = new Map<string, ResourceRef>();
  const add = (kind: ResourceRef['kind'], id: string) => {
    const ref = { kind, id: notionId(id) };
    found.set(`${ref.kind}:${ref.id}`, ref);
  };
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    const mention = value.mention;
    if (isObject(mention) && mention.type === 'page' && isObject(mention.page) && typeof mention.page.id === 'string') {
      add('page', mention.page.id);
    }
    const link = value.link_to_page;
    if (isObject(link)) {
      if (typeof link.page_id === 'string') add('page', link.page_id);
      if (typeof link.database_id === 'string') add('database', link.database_id);
    }
    for (const entry of Object.values(value)) visit(entry);
  }
  visit(resource);
  return [...found.values()];
}
