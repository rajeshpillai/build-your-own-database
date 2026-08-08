// Step 2. What a file of pages costs, beside what step 1 cost.
//
//   node main.ts             store 500 rows both ways and compare
//   node tools/curve.ts      the same comparison at three table sizes
//
// No build, no install. Node strips the types and runs the file.

import { rmSync } from 'node:fs';
import { JsonStore } from './src/jsonstore.ts';
import type { JsonRow } from './src/jsonstore.ts';
import { PAGE_SIZE, Pager } from './src/pager.ts';

const DB = process.env.DB ?? './finch-step-02.json';
const PAGED = `${DB}.pages`;
const ROWS = 500;

const row = (id: number): JsonRow => ({
  id,
  name: `user-${id}`,
  email: `user-${id}@example.com`,
});

const n = (x: number) => x.toLocaleString('en-US');

// A row still goes onto the page as JSON text. That is deliberate — this step is
// about addressing, not about encoding, and step 4 is the one that makes a row
// into bytes. The two-byte length in front is the only new idea: without it we
// could not tell where the text ends, because the rest of the page is zeroes.
function putRow(page: Buffer, r: JsonRow): number {
  const text = Buffer.from(JSON.stringify(r), 'utf8');
  page.writeUInt16LE(text.length, 0);
  text.copy(page, 2);
  return text.length;
}

function getRow(page: Buffer): JsonRow {
  const length = page.readUInt16LE(0);
  return JSON.parse(page.toString('utf8', 2, 2 + length)) as JsonRow;
}

// Store the same 500 rows both ways and print what each cost. One row per page
// is a deliberately bad use of a page, and the occupancy figure says so — the
// slotted page in section 2 is what fixes it.
function demo(): void {
  rmSync(DB, { force: true });
  rmSync(PAGED, { force: true });

  const store = new JsonStore(DB);
  for (let id = 1; id <= ROWS; id++) store.insert(row(id));

  const pager = new Pager(PAGED);
  let rowBytes = 0;
  for (let id = 1; id <= ROWS; id++) {
    const page = Buffer.alloc(PAGE_SIZE);
    rowBytes = putRow(page, row(id));
    pager.writePage(pager.allocate(), page);
  }

  // The lookup that step 1 could only answer by reading everything.
  const wanted = 400;
  const before = pager.bytesRead;
  const found = getRow(pager.readPage(wanted - 1));
  const readForOne = pager.bytesRead - before;

  console.log(`rows stored          ${n(ROWS)}`);
  console.log(`json bytes written   ${n(store.bytesWritten)}`);
  console.log(`page bytes written   ${n(pager.bytesWritten)}`);
  const ratio = store.bytesWritten / pager.bytesWritten;
  console.log(`ratio                ${ratio.toFixed(1)}x`);
  console.log(`pages on disk        ${n(pager.pageCount)}`);
  console.log(`bytes used per page  ${n(rowBytes + 2)}`);
  const used = rowBytes + 2;
  console.log(`occupancy            ${(used / PAGE_SIZE * 100).toFixed(1)}%`);
  console.log(`row 400 found        ${found.name}`);
  console.log(`bytes read for it    ${n(readForOne)}`);

  pager.close();
  rmSync(DB, { force: true });
  rmSync(PAGED, { force: true });
}

demo();
