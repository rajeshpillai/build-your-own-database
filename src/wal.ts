// The write-ahead log.
//
// The rule the name comes from: the change is written to the log, and the log is
// pushed to the disk, BEFORE the database file is touched at all. The database
// file then lags behind on purpose, and catches up later at a checkpoint.
//
// That sounds like more work and it is less. A commit becomes one append at the
// end of one file, followed by one fsync. Without the log, a commit that changed
// four pages scattered across the file has to push four pages to four places and
// wait for all of them, and a crash in the middle leaves two of them applied.
//
// A record on disk:
//
//   0   uint32   type      1 = a page image, 2 = a commit
//   4   uint32   txn       which transaction wrote it
//   8   uint32   page      which database page it is
//   12  uint32   checksum  of the bytes that follow
//   16  ...      the page image, 4096 bytes, for type 1 only
//
// The checksum is the whole reason recovery is safe. A machine that loses power
// mid-append leaves a record that is half written, and half a record is
// indistinguishable from a whole one unless something in it proves otherwise.

import { closeSync, existsSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import { ftruncateSync, readSync, writeSync } from 'node:fs';
import { PAGE_SIZE } from './pager.ts';

export const REC_PAGE = 1;
export const REC_COMMIT = 2;

const HEADER = 16;
const TYPE_AT = 0;
const TXN_AT = 4;
const PAGE_AT = 8;
const SUM_AT = 12;

/**
 * FNV-1a, 32 bits. Not a cryptographic hash and does not need to be — it is
 * detecting a torn write, not an attacker. It is nine lines and it is fast
 * enough to run on every 4 KiB page without anybody noticing.
 */
export function checksum(bytes: Buffer): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Wal {
  readonly path: string;

  /** Where the newest image of each page lives in the log. */
  private frames = new Map<number, number>();
  private fd: number;
  private end: number;

  /** Offsets appended by transactions that have not committed yet. */
  private pending: Array<[number, number]> = [];

  appends = 0;
  syncs = 0;
  checkpoints = 0;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
    this.end = fstatSync(this.fd).size;
  }

  get size(): number {
    return this.end;
  }

  /** Pages the log is holding that the database file does not have yet. */
  get frameCount(): number {
    return this.frames.size;
  }

  /**
   * Append one page image. The database file is not touched.
   *
   * The frame is not published to readers until the transaction commits, so a
   * transaction that rolls back leaves bytes in the log that nothing ever reads.
   * Those bytes go away at the next checkpoint.
   */
  appendPage(txn: number, pageNo: number, image: Buffer): void {
    const record = Buffer.alloc(HEADER + PAGE_SIZE);
    record.writeUInt32LE(REC_PAGE, TYPE_AT);
    record.writeUInt32LE(txn, TXN_AT);
    record.writeUInt32LE(pageNo, PAGE_AT);
    record.writeUInt32LE(checksum(image), SUM_AT);
    image.copy(record, HEADER);

    writeSync(this.fd, record, 0, record.length, this.end);
    this.pending.push([pageNo, this.end + HEADER]);
    this.end += record.length;
    this.appends++;
  }

  /**
   * Write the commit record and wait for the disk.
   *
   * This one fsync is the durability of the whole transaction. Every page it
   * changed is already in the log ahead of this record, so a log that ends here
   * is a log that can rebuild all of them.
   */
  commit(txn: number): void {
    const record = Buffer.alloc(HEADER);
    record.writeUInt32LE(REC_COMMIT, TYPE_AT);
    record.writeUInt32LE(txn, TXN_AT);
    record.writeUInt32LE(checksum(Buffer.alloc(0)), SUM_AT);
    writeSync(this.fd, record, 0, record.length, this.end);
    this.end += record.length;

    fsyncSync(this.fd);
    this.syncs++;

    for (const [pageNo, at] of this.pending) this.frames.set(pageNo, at);
    this.pending = [];
  }

  /** Forget what this transaction appended. The bytes stay, unread. */
  rollback(): void {
    this.pending = [];
  }

  /** The newest committed image of a page, or null if the log has none. */
  read(pageNo: number): Buffer | null {
    const at = this.frames.get(pageNo);
    if (at === undefined) return null;
    const page = Buffer.alloc(PAGE_SIZE);
    readSync(this.fd, page, 0, PAGE_SIZE, at);
    return page;
  }

  /**
   * Scan the log from the start and rebuild the frame index.
   *
   * Records are trusted only up to the last commit that is followed by nothing
   * broken. Anything after that was in flight when the power went, and a
   * transaction that never said COMMIT never promised anything.
   */
  recover(): { records: number; committed: number; discarded: number } {
    this.frames.clear();
    this.pending = [];

    let at = 0;
    let records = 0;
    let committed = 0;
    let staged: Array<[number, number]> = [];
    let good = 0;

    while (at + HEADER <= this.end) {
      const header = Buffer.alloc(HEADER);
      readSync(this.fd, header, 0, HEADER, at);
      const type = header.readUInt32LE(TYPE_AT);

      if (type === REC_COMMIT) {
        for (const frame of staged) this.frames.set(frame[0], frame[1]);
        staged = [];
        at += HEADER;
        good = at;
        records++;
        committed++;
        continue;
      }

      if (type !== REC_PAGE || at + HEADER + PAGE_SIZE > this.end) break;

      const image = Buffer.alloc(PAGE_SIZE);
      readSync(this.fd, image, 0, PAGE_SIZE, at + HEADER);
      // A record whose bytes do not match its own checksum was half written.
      // Everything after it is unreadable too, because we no longer know where
      // the next record starts.
      if (checksum(image) !== header.readUInt32LE(SUM_AT)) break;

      staged.push([header.readUInt32LE(PAGE_AT), at + HEADER]);
      at += HEADER + PAGE_SIZE;
      records++;
    }

    const discarded = this.end - good;
    this.end = good;
    ftruncateSync(this.fd, this.end);
    return { records, committed, discarded };
  }

  /**
   * Copy every frame into the database file, then empty the log.
   *
   * This is the catch-up. Until it runs, the log grows forever and every reopen
   * has more of it to replay — which is the honest cost of never touching the
   * database file on the write path.
   */
  checkpoint(
    write: (pageNo: number, image: Buffer) => void,
    sync: () => void,
  ): number {
    const moved = this.frames.size;
    for (const [pageNo] of this.frames) {
      const image = this.read(pageNo);
      if (image) write(pageNo, image);
    }
    sync();

    this.frames.clear();
    this.pending = [];
    this.end = 0;
    ftruncateSync(this.fd, 0);
    fsyncSync(this.fd);
    this.checkpoints++;
    return moved;
  }

  close(): void {
    closeSync(this.fd);
  }
}
