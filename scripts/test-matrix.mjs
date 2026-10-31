// Compares tracker settings on the same footage and prints a table.
//   node scripts/test-matrix.mjs <experience-id>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'ceat-tyre';
const runs = [
  ['540 a', 'input=540'],
  ['540 b', 'input=540'],
  ['540 raw', 'input=540&rawpose'],
  ['480 a', 'input=480'],
  ['480 b', 'input=480'],
  ['480 raw', 'input=480&rawpose'],
  ['368 a', 'input=368'],
  ['368 b', 'input=368'],
  ['368 raw', 'input=368&rawpose'],
];

const rows = [];
for (const [name, query] of runs) {
  const label = name.replaceAll(' ', '_');
  execFileSync('node', [join(root, 'scripts/test-tracking.mjs'), id, '--query', query, '--label', label], { cwd: root, stdio: 'ignore', timeout: 180000 });
  const r = JSON.parse(readFileSync(join(root, '.test-output', `report-${label}-${id}.json`), 'utf8'));
  const row = {
    run: name,
    'jitter px': r.jitter.spreadRmsPx,
    'still px': r.stillAccuracy.medianPx,
    'slow px': r.slowMotion.medianPx,
    'slow p95': r.slowMotion.p95Px,
    'fast px': r.fastMotion.medianPx,
    'fast p95': r.fastMotion.p95Px,
    'fast n': r.fastMotion.n,
    'ms/frame': r.stats.trackMs,
    'false poses': r.posesWhilePosterGone,
    errors: r.errors.length,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.table(rows);
