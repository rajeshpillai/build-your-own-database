// Step 1. What a JSON file costs.
//
//   node main.ts          store 500 rows and print the bill
//   node main.ts crash    kill it half way through a write
//
// No build, no install. Node strips the types and runs the file.

import { rmSync } from 'node:fs';
import { JsonStore, saveAndCrash } from './src/jsonstore.ts';
import type { JsonRow } from './src/jsonstore.ts';

const DB = process.env.DB ?? './finch-step-01.json';

const row = (id: number): JsonRow => ({
  id,
  name: `user-${id}`,
  email: `user-${id}@example.com`,
});

const n = (x: number) => x.toLocaleString('en-US');

// Five hundred rows, the same five hundred on every machine. Every number below
// is computed from them, so it does not move between runs and it does not move
// between your machine and mine.
function demo(): void {
  rmSync(DB, { force: true });
  const store = new JsonStore(DB);

  const rows: JsonRow[] = [];
  for (let id = 1; id <= 500; id++) {
    rows.push(row(id));
    store.insert(row(id));
  }

  const onDisk = Buffer.byteLength(JSON.stringify(rows));
  store.find(500);

  console.log(`rows stored          ${n(500)}`);
  console.log(`bytes on disk        ${n(onDisk)}`);
  console.log(`bytes written        ${n(store.bytesWritten)}`);
  console.log(`amplification        ${(store.bytesWritten / onDisk).toFixed(1)}x`);
  console.log(`rows examined        ${n(store.rowsExamined)} of 500`);
  rmSync(DB, { force: true });
}

// The third cost, run for real. This ends the process, so it is its own command.
function crash(): never {
  const rows = Array.from({ length: 500 }, (_, i) => row(i + 1));
  saveAndCrash(DB, rows);
}

const command = process.argv[2] ?? 'demo';
if (command === 'demo') demo();
else if (command === 'crash') crash();
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
