// The internal node. A leaf holds rows; an internal node holds nothing but
// signposts — n separator keys and the n+1 pages they separate.
//
//   child0 | key0 | child1 | key1 | child2      keys < key0 are in child0,
//                                               keys >= key1 are in child2
//
// Entries are fixed width, unlike rows, so there is no slot array and no
// indirection. An internal node is a plain sorted array of 4-byte numbers, and
// binary search over it is arithmetic on offsets.
//
// That is what makes the tree shallow. A row is about 33 bytes, so 113 fit on a
// page. A separator and a child pointer are 8, so 510 fit. The fanout of the
// levels above the leaves is nearly five times the fanout of the leaves
// themselves, and that ratio is why a B-tree is measured in three or four disk
// reads rather than twenty.

import { HEADER_SIZE, INTERNAL, initPage } from './page.ts';
import { PAGE_SIZE } from './pager.ts';

const COUNT_AT = 0; // reuses the slotted page's count field, as key count
const FIRST_CHILD = HEADER_SIZE;
const ENTRY_SIZE = 8; // uint32 key + uint32 child
const KEYS_AT = HEADER_SIZE + 4;

/** Separator keys one internal node can hold. */
export const MAX_KEYS = Math.floor((PAGE_SIZE - KEYS_AT) / ENTRY_SIZE);

export function initInternal(page: Buffer, firstChild: number): Buffer {
  initPage(page, INTERNAL);
  page.writeUInt32LE(firstChild, FIRST_CHILD);
  return page;
}

export function keyCount(page: Buffer): number {
  return page.readUInt16LE(COUNT_AT);
}

export function keyAtIndex(page: Buffer, i: number): number {
  return page.readUInt32LE(KEYS_AT + i * ENTRY_SIZE);
}

export function childAtIndex(page: Buffer, i: number): number {
  if (i === 0) return page.readUInt32LE(FIRST_CHILD);
  return page.readUInt32LE(KEYS_AT + (i - 1) * ENTRY_SIZE + 4);
}

export function isFull(page: Buffer): boolean {
  return keyCount(page) >= MAX_KEYS;
}

/**
 * Which child a key belongs in, and what it cost to work that out.
 *
 * The comparison count is returned because the claim of the whole section is a
 * number of disk reads, and a number nobody counts is a slogan.
 */
export function findChild(
  page: Buffer,
  key: number,
): { child: number; index: number; comparisons: number } {
  let lo = 0;
  let hi = keyCount(page) - 1;
  let comparisons = 0;
  let index = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    comparisons++;
    if (keyAtIndex(page, mid) <= key) {
      index = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { child: childAtIndex(page, index), index, comparisons };
}

/**
 * Add a separator and the page to its right, keeping the keys sorted.
 *
 * Called when a child splits: the child keeps its own page number and its low
 * keys, and this records where the new right-hand page starts.
 */
export function insertSeparator(
  page: Buffer,
  key: number,
  rightChild: number,
): boolean {
  if (isFull(page)) return false;

  const count = keyCount(page);
  let at = 0;
  while (at < count && keyAtIndex(page, at) < key) at++;

  const from = KEYS_AT + at * ENTRY_SIZE;
  const to = from + ENTRY_SIZE;
  page.copyWithin(to, from, KEYS_AT + count * ENTRY_SIZE);

  page.writeUInt32LE(key, from);
  page.writeUInt32LE(rightChild, from + 4);
  page.writeUInt16LE(count + 1, COUNT_AT);
  return true;
}

/**
 * Split a full internal node.
 *
 * The middle key does not stay in either half — it moves up to the parent. That
 * is the one place a B-tree differs from the obvious thing, and it is why a node
 * with n keys has n+1 children rather than n: the key that would have been the
 * right half's first separator is the one describing the boundary between the
 * halves, so it belongs above them.
 */
export function splitInternal(
  page: Buffer,
  right: Buffer,
): { separator: number } {
  const count = keyCount(page);
  const mid = count >> 1;
  const separator = keyAtIndex(page, mid);

  initInternal(right, childAtIndex(page, mid + 1));
  for (let i = mid + 1; i < count; i++) {
    insertSeparator(right, keyAtIndex(page, i), childAtIndex(page, i + 1));
  }

  page.writeUInt16LE(mid, COUNT_AT);
  return { separator };
}
