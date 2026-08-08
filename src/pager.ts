// The pager: a file cut into fixed-size pages, with a cache in front of it.
//
// The pages came first. A JSON document is a single thing, so there is no way to
// read part of it; fixed-size blocks numbered from zero turn "find page 400"
// into one multiplication.
//
// The cache is this step, and it is not an optimisation bolted on afterwards. A
// database reads the same handful of pages constantly — the top of an index, the
// page it is inserting into — so a cache is the difference between a lookup that
// costs one disk read and one that costs four.
//
// It is also where the first honest disappointment lives, and the demo puts it
// on screen rather than hiding it: least-recently-used is exactly the wrong
// policy for a scan, and a scan is what a table with no index has to do.
//
// Nothing above this file opens a file, seeks, or counts bytes. That is the job.

import { closeSync, existsSync, fstatSync, openSync } from 'node:fs';
import { readSync, writeSync } from 'node:fs';

// 4096 bytes, because that is the page size of the filesystem underneath us and
// of the memory manager underneath that. A 4 KiB write that is aligned to a
// 4 KiB boundary is one operation all the way down. Pick 5000 and every write
// straddles two of the operating system's pages and becomes two.
export const PAGE_SIZE = 4096;

// Pages held in memory. Small on purpose: a real one is set from a memory
// budget, and a small number here makes eviction visible in a short lecture.
export const DEFAULT_CAPACITY = 64;

export class Pager {
  readonly path: string;
  readonly capacity: number;

  /** Bytes handed to the filesystem. Counted, so the claim can be checked. */
  bytesWritten = 0;

  /** Bytes read off the disk. */
  bytesRead = 0;

  reads = 0;
  writes = 0;

  hits = 0;
  misses = 0;
  evictions = 0;

  // A Map iterates in insertion order, which is all an LRU queue is. Delete a
  // key and set it again and it moves to the back, so the front is always the
  // least recently used. There is no linked list here to get wrong.
  private cache = new Map<number, Buffer>();
  private fd: number;

  constructor(path: string, capacity: number = DEFAULT_CAPACITY) {
    // r+ keeps what is already there. w+ creates. Opening an existing database
    // with w+ would empty it, which is the first step's crash wearing a new hat.
    this.path = path;
    this.capacity = capacity;
    this.fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
  }

  /** How many whole pages the file currently holds. */
  get pageCount(): number {
    return Math.ceil(fstatSync(this.fd).size / PAGE_SIZE);
  }

  // A page we already have costs nothing. A page we do not costs one read of
  // exactly one page, whatever the size of the file.
  readPage(n: number): Buffer {
    const cached = this.cache.get(n);
    if (cached) {
      this.hits++;
      this.touch(n, cached);
      return cached;
    }

    this.misses++;
    const page = Buffer.alloc(PAGE_SIZE);
    readSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesRead += PAGE_SIZE;
    this.reads++;
    this.touch(n, page);
    return page;
  }

  writePage(n: number, page: Buffer): void {
    if (page.length !== PAGE_SIZE) {
      throw new Error(`a page is ${PAGE_SIZE} bytes, got ${page.length}`);
    }
    writeSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesWritten += PAGE_SIZE;
    this.writes++;
    // The copy in the cache would otherwise be stale, and a stale read is far
    // worse than a slow one: it is wrong, and nothing reports it.
    this.touch(n, Buffer.from(page));
  }

  // Move a page to the back of the queue, evicting the front if we are full.
  private touch(n: number, page: Buffer): void {
    this.cache.delete(n);
    this.cache.set(n, page);
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.evictions++;
      }
    }
  }

  /** The next unused page number. Nothing is written until you write it. */
  allocate(): number {
    return this.pageCount;
  }

  close(): void {
    closeSync(this.fd);
  }
}
