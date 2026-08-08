// How the two costs GROW, which is the argument the single ratio does not make.
//
//   node tools/curve.ts
//
// At a hundred rows the pages are WORSE, because most of every page is empty.
// The crossover is the interesting part, and it is why section 2 exists.

import { rmSync } from 'node:fs';
import { JsonStore } from '../src/jsonstore.ts';
import type { JsonRow } from '../src/jsonstore.ts';
import { PAGE_SIZE, Pager } from '../src/pager.ts';

const DB = process.env.DB ?? './finch-curve.json';
const PAGED = `${DB}.pages`;

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

// The ratio at one table size is not the argument, and quoting it alone invites
// the obvious reply: three and a half times is not worth a rewrite. The argument
// is the SHAPE. One of these grows with the square of the rows stored and the
// other grows with the rows, and three sizes on screen show that.
function curve(): void {
  console.log('rows      json bytes    page bytes   ratio');
  for (const size of [100, 200, 500]) {
    rmSync(DB, { force: true });
    rmSync(PAGED, { force: true });

    const store = new JsonStore(DB);
    const pager = new Pager(PAGED);
    for (let id = 1; id <= size; id++) {
      store.insert(row(id));
      const page = Buffer.alloc(PAGE_SIZE);
      putRow(page, row(id));
      pager.writePage(pager.allocate(), page);
    }

    const ratio = store.bytesWritten / pager.bytesWritten;
    console.log(
      `${String(size).padStart(4)}  ${n(store.bytesWritten).padStart(12)}  ` +
        `${n(pager.bytesWritten).padStart(11)}  ${ratio.toFixed(1)}x`,
    );
    pager.close();
  }
  rmSync(DB, { force: true });
  rmSync(PAGED, { force: true });
}

curve();
