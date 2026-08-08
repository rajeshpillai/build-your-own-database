// The slotted page. One 4 KiB page, holding many rows of different sizes.
//
// Two things grow toward each other from the ends of the page:
//
//   +--------+------------------+   free   +----------------------------+
//   | header | slot0 slot1 slot2| ------>  <------ row2   row1     row0 |
//   +--------+------------------+          +----------------------------+
//   0        10                                                     4096
//
// Slots grow forward from the header, rows grow backward from the end, and the
// page is full when they meet.
//
// The point of the indirection is that slot i always lives at a computable
// address, so "give me row 3 of this page" is arithmetic rather than a search —
// while the row itself can sit anywhere and be any size. Deleting a row must not
// move the rows after it, and this is what makes that possible.
//
// This file knows nothing about columns. A row here is a run of bytes whose
// first four are its key. That is the whole contract, and it is what lets one
// page implementation hold every table in the database.

import { PAGE_SIZE } from './pager.ts';

// The header:
//
//   0  uint16  slots in use
//   2  uint16  where the row data starts
//   4  uint8   node type: leaf or internal
//   5  uint8   reserved, so the page number below is 4-byte aligned
//   6  uint32  next leaf to the right, or NO_SIBLING
//
// The sibling pointer is what makes a range query cheap. Having found the first
// matching row through the tree, the rest are read by following leaf to leaf,
// never touching an internal node again.
const COUNT_AT = 0;
const FREE_AT = 2;
const TYPE_AT = 4;
const NEXT_AT = 6;
export const HEADER_SIZE = 10;

export const LEAF = 0;
export const INTERNAL = 1;
export const NO_SIBLING = 0xffffffff;
export const SLOT_SIZE = 4; // uint16 offset + uint16 length

// A length of zero in a slot means the row is deleted. No real row can be zero
// bytes — the header alone is twelve — so the value is free to mean something
// else.
const TOMBSTONE = 0;

export function initPage(page: Buffer, type: number = LEAF): Buffer {
  page.fill(0);
  page.writeUInt16LE(0, COUNT_AT);
  page.writeUInt16LE(PAGE_SIZE, FREE_AT);
  page.writeUInt8(type, TYPE_AT);
  page.writeUInt32LE(NO_SIBLING, NEXT_AT);
  return page;
}

export function newPage(type: number = LEAF): Buffer {
  return initPage(Buffer.alloc(PAGE_SIZE), type);
}

export function nodeType(page: Buffer): number {
  return page.readUInt8(TYPE_AT);
}

export function isLeaf(page: Buffer): boolean {
  return nodeType(page) === LEAF;
}

/** The leaf to the right of this one, or NO_SIBLING at the end of the chain. */
export function nextLeaf(page: Buffer): number {
  return page.readUInt32LE(NEXT_AT);
}

export function setNextLeaf(page: Buffer, next: number): void {
  page.writeUInt32LE(next, NEXT_AT);
}

/** Slots on this page, live or dead. */
export function rowCount(page: Buffer): number {
  return page.readUInt16LE(COUNT_AT);
}

/** Bytes still available for one more row AND its slot. */
export function freeSpace(page: Buffer): number {
  const slotsEnd = HEADER_SIZE + rowCount(page) * SLOT_SIZE;
  return page.readUInt16LE(FREE_AT) - slotsEnd;
}

/**
 * Append a row's bytes. Returns its slot number, or -1 if it does not fit.
 *
 * Returning -1 rather than throwing is deliberate: a full page is the normal
 * course of events, not an error, and the layer above is entirely about what to
 * do next.
 */
export function insert(page: Buffer, payload: Buffer): number {
  if (freeSpace(page) < payload.length + SLOT_SIZE) return -1;

  const count = rowCount(page);
  const start = page.readUInt16LE(FREE_AT) - payload.length;
  payload.copy(page, start);

  const slot = HEADER_SIZE + count * SLOT_SIZE;
  page.writeUInt16LE(start, slot);
  page.writeUInt16LE(payload.length, slot + 2);

  page.writeUInt16LE(start, FREE_AT);
  page.writeUInt16LE(count + 1, COUNT_AT);
  return count;
}

/**
 * The bytes of one row, as a VIEW into the page — not a copy.
 *
 * Writing through it writes the page, which is exactly what stamping a row as
 * deleted needs. Anything that wants to keep the bytes must copy them, because
 * the next compaction will move what is underneath.
 */
export function payloadAt(page: Buffer, slot: number): Buffer | null {
  if (slot < 0 || slot >= rowCount(page)) return null;
  const at = HEADER_SIZE + slot * SLOT_SIZE;
  const length = page.readUInt16LE(at + 2);
  if (length === TOMBSTONE) return null;
  const from = page.readUInt16LE(at);
  return page.subarray(from, from + length);
}

// Deleting a row does not move a byte of it.
//
// The slot's length is set to zero and nothing else happens. The row's bytes stay
// exactly where they were, and the free space on the page does not go up.
//
// That sounds like a bug and is a deliberate trade. The alternative is to shuffle
// the surviving rows down to close the gap, and the moment a row moves, its slot
// has to change — which invalidates every row id pointing at it, in every index.
// Deletion is the common operation. Paying for it on every delete to save space
// nobody has asked for yet is the wrong trade. Space is reclaimed later, in bulk,
// by compact().
export function remove(page: Buffer, slot: number): boolean {
  if (slot < 0 || slot >= rowCount(page)) return false;
  const at = HEADER_SIZE + slot * SLOT_SIZE;
  if (page.readUInt16LE(at + 2) === TOMBSTONE) return false;
  page.writeUInt16LE(TOMBSTONE, at + 2);
  return true;
}

/** Slots that still hold a row. rowCount() counts slots, live or dead. */
export function liveCount(page: Buffer): number {
  let live = 0;
  for (let i = 0; i < rowCount(page); i++) {
    const at = HEADER_SIZE + i * SLOT_SIZE;
    if (page.readUInt16LE(at + 2) !== TOMBSTONE) live++;
  }
  return live;
}

/** Bytes still occupied by rows nobody can reach. */
export function deadBytes(page: Buffer): number {
  let dead = 0;
  for (let i = 0; i < rowCount(page); i++) {
    const at = HEADER_SIZE + i * SLOT_SIZE;
    if (page.readUInt16LE(at + 2) === TOMBSTONE) dead += lengthWas(page, i);
  }
  return dead;
}

// A tombstone keeps its offset, and the row after it in the page tells us where
// this one ended. Rows are laid out downward from the end, so the row before it
// in slot terms is the one at a higher address.
function lengthWas(page: Buffer, slot: number): number {
  const at = HEADER_SIZE + slot * SLOT_SIZE;
  const from = page.readUInt16LE(at);
  let end = PAGE_SIZE;
  for (let i = 0; i < rowCount(page); i++) {
    const other = page.readUInt16LE(HEADER_SIZE + i * SLOT_SIZE);
    if (other > from && other < end) end = other;
  }
  return end - from;
}

/**
 * Rebuild the page with the dead rows gone. Returns the new slot of each
 * surviving row, keyed by its old slot.
 *
 * This is what a VACUUM does, and the return value is why it is not free: rows
 * move, so row ids change, so anything that stored one has to be told. That is
 * why compaction is a maintenance job and not something that happens on the way
 * out of a DELETE.
 */
export function compact(page: Buffer): Map<number, number> {
  const survivors: Array<[number, Buffer]> = [];
  for (let i = 0; i < rowCount(page); i++) {
    const payload = payloadAt(page, i);
    if (payload) survivors.push([i, Buffer.from(payload)]);
  }

  const type = nodeType(page);
  const next = nextLeaf(page);
  initPage(page, type);
  setNextLeaf(page, next);

  const moved = new Map<number, number>();
  for (const [was, payload] of survivors) moved.set(was, insert(page, payload));
  return moved;
}

// The key of a row, without decoding the row.
//
// A slot points at the row's first four bytes, which are its key, so answering
// "what key is in slot 7" reads four bytes and touches nothing else. A search
// compares keys thousands of times and materialises exactly one row.
export function keyAt(page: Buffer, slot: number): number {
  const at = HEADER_SIZE + slot * SLOT_SIZE;
  return page.readUInt32LE(page.readUInt16LE(at));
}

/**
 * Binary search the slots for a key.
 *
 * Returns where it is, or where it would go. `comparisons` is returned because
 * the claim of that step is a number — seven instead of a hundred and thirteen —
 * and a claim nobody counts is a slogan.
 *
 * With duplicate keys this lands on one of them, not necessarily the first, so
 * anything wanting all of them walks left and right from here. Secondary indexes
 * are full of duplicates and rely on that.
 */
export function search(
  page: Buffer,
  key: number,
): { slot: number; found: boolean; comparisons: number } {
  let lo = 0;
  let hi = rowCount(page) - 1;
  let comparisons = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keyAt(page, mid);
    comparisons++;
    if (k === key) return { slot: mid, found: true, comparisons };
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return { slot: lo, found: false, comparisons };
}

/** The first slot holding this key, for a page that may hold several. */
export function firstAt(page: Buffer, key: number): number {
  const hit = search(page, key);
  if (!hit.found) return hit.slot;
  let slot = hit.slot;
  while (slot > 0 && keyAt(page, slot - 1) === key) slot--;
  return slot;
}

/**
 * Insert keeping the slots in key order.
 *
 * The row's bytes still go wherever there is room. Nothing is sorted on the page
 * itself — only the slot array is kept in order, and only slots move, four bytes
 * at a time. Sorting the rows would mean moving hundreds of bytes per insert.
 */
export function insertSorted(page: Buffer, payload: Buffer): number {
  if (freeSpace(page) < payload.length + SLOT_SIZE) return -1;

  const count = rowCount(page);
  const key = payload.readUInt32LE(0);
  // Duplicates go after their equals, so a page keeps insertion order within a
  // key. Without this, re-inserting the same key reverses the run every time.
  let at = search(page, key).slot;
  while (at < count && keyAt(page, at) <= key) at++;

  const from = HEADER_SIZE + at * SLOT_SIZE;
  const to = HEADER_SIZE + (at + 1) * SLOT_SIZE;
  page.copyWithin(to, from, HEADER_SIZE + count * SLOT_SIZE);

  const start = page.readUInt16LE(FREE_AT) - payload.length;
  payload.copy(page, start);
  page.writeUInt16LE(start, from);
  page.writeUInt16LE(payload.length, from + 2);

  page.writeUInt16LE(start, FREE_AT);
  page.writeUInt16LE(count + 1, COUNT_AT);
  return at;
}

/** Every live row on the page, in slot order, as views. */
export function payloads(page: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < rowCount(page); i++) {
    const payload = payloadAt(page, i);
    if (payload) out.push(payload);
  }
  return out;
}

/** Bytes of this page that are actual row data, for the occupancy figure. */
export function usedBytes(page: Buffer): number {
  return PAGE_SIZE - page.readUInt16LE(FREE_AT);
}
