// finch, from the outside.
//
//   node main.ts                 a shell. type sequel at it
//   node main.ts demo            a scripted tour, so you can see it work
//   node main.ts costs           what step 1's JSON file costs, measured
//
// The database is a file. Delete it and you have a new one.

import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { Database } from './src/db.ts';
import { Executor, type Result } from './src/execute.ts';
import { JsonStore, saveAndCrash } from './src/jsonstore.ts';
import type { Row } from './src/schema.ts';

const DB = process.env.DB ?? './finch.db';
const n = (x: number) => x.toLocaleString('en-US');

// ── printing ────────────────────────────────────────────────────────────────

function show(result: Result): void {
  if (result.plan && !result.rows.length && !result.message) {
    for (const line of result.plan) console.log(`  ${line}`);
    return;
  }
  if (result.message) {
    console.log(`  ${result.message}`);
    return;
  }
  if (!result.rows.length) {
    console.log(`  no rows  (${n(result.examined)} examined)`);
    return;
  }

  const columns = Object.keys(result.rows[0]!);
  const width = (name: string) =>
    Math.max(name.length, ...result.rows.map((r) => String(r[name] ?? '').length));
  const widths = columns.map(width);

  const line = (cells: string[]) =>
    `  ${cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')}`;

  console.log(line(columns));
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of result.rows) {
    console.log(line(columns.map((c) => String(row[c] ?? ''))));
  }
  const rows = result.rows.length === 1 ? 'row' : 'rows';
  console.log(`  ${n(result.rows.length)} ${rows}, ${n(result.examined)} examined`);
}

// ── the shell ───────────────────────────────────────────────────────────────

function shell(): void {
  const db = new Database(DB);
  const sql = new Executor(db);

  console.log(`finch — ${DB}`);
  console.log('type a statement, or .tables, .schema, .checkpoint, .exit\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('finch> ');
  rl.prompt();

  rl.on('line', (text) => {
    const line = text.trim();
    try {
      if (line === '.exit' || line === '.quit') return rl.close();
      if (line === '') return rl.prompt();
      if (line === '.tables') {
        console.log(`  ${db.tableNames().join('  ') || '(none)'}`);
      } else if (line === '.checkpoint') {
        console.log(`  ${n(db.checkpoint())} pages written to the database file`);
      } else if (line === '.schema') {
        for (const name of db.tableNames()) {
          const columns = db.table(name).schema.columns;
          const shape = columns.map((c) => `${c.name} ${c.type}`).join(', ');
          console.log(`  ${name} (${shape})`);
        }
      } else if (writes(line)) {
        // Every write runs in its own transaction, which is what a shell with
        // no BEGIN has to do. Nothing is durable until the commit inside here.
        db.transaction(() => show(sql.run(line)));
      } else {
        show(sql.run(line));
      }
    } catch (error) {
      console.log(`  ${(error as Error).message}`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    db.close();
    console.log('bye');
  });
}

function writes(line: string): boolean {
  const first = line.split(/\s+/)[0]?.toLowerCase() ?? '';
  return ['insert', 'update', 'delete', 'create'].includes(first);
}

// ── the tour ────────────────────────────────────────────────────────────────

function demo(): void {
  const path = './finch-demo.db';
  Database.remove(path);
  const db = new Database(path);
  const sql = new Executor(db);

  const run = (statement: string) => {
    console.log(`\nfinch> ${statement}`);
    if (writes(statement)) db.transaction(() => show(sql.run(statement)));
    else show(sql.run(statement));
  };

  run('CREATE TABLE users (id int, name text, age int)');
  db.transaction(() => {
    for (let id = 1; id <= 5000; id++) {
      db.insert('users', { id, name: `user-${id}`, age: 20 + (id % 40) });
    }
  });
  console.log('\n  5,000 rows inserted');

  run('SELECT * FROM users WHERE id = 4242');
  run("SELECT * FROM users WHERE name = 'user-4242'");
  run('EXPLAIN SELECT * FROM users WHERE age = 25');
  run('CREATE INDEX ON users (age)');
  run('EXPLAIN SELECT * FROM users WHERE age = 25');
  run('SELECT id, name FROM users WHERE age = 25 LIMIT 3');
  run('SELECT * FROM users WHERE id >= 10 AND id <= 13');
  run("UPDATE users SET name = 'ada' WHERE id = 1");
  run('SELECT * FROM users WHERE id = 1');

  console.log(`\n  pages in the log      ${n(db.wal.frameCount)}`);
  console.log(`  pages in the file     ${n(db.pager.filePages)}`);
  console.log(`  checkpoint moved      ${n(db.checkpoint())}`);
  console.log(`  pages in the file     ${n(db.pager.filePages)}`);

  db.close();
  Database.remove(path);
}

// ── where the course starts ─────────────────────────────────────────────────

function costs(): void {
  const path = './finch-costs.json';
  rmSync(path, { force: true });

  const store = new JsonStore(path);
  const rows: Array<{ id: number; name: string; email: string }> = [];
  for (let id = 1; id <= 500; id++) {
    const row = { id, name: `user-${id}`, email: `user-${id}@example.com` };
    rows.push(row);
    store.insert(row);
  }

  const onDisk = Buffer.byteLength(JSON.stringify(rows));
  store.find(500);

  console.log(`rows stored          ${n(500)}`);
  console.log(`bytes on disk        ${n(onDisk)}`);
  console.log(`bytes written        ${n(store.bytesWritten)}`);
  console.log(`amplification        ${(store.bytesWritten / onDisk).toFixed(1)}x`);
  console.log(`rows examined        ${n(store.rowsExamined)} of 500`);

  // The crash runs in a child, because saveAndCrash ends the process it is in.
  console.log(`\nsee it lose the lot: node main.ts crash`);
  rmSync(path, { force: true });
}

function crash(): never {
  const path = './finch-crash.json';
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1,
    name: `user-${i + 1}`,
    email: `user-${i + 1}@example.com`,
  }));
  saveAndCrash(path, rows);
}

const command = process.argv[2] ?? 'shell';
if (command === 'shell') shell();
else if (command === 'demo') demo();
else if (command === 'costs') costs();
else if (command === 'crash') crash();
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}

export type { Row };
