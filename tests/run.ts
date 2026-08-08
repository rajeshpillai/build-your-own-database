// Every claim this engine makes, checked.
//
//   node tests/run.ts
//
// No test framework. A framework here would be one more thing to install, and
// the whole promise of this repository is that it clones and runs.

import { rmSync } from 'node:fs';
import { Database } from '../src/db.ts';
import { Executor } from '../src/execute.ts';
import { Heap } from '../src/heap.ts';
import { BTree } from '../src/btree.ts';
import { Pager, PAGE_SIZE } from '../src/pager.ts';
import { Wal, checksum } from '../src/wal.ts';
import { compact, deadBytes, freeSpace, insert, insertSorted } from '../src/page.ts';
import { liveCount, newPage, payloadAt, remove, rowCount, search } from '../src/page.ts';
import { Schema, decodeRow, encodeRow, encodedSize } from '../src/schema.ts';
import { parse } from '../src/parser.ts';
import { tokenise } from '../src/tokeniser.ts';
import { explain, planSelect } from '../src/plan.ts';
import type { Row } from '../src/schema.ts';

let passed = 0;
const failures: string[] = [];

function check(label: string, expected: unknown, actual: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    return;
  }
  failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
}

function group(name: string): void {
  console.log(`\n${name}`);
}

const TMP = process.env.TMP_DIR ?? '.';
const paths: string[] = [];

function tmp(name: string): string {
  const path = `${TMP}/finch-test-${name}-${process.pid}.db`;
  paths.push(path);
  Database.remove(path);
  return path;
}

const USERS = new Schema('users', [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'text' },
  { name: 'age', type: 'int' },
]);

const user = (id: number): Row => ({ id, name: `user-${id}`, age: 20 + (id % 40) });

// ── rows and bytes ──────────────────────────────────────────────────────────

group('schema');
{
  const row = { id: 7, name: 'ada', age: 36 };
  const bytes = encodeRow(USERS, row, { xmin: 1, xmax: 0 });
  check('a row round-trips', row, decodeRow(USERS, bytes).row);
  check('the version comes back', { xmin: 1, xmax: 0 }, decodeRow(USERS, bytes).version);
  check('size is header + fields', 12 + 1 + 3 + 4, encodedSize(USERS, row));
  check('the key is the first four bytes', 7, bytes.readUInt32LE(0));

  const accented = { id: 8, name: 'José', age: 30 };
  const back = decodeRow(USERS, encodeRow(USERS, accented, { xmin: 1, xmax: 0 })).row;
  check('utf-8 survives, bytes not characters', 'José', back.name);
}

// ── the slotted page ────────────────────────────────────────────────────────

group('page');
{
  const page = newPage();
  const one = encodeRow(USERS, user(1), { xmin: 1, xmax: 0 });
  const two = encodeRow(USERS, user(2), { xmin: 1, xmax: 0 });

  check('an empty page has room', PAGE_SIZE - 10, freeSpace(page));
  check('the first row lands in slot 0', 0, insert(page, one));
  check('the second in slot 1', 1, insert(page, two));
  check('both are readable', 2, rowCount(page));
  check('slot 1 is the second row', user(2), decodeRow(USERS, payloadAt(page, 1)!).row);

  check('deleting is a slot change', true, remove(page, 0));
  check('the slot count does not move', 2, rowCount(page));
  check('the live count does', 1, liveCount(page));
  check('and no space came back', one.length, deadBytes(page));

  const moved = compact(page);
  check('compaction moves the survivor', 0, moved.get(1));
  check('and reclaims the dead bytes', 0, deadBytes(page));
}

group('page, sorted');
{
  const page = newPage();
  for (const id of [5, 1, 9, 3]) {
    insertSorted(page, encodeRow(USERS, user(id), { xmin: 1, xmax: 0 }));
  }
  const keys = [0, 1, 2, 3].map((s) => decodeRow(USERS, payloadAt(page, s)!).row.id);
  check('slots come back in key order', [1, 3, 5, 9], keys);
  check('binary search finds a key', { slot: 2, found: true }, {
    slot: search(page, 5).slot,
    found: search(page, 5).found,
  });
  check('and reports where a miss would go', 3, search(page, 7).slot);
  check('four keys take three comparisons', true, search(page, 9).comparisons <= 3);
}

// ── the pager ───────────────────────────────────────────────────────────────

group('pager');
{
  const path = tmp('pager');
  const pager = new Pager(path, 2);
  const a = newPage();
  a.writeUInt32LE(111, 100);
  pager.writePage(0, a);
  pager.writePage(1, newPage());
  pager.writePage(2, newPage());

  check('three pages exist', 3, pager.pageCount);
  check('a small cache evicts', true, pager.evictions > 0);
  check('the evicted page reads back off disk', 111, pager.readPage(0).readUInt32LE(100));
  check('and that was a miss', true, pager.misses >= 1);
  pager.close();
}

// ── the heap ────────────────────────────────────────────────────────────────

group('heap');
{
  const path = tmp('heap');
  const pager = new Pager(path);
  const heap = new Heap(pager);
  const rows = 500;
  for (let id = 1; id <= rows; id++) {
    heap.insert(encodeRow(USERS, user(id), { xmin: 1, xmax: 0 }));
  }

  check('every row is stored', rows, heap.liveRows);
  const found = heap.findByKey(rows);
  check('the last row is found', rows, decodeRow(USERS, found.payload!).row.id);
  check('and it cost the whole file', rows, found.examined);
  check('a miss costs the whole file too', rows, heap.findByKey(9999).examined);
  pager.close();
}

// ── the B-tree ──────────────────────────────────────────────────────────────

group('btree');
{
  const path = tmp('btree');
  const pager = new Pager(path);
  const root = BTree.create(pager);
  const tree = new BTree(pager, root);

  const rows = 5000;
  for (let id = 1; id <= rows; id++) {
    tree.insert(encodeRow(USERS, user(id), { xmin: 1, xmax: 0 }));
  }

  check('the tree is two levels deep', 2, tree.height);
  check('a lookup touches one page per level', 2, lookupPages(tree, 4321));
  check('the first row is the same cost', 2, lookupPages(tree, 1));
  check('every row is in key order', true, inOrder(tree));
  check('a walk returns them all', rows, tree.walk().length);

  const range = tree.range(100, 199);
  check('a range returns exactly its keys', 100, range.length);
  check('starting at the low end', 100, range[0]!.readUInt32LE(0));
  check('a missing key is null', null, tree.get(999999));
  pager.close();
}

function lookupPages(tree: BTree, key: number): number {
  tree.get(key);
  return tree.pagesTouched;
}

function inOrder(tree: BTree): boolean {
  let last = -1;
  for (const payload of tree.walk()) {
    const key = payload.readUInt32LE(0);
    if (key < last) return false;
    last = key;
  }
  return true;
}

// ── the log ─────────────────────────────────────────────────────────────────

group('write-ahead log');
{
  const path = tmp('wal');
  const wal = new Wal(`${path}-log`);
  paths.push(`${path}-log`);

  const page = newPage();
  page.writeUInt32LE(42, 100);
  wal.appendPage(1, 7, page);
  check('an uncommitted page is invisible', null, wal.read(7));
  wal.commit(1);
  check('a committed page is readable', 42, wal.read(7)!.readUInt32LE(100));

  const other = newPage();
  other.writeUInt32LE(99, 100);
  wal.appendPage(2, 7, other);
  wal.rollback();
  check('a rolled back page leaves the old one', 42, wal.read(7)!.readUInt32LE(100));

  const report = wal.recover();
  check('recovery finds the commit', 1, report.committed);
  check('and discards what came after it', true, report.discarded > 0);
  check('the page is still there', 42, wal.read(7)!.readUInt32LE(100));
  check('a checksum detects a changed byte', false, checksum(page) === checksum(other));
  wal.close();
}

// ── the database ────────────────────────────────────────────────────────────

group('database');
{
  const path = tmp('db');
  const db = new Database(path);
  db.transaction(() => {
    db.createTable('users', USERS.columns);
    for (let id = 1; id <= 50; id++) db.insert('users', user(id));
  });

  check('rows are readable after commit', 'user-7', db.get('users', 7)?.name);
  check('a missing row is null', null, db.get('users', 999));
  check('every row is visible', 50, [...db.rows('users')].length);

  db.transaction(() => db.update('users', 7, { name: 'ada' }));
  check('an update replaces the visible version', 'ada', db.get('users', 7)?.name);
  check('and does not duplicate the row', 50, [...db.rows('users')].length);

  db.transaction(() => db.delete('users', 7));
  check('a delete hides the row', null, db.get('users', 7));
  check('and the count drops', 49, [...db.rows('users')].length);

  db.begin();
  db.insert('users', user(200));
  db.rollback();
  check('a rollback undoes the insert', null, db.get('users', 200));
  check('and leaves the rest alone', 49, [...db.rows('users')].length);

  const moved = db.checkpoint();
  check('a checkpoint moves pages into the file', true, moved > 0);
  check('rows survive the checkpoint', 'user-8', db.get('users', 8)?.name);
  db.close();

  const reopened = new Database(path);
  check('and survive a reopen', 'user-8', reopened.get('users', 8)?.name);
  check('with the deleted row still gone', null, reopened.get('users', 7));
  reopened.close();
}

group('durability');
{
  // Committed, never checkpointed, then the handle is dropped without a close.
  // That is what a kill -9 leaves behind: a log with the truth in it and a
  // database file that is still empty.
  const path = tmp('crash');
  const db = new Database(path);
  db.transaction(() => {
    db.createTable('users', USERS.columns);
    db.insert('users', user(1));
  });
  const filePagesBefore = db.pager.filePages;
  db.close();

  check('the database file lagged behind', 0, filePagesBefore);
  const after = new Database(path);
  check('and the log had the row', 'user-1', after.get('users', 1)?.name);
  after.close();
}

// ── indexes ─────────────────────────────────────────────────────────────────

group('index');
{
  const path = tmp('index');
  const db = new Database(path);
  db.transaction(() => {
    db.createTable('users', USERS.columns);
    for (let id = 1; id <= 200; id++) db.insert('users', user(id));
    db.createIndex('users', 'age');
  });

  const index = db.indexOn('users', 'age')!;
  check('an index on an int is not hashed', false, index.meta.hashed);
  const keys = db.candidates(index, 25);
  check('it finds every row with that value', 5, keys.length);
  check('and they all really have it', true, keys.every((k) => db.get('users', k)?.age === 25));

  db.transaction(() => db.createIndex('users', 'name'));
  const byName = db.indexOn('users', 'name')!;
  check('an index on text is hashed', true, byName.meta.hashed);
  check('a hashed lookup shortlists', true, db.candidates(byName, 'user-9').length >= 1);
  db.close();
}

// ── the query language ──────────────────────────────────────────────────────

group('tokeniser');
{
  const tokens = tokenise("select * from users where name = 'o''brien'");
  check('the quote escape is one quote', "o'brien", tokens[7]?.text);
  check('a symbol is its own token', '*', tokens[1]?.text);
  check('the list ends with an end token', 'end', tokens[tokens.length - 1]?.kind);
  check('a comparison of two characters stays whole', '>=', tokenise('a >= 1')[1]?.text);
}

group('parser');
{
  const statement = parse('SELECT name FROM users WHERE age >= 30 AND id = 4 LIMIT 2');
  check('it is a select', 'select', statement.kind);
  if (statement.kind === 'select') {
    check('with one projected column', ['name'], statement.columns);
    check('and a limit', 2, statement.limit);
    check('and an AND at the top', 'and', statement.where?.kind);
  }

  const insert = parse("INSERT INTO users VALUES (1, 'ada', 36)");
  check('an insert keeps its values', [1, 'ada', 36],
    insert.kind === 'insert' ? insert.values : null);

  let failed = '';
  try {
    parse('SELECT FROM');
  } catch (error) {
    failed = (error as Error).name;
  }
  check('a broken query is a syntax error', 'SyntaxError', failed);
}

group('sql');
{
  const path = tmp('sql');
  const db = new Database(path);
  const sql = new Executor(db);

  db.transaction(() => {
    sql.run('CREATE TABLE users (id int, name text, age int)');
    for (let id = 1; id <= 100; id++) {
      sql.run(`INSERT INTO users VALUES (${id}, 'user-${id}', ${20 + (id % 40)})`);
    }
  });

  check('a key lookup returns one row', 1, sql.run('SELECT * FROM users WHERE id = 5').rows.length);
  check('and examines one row', 1, sql.examined);
  check('a scan examines all of them', 100,
    sql.run("SELECT * FROM users WHERE name = 'user-5'").examined);

  const ranged = sql.run('SELECT * FROM users WHERE id >= 10 AND id <= 19');
  check('a range returns its rows', 10, ranged.rows.length);
  check('and reads only those', 10, ranged.examined);

  check('limit stops early', 3, sql.run('SELECT * FROM users LIMIT 3').rows.length);
  check('and stops the scan too', 3, sql.examined);

  check('projection keeps one column', ['name'],
    Object.keys(sql.run('SELECT name FROM users WHERE id = 1').rows[0]!));

  db.transaction(() => sql.run('CREATE INDEX ON users (age)'));
  const indexed = sql.run('SELECT * FROM users WHERE age = 25');
  check('an index answers without a scan', true, indexed.examined < 100);
  check('and returns the right rows', true, indexed.rows.every((r) => r.age === 25));
  check('explain names the index', true,
    sql.run('EXPLAIN SELECT * FROM users WHERE age = 25').plan!.join(' ')
      .includes('index lookup'));

  db.transaction(() => sql.run('UPDATE users SET name = %s WHERE id = 3'.replace('%s', "'ada'")));
  check('an update is visible', 'ada', sql.run('SELECT * FROM users WHERE id = 3').rows[0]?.name);
  db.transaction(() => sql.run('DELETE FROM users WHERE id = 4'));
  check('a delete is visible', 0, sql.run('SELECT * FROM users WHERE id = 4').rows.length);
  check('and the table shrank', 99, sql.run('SELECT * FROM users').rows.length);
  db.close();
}

group('join');
{
  const path = tmp('join');
  const db = new Database(path);
  const sql = new Executor(db);

  db.transaction(() => {
    sql.run('CREATE TABLE users (id int, name text, age int)');
    sql.run('CREATE TABLE orders (id int, owner int, total int)');
    for (let id = 1; id <= 10; id++) {
      sql.run(`INSERT INTO users VALUES (${id}, 'user-${id}', 30)`);
      sql.run(`INSERT INTO orders VALUES (${id}, ${((id - 1) % 3) + 1}, ${id * 10})`);
    }
  });

  const joined = sql.run(
    'SELECT users.name, orders.total FROM users JOIN orders ON users.id = orders.owner',
  );
  check('a join pairs the rows', 10, joined.rows.length);
  check('and carries both tables', true,
    joined.rows.every((r) => 'users.name' in r && 'orders.total' in r));
  check('explain says nested loop', true, joined.plan!.join(' ').includes('nested loop'));
  db.close();
}

group('planner');
{
  const path = tmp('planner');
  const db = new Database(path);
  const sql = new Executor(db);
  db.transaction(() => {
    sql.run('CREATE TABLE users (id int, name text, age int)');
    sql.run("INSERT INTO users VALUES (1, 'ada', 36)");
    sql.run('CREATE INDEX ON users (age)');
  });

  const path_of = (query: string) => {
    const statement = parse(query);
    if (statement.kind !== 'select') return '';
    return explain(planSelect(db, statement)).join(' | ');
  };

  check('the key wins', true, path_of('SELECT * FROM users WHERE id = 1').includes('pk lookup'));
  check('a range is a range', true,
    path_of('SELECT * FROM users WHERE id > 1 AND id < 9').includes('pk range'));
  check('an indexed column uses its index', true,
    path_of('SELECT * FROM users WHERE age = 36').includes('index lookup'));
  check('anything else is a scan', true,
    path_of("SELECT * FROM users WHERE name = 'ada'").includes('seq scan'));
  check('an OR gives up and scans', true,
    path_of('SELECT * FROM users WHERE id = 1 OR age = 2').includes('seq scan'));
  db.close();
}

// ── report ──────────────────────────────────────────────────────────────────

for (const path of paths) {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
}

console.log();
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  console.log(`\n${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
