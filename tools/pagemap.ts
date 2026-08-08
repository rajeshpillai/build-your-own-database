// Print the byte layout of a real page.
//
//   node tools/pagemap.ts            human readable
//   node tools/pagemap.ts --json     the same, as data
//
// This exists so a diagram of a page can be drawn from a page that actually
// exists rather than from someone's memory of the design. The course deck reads
// the JSON form and renders it; a learner can run the same command and get the
// same offsets.

import { HEADER_SIZE, SLOT_SIZE, freeSpace, newPage } from '../src/page.ts';
import { insertSorted, rowCount, usedBytes } from '../src/page.ts';
import { PAGE_SIZE } from '../src/pager.ts';
import { Schema, encodeRow } from '../src/schema.ts';

const USERS = new Schema('users', [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'text' },
  { name: 'email', type: 'text' },
]);

const row = (id: number) => ({
  id,
  name: `user-${id}`,
  email: `user-${id}@example.com`,
});

const fill = Number(process.env.ROWS ?? 0);

const page = newPage();
let id = 1;
while (insertSorted(page, encodeRow(USERS, row(id), { xmin: 1, xmax: 0 })) !== -1) {
  id++;
  if (fill > 0 && rowCount(page) >= fill) break;
}

const rows = rowCount(page);
const slotsEnd = HEADER_SIZE + rows * SLOT_SIZE;
const rowsStart = PAGE_SIZE - usedBytes(page);

const map = {
  pageSize: PAGE_SIZE,
  rows,
  regions: [
    { name: 'header', from: 0, to: HEADER_SIZE,
      note: 'count, free, type, sibling' },
    { name: 'slots', from: HEADER_SIZE, to: slotsEnd,
      note: `${rows} x ${SLOT_SIZE} bytes` },
    { name: 'free', from: slotsEnd, to: rowsStart,
      note: `${freeSpace(page)} bytes free` },
    { name: 'rows', from: rowsStart, to: PAGE_SIZE,
      note: `${usedBytes(page)} bytes of rows` },
  ],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(map, null, 2));
} else {
  console.log(`page size     ${map.pageSize}`);
  console.log(`rows          ${map.rows}`);
  for (const r of map.regions) {
    const width = r.to - r.from;
    const span = `${String(r.from).padStart(5)}..${String(r.to).padStart(5)}`;
    const size = String(width).padStart(5);
    console.log(`${r.name.padEnd(8)} ${span}  ${size} bytes  ${r.note}`);
  }
}
