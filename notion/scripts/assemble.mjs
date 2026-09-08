#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { defaultHome } from '../dist/lib/config.js';
import { safeError } from '../dist/lib/errors.js';
import { assemblePlugin } from '../dist/lib/package.js';

try {
  const { values } = parseArgs({
    options: { home: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.help) {
    console.log('node scripts/assemble.mjs [--home PATH]\nAssemble an isolated runtime release. Does not register a plugin or copy credentials.');
  } else {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const result = await assemblePlugin(source, values.home ?? defaultHome());
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: safeError(error) }));
  process.exitCode = 1;
}
