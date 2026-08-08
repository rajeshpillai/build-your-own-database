// The pager: a file, cut into fixed-size pages, with a cache in front of it.
//
// Everything above this file thinks in pages. Nothing above this file opens a
// file, seeks, or counts bytes. That is the whole job.
//
// The cache is not an optimisation bolted on afterwards. A database reads the
// same handful of pages constantly — the top of an index, the page it is
// inserting into — so the cache is why a B-tree lookup costs one disk read
// instead of four.
//
// Once the write-ahead log is attached, this file stops writing to the database
// file at all. A page write becomes an append to the log, and the database file
// only catches up at a checkpoint. Reads have to know that: a page may live in
// the cache, or in the log, or in the file, in that order of freshness.

import { closeSync, existsSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import { ftruncateSync, readSync, writeSync } from 'node:fs';
import type { Wal } from './wal.ts';

// 4096 bytes, because that is the page size of the filesystem underneath us and
// of the memory manager underneath that. A 4 KiB write aligned to a 4 KiB
// boundary is one operation all the way down. Pick 5000 and every write straddles
// two of the operating system's pages and becomes two.
export const PAGE_SIZE = 4096;

// Pages held in memory. Small on purpose: a real one is set from a memory budget,
// and a small number here makes eviction visible in a five minute lecture.
export const DEFAULT_CAPACITY = 64;

export class Pager {
  readonly path: string;
  readonly capacity: number;

  /** Bytes handed to the filesystem. Counted, so the claim can be checked. */
  bytesWritten = 0;

  /** Bytes actually read off the disk. Cache hits do not count. */
  bytesRead = 0;

  hits = 0;
  misses = 0;
  evictions = 0;
  syncs = 0;

  /** The log, once one is attached. Until then every write goes to the file. */
  log: Wal | null = null;

  /** Whose writes these are. The log stamps every record with it. */
  txn = 0;

  // A Map iterates in insertion order, which is all an LRU queue is. Delete a key
  // and set it again and it moves to the back, so the front is always the least
  // recently used. No linked list to get wrong.
  private cache = new Map<number, Buffer>();
  private fd: number;

  // Pages that exist as far as the rest of the engine is concerned. Not the same
  // as the file's length once the log is attached: a page can be allocated,
  // written, and committed while the database file is still shorter than it.
  private known: number;

  constructor(path: string, capacity: number = DEFAULT_CAPACITY) {
    // r+ keeps what is already there. w+ creates. Opening an existing database
    // with w+ would truncate it, which is the step 1 bug wearing a new hat.
    this.path = path;
    this.capacity = capacity;
    this.fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
    this.known = Math.ceil(fstatSync(this.fd).size / PAGE_SIZE);
  }

  /** How many pages the database holds, whether or not the file has them yet. */
  get pageCount(): number {
    return this.known;
  }

  /** How long the database file itself is. Only recovery and the tools care. */
  get filePages(): number {
    return Math.ceil(fstatSync(this.fd).size / PAGE_SIZE);
  }

  readPage(n: number): Buffer {
    const cached = this.cache.get(n);
    if (cached) {
      this.hits++;
      this.touch(n, cached);
      return cached;
    }

    this.misses++;
    // The log is ahead of the file, so it is asked first. A page that was
    // committed since the last checkpoint is only there.
    const logged = this.log?.read(n) ?? null;
    if (logged) {
      this.touch(n, logged);
      return logged;
    }

    const page = Buffer.alloc(PAGE_SIZE);
    readSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesRead += PAGE_SIZE;
    this.touch(n, page);
    return page;
  }

  writePage(n: number, page: Buffer): void {
    if (page.length !== PAGE_SIZE) {
      throw new Error(`a page is ${PAGE_SIZE} bytes, got ${page.length}`);
    }
    if (n >= this.known) this.known = n + 1;

    if (this.log) {
      this.log.appendPage(this.txn, n, page);
    } else {
      writeSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
      this.bytesWritten += PAGE_SIZE;
    }
    // The copy in the cache would otherwise be stale, and a stale read is far
    // worse than a slow one: it is wrong, and nothing reports it.
    this.touch(n, Buffer.from(page));
  }

  /** Write straight past the log into the file. Checkpointing, and nothing else. */
  writeThrough(n: number, page: Buffer): void {
    writeSync(this.fd, page, 0, PAGE_SIZE, n * PAGE_SIZE);
    this.bytesWritten += PAGE_SIZE;
    if (n >= this.known) this.known = n + 1;
  }

  /**
   * Push everything the operating system is holding onto the actual disk.
   *
   * writeSync returns as soon as the bytes are in the kernel's page cache, which
   * is memory. The disk may not have them for another thirty seconds. fsync is
   * the call that waits, and it is the only reason a database can promise that a
   * committed row survives losing power.
   */
  sync(): void {
    fsyncSync(this.fd);
    this.syncs++;
  }

  /** Move a page to the back of the queue, evicting the front if we are full. */
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
    return this.known++;
  }

  /** Tell the pager the database is at least this many pages long. */
  observe(pages: number): void {
    if (pages > this.known) this.known = pages;
  }

  /** Throw away every cached page. Recovery uses this after rewriting the file. */
  forget(): void {
    this.cache.clear();
  }

  /** Cut the file back to n pages. Used by recovery, and by nothing else. */
  truncate(pages: number): void {
    ftruncateSync(this.fd, pages * PAGE_SIZE);
    this.known = pages;
    this.forget();
  }

  close(): void {
    closeSync(this.fd);
  }
}
