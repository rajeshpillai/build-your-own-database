// The B-tree. Rows in the leaves, signposts above them, and a height that
// barely moves as the table grows.
//
// A B-tree does not grow at the leaves. When the root fills it splits, and a NEW
// root is made above it — so the tree gets taller from the top, and every leaf
// stays exactly the same distance from the root. That is why a lookup costs the
// same wherever the row is, and it is the whole reason the structure earns its
// complexity.
//
// The root page number never changes for the life of a tree. Something above
// this file — the catalog, in db.ts — wrote that number down, and a root that
// moved would need its new home recorded somewhere that also had to be found
// first. When the root splits, its CONTENTS move to a fresh page and the root
// page itself becomes the new internal node.

import { firstAt, initPage, insertSorted, isLeaf, keyAt, LEAF } from './page.ts';
import { freeSpace, NO_SIBLING, newPage, nextLeaf } from './page.ts';
import { payloadAt, rowCount, search, setNextLeaf } from './page.ts';
import { childAtIndex, findChild, initInternal } from './inode.ts';
import { insertSeparator, isFull, keyCount, splitInternal } from './inode.ts';
import { PAGE_SIZE, type Pager } from './pager.ts';

/** What a child hands back when it had to split. */
type Split = { separator: number; right: number };

export class BTree {
  readonly pager: Pager;
  readonly root: number;

  /** Key comparisons made by the last lookup. */
  comparisons = 0;

  /**
   * Pages the last lookup had to visit — root, then down to the leaf.
   *
   * This is the structural number and it equals the height of the tree, whether
   * or not those pages happened to be in memory. Disk reads are counted
   * separately below, because a warm cache makes them zero and would hide the
   * only claim this section is making.
   */
  pagesTouched = 0;

  /** Of those, the ones that actually reached the disk. */
  pagesRead = 0;

  constructor(pager: Pager, root: number) {
    this.pager = pager;
    this.root = root;
  }

  /** Start a new tree at the next free page and return its root number. */
  static create(pager: Pager): number {
    const root = pager.allocate();
    pager.writePage(root, newPage(LEAF));
    return root;
  }

  private rootPage(): Buffer {
    return this.pager.readPage(this.root);
  }

  get height(): number {
    let h = 1;
    let page = this.rootPage();
    while (!isLeaf(page)) {
      h++;
      page = this.pager.readPage(childAtIndex(page, 0));
    }
    return h;
  }

  insert(payload: Buffer): void {
    const split = this.insertInto(this.root, payload);
    if (!split) return;

    // The root split, so the tree gains a level. This is the only moment in the
    // structure's life when its height changes.
    const oldRoot = this.pager.readPage(this.root);
    const movedTo = this.pager.allocate();
    this.pager.writePage(movedTo, oldRoot);

    const root = initInternal(Buffer.alloc(PAGE_SIZE), movedTo);
    insertSeparator(root, split.separator, split.right);
    this.pager.writePage(this.root, root);
  }

  private insertInto(pageNo: number, payload: Buffer): Split | null {
    const page = this.pager.readPage(pageNo);
    return isLeaf(page)
      ? this.insertIntoLeaf(pageNo, page, payload)
      : this.insertIntoInternal(pageNo, page, payload);
  }

  private insertIntoLeaf(no: number, page: Buffer, payload: Buffer): Split | null {
    if (insertSorted(page, payload) !== -1) {
      this.pager.writePage(no, page);
      return null;
    }
    return this.splitLeafPage(no, page, payload);
  }

  private insertIntoInternal(
    no: number,
    page: Buffer,
    payload: Buffer,
  ): Split | null {
    const key = payload.readUInt32LE(0);
    const child = findChild(page, key).child;
    const split = this.insertInto(child, payload);
    if (!split) return null;

    if (insertSeparator(page, split.separator, split.right)) {
      this.pager.writePage(no, page);
      return null;
    }

    // This node is full too, so the split carries one level further up. The
    // middle key moves up rather than staying in either half — see splitInternal.
    const right = Buffer.alloc(PAGE_SIZE);
    const { separator } = splitInternal(page, right);
    const rightNo = this.pager.allocate();

    if (split.separator < separator) {
      insertSeparator(page, split.separator, split.right);
    } else {
      insertSeparator(right, split.separator, split.right);
    }

    this.pager.writePage(no, page);
    this.pager.writePage(rightNo, right);
    return { separator, right: rightNo };
  }

  /**
   * Split a full leaf in half, then place the row that did not fit.
   *
   * The left half keeps its page number, so anything already pointing here still
   * points at a leaf holding the same low keys. The separator handed back is the
   * first key of the right half — the value the parent routes with.
   */
  private splitLeafPage(no: number, page: Buffer, payload: Buffer): Split {
    const rows: Buffer[] = [];
    for (let i = 0; i < rowCount(page); i++) {
      const p = payloadAt(page, i);
      if (p) rows.push(Buffer.from(p));
    }

    const half = Math.floor(rows.length / 2);
    const rightNo = this.pager.allocate();

    const left = newPage(LEAF);
    for (const r of rows.slice(0, half)) insertSorted(left, r);
    setNextLeaf(left, rightNo);

    const right = newPage(LEAF);
    for (const r of rows.slice(half)) insertSorted(right, r);
    setNextLeaf(right, nextLeaf(page));

    const key = payload.readUInt32LE(0);
    const separator = rows[half] ? rows[half]!.readUInt32LE(0) : key;
    if (key < separator) insertSorted(left, payload);
    else insertSorted(right, payload);

    this.pager.writePage(no, left);
    this.pager.writePage(rightNo, right);
    return { separator, right: rightNo };
  }

  /** Descend from the root to the leaf that would hold this key. */
  private descend(key: number): { no: number; page: Buffer; comparisons: number } {
    const before = this.pager.bytesRead;
    let comparisons = 0;
    let touched = 1;
    let no = this.root;
    let page = this.rootPage();

    while (!isLeaf(page)) {
      const step = findChild(page, key);
      comparisons += step.comparisons;
      no = step.child;
      page = this.pager.readPage(no);
      touched++;
    }

    this.pagesTouched = touched;
    this.pagesRead = (this.pager.bytesRead - before) / PAGE_SIZE;
    return { no, page, comparisons };
  }

  /** One row for this key, or null. Returns a copy — the page may move. */
  get(key: number): Buffer | null {
    const at = this.descend(key);
    const hit = search(at.page, key);
    this.comparisons = at.comparisons + hit.comparisons;
    if (!hit.found) return null;
    const payload = payloadAt(at.page, hit.slot);
    return payload ? Buffer.from(payload) : null;
  }

  /**
   * Every row for this key. Secondary indexes are full of duplicates, so this is
   * the operation they actually use.
   *
   * A run of equal keys can straddle a leaf boundary, so this follows the
   * sibling chain until the keys stop matching.
   */
  getAll(key: number): Buffer[] {
    const at = this.descend(key);
    const out: Buffer[] = [];
    let no = at.no;
    let page = at.page;
    let slot = firstAt(page, key);

    for (;;) {
      while (slot < rowCount(page)) {
        if (keyAt(page, slot) !== key) return out;
        const payload = payloadAt(page, slot);
        if (payload) out.push(Buffer.from(payload));
        slot++;
      }
      no = nextLeaf(page);
      if (no === NO_SIBLING) return out;
      page = this.pager.readPage(no);
      slot = 0;
    }
  }

  /**
   * Every row with a key from lo to hi, inclusive.
   *
   * This is where the sibling pointer earns its four bytes. The tree is walked
   * once to find the start, and everything after that is leaf to leaf.
   */
  range(lo: number, hi: number): Buffer[] {
    const at = this.descend(lo);
    const out: Buffer[] = [];
    let page = at.page;
    let slot = firstAt(page, lo);

    for (;;) {
      while (slot < rowCount(page)) {
        if (keyAt(page, slot) > hi) return out;
        const payload = payloadAt(page, slot);
        if (payload) out.push(Buffer.from(payload));
        slot++;
      }
      const next = nextLeaf(page);
      if (next === NO_SIBLING) return out;
      page = this.pager.readPage(next);
      slot = 0;
    }
  }

  /**
   * Change a row in place, through a callback that gets the bytes on the page.
   *
   * Used to stamp a row as deleted, which writes eight bytes and moves nothing.
   * Returns false if the key is not there.
   */
  edit(key: number, apply: (payload: Buffer) => boolean): boolean {
    const at = this.descend(key);
    let slot = firstAt(at.page, key);
    while (slot < rowCount(at.page) && keyAt(at.page, slot) === key) {
      const payload = payloadAt(at.page, slot);
      if (payload && apply(payload)) {
        this.pager.writePage(at.no, at.page);
        return true;
      }
      slot++;
    }
    return false;
  }

  /** The leftmost leaf, where a full-order walk starts. */
  private firstLeaf(): number {
    let no = this.root;
    let page = this.rootPage();
    while (!isLeaf(page)) {
      no = childAtIndex(page, 0);
      page = this.pager.readPage(no);
    }
    return no;
  }

  /** Every row, in key order, along the sibling chain rather than the tree. */
  walk(): Buffer[] {
    const out: Buffer[] = [];
    let no = this.firstLeaf();
    while (no !== NO_SIBLING) {
      const page = this.pager.readPage(no);
      for (let i = 0; i < rowCount(page); i++) {
        const p = payloadAt(page, i);
        if (p) out.push(Buffer.from(p));
      }
      no = nextLeaf(page);
    }
    return out;
  }

  /** Leaves, internal nodes, and separators in the root. */
  shape(): { height: number; leaves: number; internals: number; rootKeys: number } {
    let leaves = 0;
    let internals = 0;
    const seen = this.pages();
    for (const no of seen) {
      if (isLeaf(this.pager.readPage(no))) leaves++;
      else internals++;
    }
    const root = this.rootPage();
    return {
      height: this.height,
      leaves,
      internals,
      rootKeys: isLeaf(root) ? 0 : keyCount(root),
    };
  }

  /** Every page belonging to this tree, walked from the root. */
  pages(): number[] {
    const out: number[] = [];
    const stack = [this.root];
    while (stack.length) {
      const no = stack.pop()!;
      out.push(no);
      const page = this.pager.readPage(no);
      if (isLeaf(page)) continue;
      for (let i = 0; i <= keyCount(page); i++) stack.push(childAtIndex(page, i));
    }
    return out;
  }

  /** Rows and free bytes on one page, for the split figures. */
  leafStats(no: number): { rows: number; free: number; first: number } {
    const page = this.pager.readPage(no);
    return {
      rows: rowCount(page),
      free: freeSpace(page),
      first: rowCount(page) > 0 ? keyAt(page, 0) : -1,
    };
  }

  rootIsFull(): boolean {
    const root = this.rootPage();
    return isLeaf(root) ? false : isFull(root);
  }
}
