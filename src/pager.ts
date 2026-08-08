// Step 2. The file stops being one value.
//
// A JSON document is a single thing. You cannot open it, jump to the four
// hundredth row, and read just that, because nothing in the format says where
// the four hundredth row begins. Every cost in step 1 comes from that.
//
// So we stop storing a document and start storing PAGES: fixed-size blocks, all
// the same length, numbered from zero. Page 7 is at byte 7 times the page size.
// That one piece of arithmetic is the whole idea, and everything in this course
// is built on top of it.
//
// Nothing above this file opens a file, seeks, or counts bytes. That is the job.

import { closeSync, existsSync, fstatSync, openSync } from 'node:fs';
import { readSync, writeSync } from 'node:fs';

// 4096 bytes, because that is the page size of the filesystem underneath us and
// of the memory manager underneath that. A 4 KiB write that is aligned to a
// 4 KiB boundary is one operation all the way down. Pick 5000 and every write
// straddles two of the operating system's pages and becomes two.
export const PAGE_SIZE = 4096;

export class Pager {
  readonly path: string;

  /** Bytes handed to the filesystem. Counted, so the claim can be checked. */
  bytesWritten = 0;

  /** Bytes read off the disk. */
  bytesRead = 0;

  reads = 0;
  writes = 0;

  private fd: number;

  constructor(path: string) {
    // r+ keeps what is already there. w+ creates. Opening an existing database
    // with w+ would truncate it, which is the step 1 bug wearing a new hat.
    this.path = path;
    this.fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
  }

  /** How many whole pages the file currently holds. */
  get pageCount(): number {
    return Math.ceil(fstatSync(this.fd).size / PAGE_SIZE);
  }

  // One page in, one page out. The cost of reading page 400 does not depend on
  // how many pages come before it, which is the thing step 1 could not do.
  readPage(n: number): Buffer {
    const page = Buffer.alloc(PAGE_SIZE);
    readSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesRead += PAGE_SIZE;
    this.reads++;
    return page;
  }

  writePage(n: number, page: Buffer): void {
    if (page.length !== PAGE_SIZE) {
      throw new Error(`a page is ${PAGE_SIZE} bytes, got ${page.length}`);
    }
    writeSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesWritten += PAGE_SIZE;
    this.writes++;
  }

  /** The next unused page number. Nothing is written until you write it. */
  allocate(): number {
    return this.pageCount;
  }

  close(): void {
    closeSync(this.fd);
  }
}
