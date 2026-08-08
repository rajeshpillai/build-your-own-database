// Step 3. What the cache is worth, and where it stops working.
//
//   node main.ts             the two workloads, measured
//   node tools/curve.ts      the growth comparison from the last step
//
// No build, no install. Node strips the types and runs the file.

import { rmSync } from 'node:fs';
import type { JsonRow } from './src/jsonstore.ts';
import { DEFAULT_CAPACITY, PAGE_SIZE, Pager } from './src/pager.ts';

const DB = process.env.DB ?? './finch-step-03.pages';
const PAGES = 500;

const row = (id: number): JsonRow => ({
  id,
  name: `user-${id}`,
  email: `user-${id}@example.com`,
});

const n = (x: number) => x.toLocaleString('en-US');

function putRow(page: Buffer, r: JsonRow): void {
  const text = Buffer.from(JSON.stringify(r), 'utf8');
  page.writeUInt16LE(text.length, 0);
  text.copy(page, 2);
}

// A file of 500 pages, one row on each. Written fresh every time, so the two
// workloads below start from exactly the same disk.
function build(): void {
  rmSync(DB, { force: true });
  const pager = new Pager(DB);
  for (let id = 1; id <= PAGES; id++) {
    const page = Buffer.alloc(PAGE_SIZE);
    putRow(page, row(id));
    pager.writePage(pager.allocate(), page);
  }
  pager.close();
}

// The workload a cache is for. A tree lookup reads the root, then one node per
// level, and the root is the same page every single time. Sixty four pages of
// memory answer a thousand of these with three visits to the disk.
function hot(): void {
  const pager = new Pager(DB);
  for (let i = 0; i < 1000; i++) pager.readPage(i % 3);

  console.log(`hot pages, reads      ${n(1000)}`);
  console.log(`hot pages, hits       ${n(pager.hits)}`);
  console.log(`hot pages, disk       ${n(pager.misses)}`);
  console.log(`hot pages, bytes      ${n(pager.bytesRead)}`);
  pager.close();
}

// And the workload it is wrong for.
//
// A scan touches every page once, in order, and then starts again. By the time
// it comes back to page 0 the cache holds the last sixty four pages it saw, and
// page 0 was evicted four hundred pages ago. Every read is a miss, on every
// pass. The cache is not slightly less useful here — it is doing no work at all,
// and still paying for the bookkeeping.
//
// This is why a real database detects a sequential scan and stops it filling the
// cache. Nothing in this course fixes it. It is worth knowing the fix exists.
function scanned(): void {
  const pager = new Pager(DB);
  for (let pass = 0; pass < 2; pass++) {
    for (let p = 0; p < PAGES; p++) pager.readPage(p);
  }

  console.log(`scan, reads           ${n(2 * PAGES)}`);
  console.log(`scan, hits            ${n(pager.hits)}`);
  console.log(`scan, disk            ${n(pager.misses)}`);
  console.log(`scan, evictions       ${n(pager.evictions)}`);
  pager.close();
}

build();
console.log(`pages on disk         ${n(PAGES)}`);
console.log(`cache capacity        ${n(DEFAULT_CAPACITY)}`);
console.log();
hot();
console.log();
scanned();
rmSync(DB, { force: true });
