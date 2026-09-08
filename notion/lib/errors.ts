import type { JsonObject, JsonValue } from './types.js';

export class NotionError extends Error {
  readonly code: string;
  readonly details?: JsonObject;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = 'NotionError';
    this.code = code;
    this.details = details;
  }
}

export function isResourceLookupMiss(error: unknown): boolean {
  return error instanceof NotionError
    && (error.code === 'NOT_FOUND' || error.code === 'WRONG_RESOURCE_KIND');
}

export function safeError(
  error: unknown,
  secrets: string[] = [],
): { code: string; message: string; details?: JsonObject } {
  const redact = redactor(secrets);
  if (error instanceof NotionError) {
    const details =
      error.details === undefined
        ? undefined
        : redactObject(error.details, redact, new Set(), 0);
    return {
      code: error.code,
      message: redact(error.message),
      ...(details === undefined ? {} : { details }),
    };
  }
  return { code: 'UNKNOWN', message: 'Unexpected error.' };
}

export function redactJson(value: JsonValue, secrets: string[] = []): JsonValue {
  return redactValue(value, redactor(secrets), new Set(), 0);
}

function redactor(secrets: string[]): (value: string) => string {
  const exact = [...new Set(secrets.filter(secret => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  return function redact(value: string): string {
    let result = value.replace(
      /\b(?:secret_|ntn_|notion_)[A-Za-z0-9_-]{16,}\b/g,
      '[REDACTED]',
    );
    for (const secret of exact) result = result.split(secret).join('[REDACTED]');
    return result;
  };
}

function redactObject(
  value: JsonObject,
  redact: (value: string) => string,
  seen: Set<object>,
  depth: number,
): JsonObject {
  if (seen.has(value) || depth > 40) return { redacted: '[REDACTED]' };
  seen.add(value);
  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redact(key),
      redactValue(entry, redact, seen, depth + 1),
    ]),
  );
  seen.delete(value);
  return result;
}

function redactValue(
  value: JsonValue,
  redact: (value: string) => string,
  seen: Set<object>,
  depth: number,
): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    if (seen.has(value) || depth > 40) return '[REDACTED]';
    seen.add(value);
    const result = Array.from(
      { length: value.length },
      (_, index) => redactValue(value[index] ?? null, redact, seen, depth + 1),
    );
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    return redactObject(value, redact, seen, depth);
  }
  return value;
}
