// The database: a catalog, some tables, some indexes, and a transaction.
//
// Page 0 is the catalog. It says which tables exist, what columns they have, and
// which page each tree starts at. Everything else in the file is reachable from
// it, which is what makes the file self-describing — open it on another machine
// with no code but this and you can still find every row.
//
// The catalog is stored as JSON, which is a deliberate joke at step 1's expense
// and also the right answer. It is read once at open, written rarely, and it is
// the one thing in the file a human may need to read with `head -c 4096`.

import { existsSync, rmSync } from 'node:fs';
import { BTree } from './btree.ts';
import { newPage, LEAF } from './page.ts';
import { Pager, PAGE_SIZE } from './pager.ts';
import { Wal } from './wal.ts';
import { Schema, decodeRow, encodeRow, keyOfPayload } from './schema.ts';
import { markDeleted, versionOfPayload } from './schema.ts';
import type { Column, Row, Value } from './schema.ts';

export const CATALOG_PAGE = 0;

export type IndexMeta = {
  name: string;
  table: string;
  column: string;
  root: number;
  hashed: boolean;
};

export type TableMeta = { name: string; columns: Column[]; root: number };
export type Catalog = {
  tables: TableMeta[];
  indexes: IndexMeta[];
  nextTxn: number;
};

// A function, not a constant. A shared `{ tables: [], ... }` spread with `...`
// hands every database the SAME arrays, so the second one opened starts life
// holding the first one's tables. It cost half an hour and no error message.
function emptyCatalog(): Catalog {
  return { tables: [], indexes: [], nextTxn: 1 };
}

/**
 * A 32-bit hash of a text value, so a text column can live in a tree whose keys
 * are numbers.
 *
 * The index is then LOSSY: two different strings can land on the same key, so
 * finding a row through it is a shortlist and never an answer. Whatever uses it
 * has to compare the real value afterwards. That is not a shortcut taken here —
 * it is what a hash index is, and pretending otherwise returns wrong rows.
 */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function indexKeyOf(value: Value): number {
  return typeof value === 'number' ? value >>> 0 : hashText(value);
}

/** An index is a tree of two-column rows: the indexed key, and the row's key. */
const INDEX_COLUMNS: Column[] = [
  { name: 'k', type: 'int' },
  { name: 'pk', type: 'int' },
];

export class Table {
  readonly schema: Schema;
  readonly tree: BTree;
  readonly meta: TableMeta;

  constructor(meta: TableMeta, pager: Pager) {
    this.meta = meta;
    this.schema = new Schema(meta.name, meta.columns);
    this.tree = new BTree(pager, meta.root);
  }
}

export class Index {
  readonly meta: IndexMeta;
  readonly tree: BTree;
  readonly schema: Schema;

  constructor(meta: IndexMeta, pager: Pager) {
    this.meta = meta;
    this.schema = new Schema(meta.name, INDEX_COLUMNS);
    this.tree = new BTree(pager, meta.root);
  }
}

export class Database {
  readonly pager: Pager;
  readonly wal: Wal;

  /** The transaction currently open, or 0 if we are not in one. */
  txn = 0;

  /** What a read is allowed to see. Set when a transaction begins. */
  snapshot = 0;

  private catalog: Catalog;
  private tables = new Map<string, Table>();
  private indexes: Index[] = [];
  private dirtyCatalog = false;

  constructor(path: string) {
    this.pager = new Pager(path);
    this.wal = new Wal(`${path}-wal`);

    // Before anything is read, the log is replayed. A database that was killed
    // mid-write has its committed pages in the log and nowhere else, and every
    // read below this line would otherwise see the file as it was before them.
    this.wal.recover();
    this.pager.log = this.wal;

    this.catalog = this.readCatalog();
    for (const meta of this.catalog.tables) {
      this.tables.set(meta.name, new Table(meta, this.pager));
    }
    for (const meta of this.catalog.indexes) {
      this.indexes.push(new Index(meta, this.pager));
    }
    // The catalog knows how far the file goes even when the log is empty and the
    // file is short, which happens on a fresh database that has never checkpointed.
    let highest = 1;
    for (const t of this.catalog.tables) highest = Math.max(highest, t.root + 1);
    for (const i of this.catalog.indexes) highest = Math.max(highest, i.root + 1);
    this.pager.observe(highest);
  }

  /** Throw the whole database away. For tests and demos, and nothing else. */
  static remove(path: string): void {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }

  // ── the catalog ───────────────────────────────────────────────────────────

  private readCatalog(): Catalog {
    const fresh = this.pager.pageCount === 0 && this.wal.frameCount === 0;
    if (fresh) return emptyCatalog();
    const page = this.pager.readPage(CATALOG_PAGE);
    const length = page.readUInt32LE(0);
    if (length === 0 || length > PAGE_SIZE - 4) return emptyCatalog();
    try {
      return JSON.parse(page.toString('utf8', 4, 4 + length)) as Catalog;
    } catch {
      return emptyCatalog();
    }
  }

  private writeCatalog(): void {
    const text = Buffer.from(JSON.stringify(this.catalog), 'utf8');
    if (text.length > PAGE_SIZE - 4) {
      throw new Error('the catalog outgrew one page — finch stops here on purpose');
    }
    const page = Buffer.alloc(PAGE_SIZE);
    page.writeUInt32LE(text.length, 0);
    text.copy(page, 4);
    this.pager.writePage(CATALOG_PAGE, page);
    this.dirtyCatalog = false;
  }

  // ── schema ────────────────────────────────────────────────────────────────

  createTable(name: string, columns: Column[]): Table {
    if (this.tables.has(name)) throw new Error(`table ${name} already exists`);
    this.reserveCatalogPage();
    const root = BTree.create(this.pager);
    const meta: TableMeta = { name, columns, root };
    this.catalog.tables.push(meta);
    this.dirtyCatalog = true;

    const table = new Table(meta, this.pager);
    this.tables.set(name, table);
    return table;
  }

  createIndex(tableName: string, column: string): Index {
    const table = this.table(tableName);
    const col = table.schema.column(column);
    if (!col) throw new Error(`${tableName} has no column ${column}`);
    this.reserveCatalogPage();

    const root = BTree.create(this.pager);
    const meta: IndexMeta = {
      name: `${tableName}_${column}`,
      table: tableName,
      column,
      root,
      hashed: col.type === 'text',
    };
    this.catalog.indexes.push(meta);
    this.dirtyCatalog = true;

    const index = new Index(meta, this.pager);
    this.indexes.push(index);

    // Backfill. Building an index on a table that already has rows costs one
    // full scan, which is why adding one to a large table is a maintenance job.
    for (const payload of table.tree.walk()) {
      const { row } = decodeRow(table.schema, payload);
      this.indexInsert(index, row, table.schema);
    }
    return index;
  }

  /**
   * Page 0 has to exist before any tree is allocated, or the first table's root
   * lands on it and overwrites the catalog on the first insert.
   */
  private reserveCatalogPage(): void {
    if (this.pager.pageCount === 0) {
      this.pager.writePage(CATALOG_PAGE, newPage(LEAF));
    }
  }

  table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new Error(`no such table: ${name}`);
    return table;
  }

  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  indexesFor(table: string): Index[] {
    return this.indexes.filter((i) => i.meta.table === table);
  }

  indexOn(table: string, column: string): Index | undefined {
    return this.indexes.find(
      (i) => i.meta.table === table && i.meta.column === column,
    );
  }

  // ── transactions ──────────────────────────────────────────────────────────

  /**
   * Start a transaction.
   *
   * finch allows one writer at a time, which is the simplification the whole of
   * section 7 is honest about. What it buys is that a transaction never has to
   * ask whether another one committed: the only versions it can see are its own
   * and the ones that were already committed when it started.
   */
  begin(): number {
    if (this.txn !== 0) throw new Error('finch does not nest transactions');
    this.txn = this.catalog.nextTxn++;
    this.snapshot = this.txn;
    this.pager.txn = this.txn;
    this.dirtyCatalog = true;
    return this.txn;
  }

  commit(): void {
    if (this.txn === 0) throw new Error('commit outside a transaction');
    if (this.dirtyCatalog) this.writeCatalog();
    this.wal.commit(this.txn);
    this.txn = 0;
    this.pager.txn = 0;
  }

  /**
   * Undo everything this transaction did.
   *
   * There is nothing to undo. The pages it wrote went to the log and were never
   * published, and the cache is the only other place they exist — so dropping
   * both is the whole of rollback. That falls out of writing ahead, and it is
   * the second reason the log is worth its complexity.
   */
  rollback(): void {
    this.wal.rollback();
    this.pager.forget();
    this.catalog = this.readCatalog();
    this.rebind();
    this.txn = 0;
    this.pager.txn = 0;
    this.dirtyCatalog = false;
  }

  private rebind(): void {
    this.tables.clear();
    this.indexes = [];
    for (const meta of this.catalog.tables) {
      this.tables.set(meta.name, new Table(meta, this.pager));
    }
    for (const meta of this.catalog.indexes) {
      this.indexes.push(new Index(meta, this.pager));
    }
  }

  /** Run a function inside a transaction, committing it or undoing all of it. */
  transaction<T>(body: () => T): T {
    this.begin();
    try {
      const value = body();
      this.commit();
      return value;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** Move the log's pages into the database file and empty the log. */
  checkpoint(): number {
    if (this.txn !== 0) throw new Error('checkpoint inside a transaction');
    return this.wal.checkpoint(
      (pageNo, image) => this.pager.writeThrough(pageNo, image),
      () => this.pager.sync(),
    );
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  /** Is this stored version of a row visible to the snapshot we are reading at? */
  visible(payload: Buffer, snapshot: number): boolean {
    const v = versionOfPayload(payload);
    if (v.xmin > snapshot) return false;
    return v.xmax === 0 || v.xmax > snapshot;
  }

  private requireTxn(): number {
    if (this.txn === 0) throw new Error('writes must happen inside a transaction');
    return this.txn;
  }

  insert(tableName: string, row: Row): void {
    const txn = this.requireTxn();
    const table = this.table(tableName);
    const key = table.schema.keyOf(row);
    if (this.get(tableName, key)) {
      throw new Error(`${tableName}: duplicate key ${key}`);
    }
    table.tree.insert(encodeRow(table.schema, row, { xmin: txn, xmax: 0 }));
    for (const index of this.indexesFor(tableName)) {
      this.indexInsert(index, row, table.schema);
    }
  }

  private indexInsert(index: Index, row: Row, schema: Schema): void {
    const value = row[index.meta.column];
    if (value === undefined) return;
    const entry: Row = { k: indexKeyOf(value), pk: schema.keyOf(row) };
    index.tree.insert(
      encodeRow(index.schema, entry, { xmin: this.txn || 1, xmax: 0 }),
    );
  }

  /** One row by key, or null if it is missing or invisible to this snapshot. */
  get(tableName: string, key: number): Row | null {
    const table = this.table(tableName);
    const snapshot = this.snapshot || this.catalog.nextTxn;
    for (const payload of table.tree.getAll(key)) {
      if (!this.visible(payload, snapshot)) continue;
      return decodeRow(table.schema, payload).row;
    }
    return null;
  }

  /**
   * A new version of a row, with the old one stamped as gone.
   *
   * Nothing is overwritten. The old bytes stay exactly where they are, which is
   * what lets a reader that started before this transaction keep reading them.
   */
  update(tableName: string, key: number, changes: Row): boolean {
    const txn = this.requireTxn();
    const table = this.table(tableName);
    const current = this.get(tableName, key);
    if (!current) return false;

    table.tree.edit(key, (payload) => {
      if (versionOfPayload(payload).xmax !== 0) return false;
      markDeleted(payload, txn);
      return true;
    });

    const next = { ...current, ...changes, [table.schema.key]: key };
    table.tree.insert(encodeRow(table.schema, next, { xmin: txn, xmax: 0 }));
    for (const index of this.indexesFor(tableName)) {
      this.indexInsert(index, next, table.schema);
    }
    return true;
  }

  /** Stamp a row as deleted. Eight bytes change and nothing moves. */
  delete(tableName: string, key: number): boolean {
    const txn = this.requireTxn();
    const table = this.table(tableName);
    if (!this.get(tableName, key)) return false;
    return table.tree.edit(key, (payload) => {
      if (versionOfPayload(payload).xmax !== 0) return false;
      markDeleted(payload, txn);
      return true;
    });
  }

  /** Every visible row of a table, in key order. */
  *rows(tableName: string): Generator<Row> {
    const table = this.table(tableName);
    const snapshot = this.snapshot || this.catalog.nextTxn;
    for (const payload of table.tree.walk()) {
      if (!this.visible(payload, snapshot)) continue;
      yield decodeRow(table.schema, payload).row;
    }
  }

  /** Row keys an index offers for a value. A shortlist, not an answer. */
  candidates(index: Index, value: Value): number[] {
    const snapshot = this.snapshot || this.catalog.nextTxn;
    const out: number[] = [];
    for (const payload of index.tree.getAll(indexKeyOf(value))) {
      if (!this.visible(payload, snapshot)) continue;
      out.push(decodeRow(index.schema, payload).row.pk as number);
    }
    return out;
  }

  /** Keys in a range, straight off the table's own tree. */
  keysBetween(tableName: string, lo: number, hi: number): Row[] {
    const table = this.table(tableName);
    const snapshot = this.snapshot || this.catalog.nextTxn;
    const out: Row[] = [];
    for (const payload of table.tree.range(lo, hi)) {
      if (!this.visible(payload, snapshot)) continue;
      out.push(decodeRow(table.schema, payload).row);
    }
    return out;
  }

  /** The highest key stored in a table, or 0. Used by the demos. */
  maxKey(tableName: string): number {
    let max = 0;
    for (const payload of this.table(tableName).tree.walk()) {
      max = Math.max(max, keyOfPayload(payload));
    }
    return max;
  }

  close(): void {
    this.wal.close();
    this.pager.close();
  }
}
