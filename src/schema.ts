// A table, and the bytes one of its rows turns into.
//
// The early steps of this course store one hard-coded row shape. This file is
// what that grows into: the layout stops living in the code and starts living in
// a value, so one storage engine can hold more than one table.
//
// A stored row looks like this, and the order is not arbitrary:
//
//   0   uint32   key          the first column, always an int
//   4   uint32   xmin         the transaction that created this version
//   8   uint32   xmax         the transaction that deleted it, or 0
//   12  ...      the remaining columns, in schema order
//
// The key is first so that a page can read it without decoding anything else.
// Comparing keys is what a B-tree does thousands of times per lookup, and it
// materialises exactly one row at the end of it.
//
// finch has no NULL. That is a real simplification and it is worth saying out
// loud: NULL turns every comparison into three-valued logic, and three-valued
// logic changes the meaning of every operator in the query language.

export type ColumnType = 'int' | 'text';
export type Column = { name: string; type: ColumnType };
export type Value = number | string;
export type Row = Record<string, Value>;

/** The transaction stamps a stored row carries. See txn.ts. */
export type Version = { xmin: number; xmax: number };

export const VISIBLE_TO_ALL = 0;
export const NOT_DELETED = 0;

const KEY_AT = 0;
const XMIN_AT = 4;
const XMAX_AT = 8;
export const ROW_HEADER = 12;

const LEN_SIZE = 1;
const MAX_TEXT = 255; // what one length byte can describe

export class Schema {
  readonly table: string;
  readonly columns: Column[];

  constructor(table: string, columns: Column[]) {
    if (columns.length === 0) throw new Error(`table ${table} has no columns`);
    const first = columns[0];
    if (!first || first.type !== 'int') {
      throw new Error(`${table}: the first column is the key, and must be int`);
    }
    this.table = table;
    this.columns = columns;
  }

  /** The key column's name. Every table has exactly one and it comes first. */
  get key(): string {
    return this.columns[0]!.name;
  }

  column(name: string): Column | undefined {
    return this.columns.find((c) => c.name === name);
  }

  keyOf(row: Row): number {
    const k = row[this.key];
    if (typeof k !== 'number') {
      throw new Error(`${this.table}.${this.key} must be an int`);
    }
    return k;
  }
}

export function encodedSize(schema: Schema, row: Row): number {
  let size = ROW_HEADER;
  for (const col of schema.columns.slice(1)) {
    size += col.type === 'int' ? 4 : LEN_SIZE + textBytes(row, col.name);
  }
  return size;
}

export function encodeRow(schema: Schema, row: Row, version: Version): Buffer {
  const out = Buffer.alloc(encodedSize(schema, row));
  out.writeUInt32LE(schema.keyOf(row), KEY_AT);
  out.writeUInt32LE(version.xmin, XMIN_AT);
  out.writeUInt32LE(version.xmax, XMAX_AT);

  let off = ROW_HEADER;
  for (const col of schema.columns.slice(1)) {
    const value = row[col.name];
    if (col.type === 'int') {
      if (typeof value !== 'number') {
        throw new Error(`${schema.table}.${col.name} must be an int`);
      }
      out.writeInt32LE(value, off);
      off += 4;
    } else {
      off = writeText(out, off, String(value ?? ''));
    }
  }
  return out;
}

type Decoded = { row: Row; version: Version };

export function decodeRow(schema: Schema, buf: Buffer): Decoded {
  const row: Row = { [schema.key]: buf.readUInt32LE(KEY_AT) };
  const version = {
    xmin: buf.readUInt32LE(XMIN_AT),
    xmax: buf.readUInt32LE(XMAX_AT),
  };

  let off = ROW_HEADER;
  for (const col of schema.columns.slice(1)) {
    if (col.type === 'int') {
      row[col.name] = buf.readInt32LE(off);
      off += 4;
    } else {
      const text = readText(buf, off);
      row[col.name] = text.text;
      off += LEN_SIZE + text.bytes;
    }
  }
  return { row, version };
}

/** The key of a stored row, without decoding the rest of it. */
export function keyOfPayload(buf: Buffer, at = 0): number {
  return buf.readUInt32LE(at + KEY_AT);
}

export function versionOfPayload(buf: Buffer, at = 0): Version {
  return {
    xmin: buf.readUInt32LE(at + XMIN_AT),
    xmax: buf.readUInt32LE(at + XMAX_AT),
  };
}

/** Stamp a stored row as deleted by this transaction. Nothing moves. */
export function markDeleted(buf: Buffer, txn: number, at = 0): void {
  buf.writeUInt32LE(txn, at + XMAX_AT);
}

function textBytes(row: Row, name: string): number {
  return Buffer.byteLength(String(row[name] ?? ''), 'utf8');
}

// The trap, and it is the same one that truncates HTTP responses. A length here
// is a count of BYTES, not of characters, and the two are equal right up until
// somebody is called José. `'café'.length` is 4; its UTF-8 is 5 bytes. Write the
// character count and every field after this one is read from the wrong offset —
// not a crash, just silently wrong data, and only for non-English rows.
function writeText(into: Buffer, off: number, text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT) {
    throw new Error(`"${text.slice(0, 12)}…" is ${bytes} bytes, max ${MAX_TEXT}`);
  }
  into.writeUInt8(bytes, off);
  into.write(text, off + LEN_SIZE, bytes, 'utf8');
  return off + LEN_SIZE + bytes;
}

function readText(from: Buffer, off: number): { text: string; bytes: number } {
  const bytes = from.readUInt8(off);
  const start = off + LEN_SIZE;
  return { text: from.toString('utf8', start, start + bytes), bytes };
}
