import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Codex's bundled Node runtime places libraries next to bin/node.exe.
    const bundled = path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'playwright');
    try { return createRequire(pathToFileURL(path.join(bundled, 'package.json')))(bundled); }
    catch { throw new Error('Playwright is missing. Install package.json dependencies with npm install.'); }
  }
}
