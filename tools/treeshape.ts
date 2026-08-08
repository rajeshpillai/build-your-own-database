// Print the shape of a real B-tree, level by level.
//
//   ROWS=60000 node tools/treeshape.ts           human readable
//   ROWS=60000 node tools/treeshape.ts --json    the same, as data
//
// The course deck draws its tree diagram from the JSON form, so the picture is
// of a tree that was actually built rather than one someone sketched. Build it
// yourself and you get the same shape.

import { rmSync } from 'node:fs';
import { BTree } from '../src/btree.ts';
import { childAtIndex, keyCount } from '../src/inode.ts';
import { isLeaf, rowCount } from '../src/page.ts';
import { Pager } from '../src/pager.ts';
import { Schema, encodeRow } from '../src/schema.ts';

const ROWS = Number(process.env.ROWS ?? 60_000);
const DB = process.env.DB ?? './finch-treeshape.db';

const USERS = new Schema('users', [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'text' },
  { name: 'email', type: 'text' },
]);

rmSync(DB, { force: true });
const pager = new Pager(DB);
const root = BTree.create(pager);
const tree = new BTree(pager, root);

for (let id = 1; id <= ROWS; id++) {
  const row = { id, name: `user-${id}`, email: `user-${id}@example.com` };
  tree.insert(encodeRow(USERS, row, { xmin: 1, xmax: 0 }));
}

// Walk the tree level by level, counting nodes and the entries they hold.
const levels: Array<{ depth: number; kind: string; nodes: number;
                      entries: number }> = [];
let frontier = [root];
let depth = 0;

while (frontier.length > 0) {
  const next: number[] = [];
  let entries = 0;
  let leaf = true;

  for (const no of frontier) {
    const page = pager.readPage(no);
    if (isLeaf(page)) {
      entries += rowCount(page);
    } else {
      leaf = false;
      const keys = keyCount(page);
      entries += keys;
      for (let i = 0; i <= keys; i++) next.push(childAtIndex(page, i));
    }
  }

  levels.push({
    depth,
    kind: leaf ? 'leaf' : 'internal',
    nodes: frontier.length,
    entries,
  });
  frontier = next;
  depth++;
}

const shape = {
  rows: ROWS,
  height: levels.length,
  pagesPerLookup: levels.length,
  pagesPerScan: levels[levels.length - 1]?.nodes ?? 0,
  levels,
};

pager.close();
rmSync(DB, { force: true });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(shape, null, 2));
} else {
  console.log(`rows          ${shape.rows.toLocaleString('en-US')}`);
  console.log(`height        ${shape.height}`);
  for (const l of shape.levels) {
    const nodes = String(l.nodes).padStart(5);
    const entries = String(l.entries).padStart(7);
    console.log(`  depth ${l.depth}  ${l.kind.padEnd(8)} ${nodes} nodes ` +
      `${entries} entries`);
  }
  console.log(`lookup reads  ${shape.pagesPerLookup}`);
  console.log(`scan reads    ${shape.pagesPerScan.toLocaleString('en-US')}`);
}
