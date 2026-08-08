// The heap file: a sequence of slotted pages with an append point at the end.
//
// This is the simplest thing that stores rows and finds them again, and the
// course keeps it after the B-tree arrives. It is the baseline every later
// measurement is taken against, and it is what a table with no index actually
// is.
//
// The idea that outlasts this file is the row id. A row is not addressed by its
// contents or by a position in some list — it is addressed by which page it is
// on and which slot on that page, and both of those are stable. The page does
// not move, and the slot indirection means the slot does not move either, even
// when the row beside it is deleted.

import { freeSpace, insert, liveCount, newPage, payloadAt } from './page.ts';
import { payloads, rowCount, usedBytes } from './page.ts';
import { type Pager } from './pager.ts';

export type RowId = { page: number; slot: number };

export class Heap {
  readonly pager: Pager;
  readonly first: number;

  /** Pages allocated because a row did not fit on the one before. */
  splits = 0;

  private tail: Buffer;
  private tailNo: number;

  constructor(pager: Pager, first = 0) {
    this.pager = pager;
    this.first = first;
    if (pager.pageCount <= first) {
      this.tail = newPage();
      this.tailNo = first;
      pager.writePage(first, this.tail);
    } else {
      this.tailNo = pager.pageCount - 1;
      this.tail = pager.readPage(this.tailNo);
    }
  }

  get pageCount(): number {
    return this.pager.pageCount - this.first;
  }

  /** Bytes free on the page currently being appended to. */
  get tailFree(): number {
    return freeSpace(this.tail);
  }

  insert(payload: Buffer): RowId {
    let slot = insert(this.tail, payload);

    if (slot === -1) {
      // The page is full. Flush it, start another, and put the row there. The
      // full page is never revisited — a heap file appends, and reclaiming the
      // gaps it leaves is a separate job with its own name.
      this.pager.writePage(this.tailNo, this.tail);
      this.tailNo += 1;
      this.tail = newPage();
      this.splits += 1;
      slot = insert(this.tail, payload);
      if (slot === -1) throw new Error('row does not fit on an empty page');
    }

    this.pager.writePage(this.tailNo, this.tail);
    return { page: this.tailNo, slot };
  }

  // Two pieces of arithmetic and one disk read, whatever the size of the file.
  // Step 1 answered this by parsing every row it had.
  get(rid: RowId): Buffer | null {
    if (rid.page >= this.pager.pageCount) return null;
    const payload = payloadAt(this.pager.readPage(rid.page), rid.slot);
    return payload ? Buffer.from(payload) : null;
  }

  /**
   * Every live row in the file, page by page and slot by slot.
   *
   * This is the only way a table with no index can answer a question about a
   * column, and it is the honest baseline the rest of the course is measured
   * against. There is no ordering here — the rows come back in the order they
   * were inserted, because that is the order they are lying on the disk in.
   */
  *scan(): Generator<Buffer> {
    for (let p = this.first; p < this.pager.pageCount; p++) {
      for (const payload of payloads(this.pager.readPage(p))) yield payload;
    }
  }

  /**
   * Find one row by key. Reads pages until it finds it, so the cost depends
   * entirely on where the row happens to be — and on a miss it is the whole file
   * every time. Section 3 is about removing this function.
   */
  findByKey(key: number): { payload: Buffer | null; examined: number } {
    let examined = 0;
    for (const payload of this.scan()) {
      examined++;
      if (payload.readUInt32LE(0) === key) return { payload, examined };
    }
    return { payload: null, examined };
  }

  /** Live rows across the whole file. */
  get liveRows(): number {
    let live = 0;
    for (let p = this.first; p < this.pager.pageCount; p++) {
      live += liveCount(this.pager.readPage(p));
    }
    return live;
  }

  /** Rows and space on one page, for the occupancy figures. */
  stats(page: number): { rows: number; used: number; free: number } {
    const p = this.pager.readPage(page);
    return { rows: rowCount(p), used: usedBytes(p), free: freeSpace(p) };
  }
}
