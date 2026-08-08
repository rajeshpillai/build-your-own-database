// finch against SQLite, on the same machine, doing the same work.
//
//   node tools/bench.ts
//   ROWS=20000 node tools/bench.ts
//
// SQLite ships inside Node, so this needs nothing installed. It is here because
// the last section of the course is an honest table, and an honest table needs
// somebody else's numbers beside our own.
//
// TIMINGS MOVE BETWEEN RUNS. Nothing in this file is safe to say out loud in
// narration — the figures belong on screen, from the run the viewer is watching.
// The counts that go with them (rows examined, pages read) are computation and
// do not move, which is why both are printed.

import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { Database } from '../src/db.ts';
import { Executor } from '../src/execute.ts';

const ROWS = Number(process.env.ROWS ?? 20_000);
const FINCH = process.env.DB ?? './bench-finch.db';
const SQLITE = './bench-sqlite.db';

const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const n = (x: number) => x.toLocaleString('en-US');
const row = (id: number) => ({ id, name: `user-${id}`, age: 20 + (id % 40) });

function line(label: string, finch: string, sqlite: string): void {
  console.log(`${label.padEnd(20)} ${finch.padStart(12)} ${sqlite.padStart(12)}`);
}

// ── finch ───────────────────────────────────────────────────────────────────

Database.remove(FINCH);
const db = new Database(FINCH);
const sql = new Executor(db);

let start = process.hrtime.bigint();
db.transaction(() => {
  db.createTable('users', [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'text' },
    { name: 'age', type: 'int' },
  ]);
  for (let id = 1; id <= ROWS; id++) db.insert('users', row(id));
});
const finchInsert = ms(start);

start = process.hrtime.bigint();
for (let i = 0; i < 1000; i++) db.get('users', 1 + ((i * 37) % ROWS));
const finchLookup = ms(start);

start = process.hrtime.bigint();
const finchScan = sql.run("SELECT * FROM users WHERE name = 'user-1'");
const finchScanMs = ms(start);

const finchPages = db.pager.pageCount;
db.checkpoint();
db.close();

// ── sqlite ──────────────────────────────────────────────────────────────────

rmSync(SQLITE, { force: true });
const lite = new DatabaseSync(SQLITE);
lite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');

start = process.hrtime.bigint();
lite.exec('BEGIN');
const insert = lite.prepare('INSERT INTO users VALUES (?, ?, ?)');
for (let id = 1; id <= ROWS; id++) {
  const r = row(id);
  insert.run(r.id, r.name, r.age);
}
lite.exec('COMMIT');
const liteInsert = ms(start);

start = process.hrtime.bigint();
const byKey = lite.prepare('SELECT * FROM users WHERE id = ?');
for (let i = 0; i < 1000; i++) byKey.get(1 + ((i * 37) % ROWS));
const liteLookup = ms(start);

start = process.hrtime.bigint();
lite.prepare('SELECT * FROM users WHERE name = ?').all('user-1');
const liteScanMs = ms(start);

const litePages = Number(
  (lite.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
);
lite.close();
rmSync(SQLITE, { force: true });
rmSync(`${SQLITE}-journal`, { force: true });

// ── the table ───────────────────────────────────────────────────────────────

console.log(`rows ${n(ROWS)}, one run on this machine\n`);
line('', 'finch', 'sqlite');
line('insert all (ms)', finchInsert.toFixed(0), liteInsert.toFixed(0));
line('1000 lookups (ms)', finchLookup.toFixed(0), liteLookup.toFixed(0));
line('scan by name (ms)', finchScanMs.toFixed(0), liteScanMs.toFixed(0));
line('pages on disk', n(finchPages), n(litePages));

console.log('\ncounts, which do not move between runs');
line('rows examined', n(finchScan.examined), n(ROWS));
line('rows returned', n(finchScan.rows.length), '1');
