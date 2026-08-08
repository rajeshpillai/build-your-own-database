// Where the course starts: rows in a JSON file.
//
// There is no database in this file. It is the thing almost everybody writes
// first — read the whole file, parse it, change the array, write the whole file
// back. It works, and for a few hundred rows that change twice a day it is the
// right answer.
//
// It is kept in the finished engine on purpose. Every primitive built after it —
// a page, a pager, a B-tree, a write-ahead log — is answering a cost you can
// watch this file pay, and the comparison stops being a claim the moment both
// are in the same repository.

import { existsSync, openSync, readFileSync } from 'node:fs';
import { writeFileSync, writeSync } from 'node:fs';

export type JsonRow = { id: number; name: string; email: string };

// Counters, not estimates. Every number this store reports is the result of
// pure computation over the rows it was given, so it is the same on your machine
// as it is on camera.
export class JsonStore {
  readonly path: string;

  /** Bytes handed to the filesystem since this store was opened. */
  bytesWritten = 0;

  /** Rows compared, totalled across every lookup this store has answered. */
  rowsExamined = 0;

  constructor(path: string) {
    this.path = path;
  }

  // Every operation begins by parsing the entire file, because a JSON document
  // has no way to address one row inside it. There is no seeking to row 400.
  private load(): JsonRow[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, 'utf8')) as JsonRow[];
  }

  private save(rows: JsonRow[]): void {
    const text = JSON.stringify(rows);
    this.bytesWritten += Buffer.byteLength(text);
    writeFileSync(this.path, text);
  }

  // Appending one row rewrites every row. Insert n rows and the file is written
  // n times, at an average size of n/2 — so the bytes written grow with the
  // square of the rows stored. That is the first cost, and it is why step 2
  // stops storing the database as one value.
  insert(row: JsonRow): void {
    const rows = this.load();
    rows.push(row);
    this.save(rows);
  }

  // The second cost. Nothing here is sorted and nothing is indexed, so the only
  // way to answer "which row has this id" is to look at all of them.
  find(id: number): JsonRow | undefined {
    for (const row of this.load()) {
      this.rowsExamined++;
      if (row.id === id) return row;
    }
    return undefined;
  }

  all(): JsonRow[] {
    return this.load();
  }
}

// The third cost, and the one that ends the argument.
//
// writeFileSync opens the file with a flag that empties it first: it throws away
// what was on disk and then writes the new contents. Between those two things
// the file holds less than it did before the call, and a process that dies in
// the gap leaves it that way.
//
// Waiting for that to happen by luck makes a demonstration nobody can reproduce,
// so the failure point here is explicit. Half the bytes are written, then the
// process exits. A power cut gets you the same file. This just gets it every
// time.
export function saveAndCrash(path: string, rows: JsonRow[]): never {
  const text = JSON.stringify(rows);
  const fd = openSync(path, 'w'); // the rows already on disk are gone, now
  writeSync(fd, text.slice(0, Math.floor(text.length / 2)));
  process.exit(1); // and nothing ever writes the rest
}
