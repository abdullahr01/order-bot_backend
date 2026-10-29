import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', 'logs', '.temp']);

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.(?:js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

const files = filesIn(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) console.log(`Syntax checks passed for ${files.length} JavaScript files.`);
