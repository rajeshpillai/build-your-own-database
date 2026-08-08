// The planner. A parsed query in, a plan out.
//
// The plan is a tree of operators, and each one pulls rows from the one below
// it. Nothing here runs — that is execute.ts. Keeping the two apart is what lets
// EXPLAIN exist at all: a plan you can print before you run it is a plan you can
// argue with.
//
// The decision this file exists to make is the access path. There are four ways
// to get rows out of a table and they differ by a factor of a thousand:
//
//   pk_lookup      the key, straight down the table's own tree
//   pk_range       a run of keys, down the tree once and then leaf to leaf
//   index_lookup   a second tree that maps a column value to keys
//   seq_scan       every page, in order, because nothing better was available
//
// The rule is deliberately simple and it is stated where the viewer can see it:
// use the most specific path the WHERE clause allows. finch does not have
// statistics, so it never weighs "this range matches half the table, a scan
// would be cheaper". That is the honest limit of a planner this size, and step
// 28 says so out loud.

import type { Database } from './db.ts';
import type { Comparison, Expr, SelectStatement } from './parser.ts';
import type { Value } from './schema.ts';

export type Plan =
  | { op: 'pk_lookup'; table: string; key: number }
  | { op: 'pk_range'; table: string; lo: number; hi: number }
  | {
      op: 'index_lookup';
      table: string;
      index: string;
      column: string;
      value: Value;
      recheck: boolean;
    }
  | { op: 'seq_scan'; table: string }
  | { op: 'filter'; input: Plan; where: Expr }
  | {
      op: 'nested_loop';
      outer: Plan;
      table: string;
      outerColumn: string;
      column: string;
    }
  | { op: 'project'; input: Plan; columns: string[] }
  | { op: 'limit'; input: Plan; n: number };

const KEY_MAX = 0xffffffff;

/** Every comparison joined by AND. An OR anywhere gives up and returns null. */
export function conjuncts(where: Expr | undefined): Comparison[] | null {
  if (!where) return [];
  if (where.kind === 'compare') return [where];
  if (where.kind === 'or') return null;
  const left = conjuncts(where.left);
  const right = conjuncts(where.right);
  return left && right ? [...left, ...right] : null;
}

export function planSelect(db: Database, statement: SelectStatement): Plan {
  const table = db.table(statement.from);
  const terms = conjuncts(statement.where);
  let plan = accessPath(db, statement.from, table.schema.key, terms);

  // Whatever the access path did not fully decide is re-checked per row. A
  // hashed index needs this even for the term it was chosen for, because a hash
  // shortlist can contain rows that do not match.
  if (statement.where && needsFilter(plan, table.schema.key, terms)) {
    plan = { op: 'filter', input: plan, where: statement.where };
  }

  if (statement.join) {
    plan = {
      op: 'nested_loop',
      outer: plan,
      table: statement.join.table,
      outerColumn: statement.join.leftColumn,
      column: statement.join.rightColumn,
    };
  }

  if (statement.columns.length) {
    plan = { op: 'project', input: plan, columns: statement.columns };
  }
  if (statement.limit !== undefined) {
    plan = { op: 'limit', input: plan, n: statement.limit };
  }
  return plan;
}

function accessPath(
  db: Database,
  table: string,
  key: string,
  terms: Comparison[] | null,
): Plan {
  if (!terms) return { op: 'seq_scan', table };

  // The key, exactly. One descent of the tree and one row.
  const exact = terms.find((t) => t.column === key && t.op === '=');
  if (exact && typeof exact.value === 'number') {
    return { op: 'pk_lookup', table, key: exact.value };
  }

  // A run of keys. The tree is walked once and the rest is the sibling chain,
  // which is what those four bytes in the page header were for.
  const range = keyRange(terms, key);
  if (range) return { op: 'pk_range', table, lo: range.lo, hi: range.hi };

  // A second tree. Only equality — a hashed index cannot answer a range at all,
  // and an int index could, which is a distinction not worth the code here.
  for (const term of terms) {
    if (term.op !== '=') continue;
    const index = db.indexOn(table, term.column);
    if (!index) continue;
    return {
      op: 'index_lookup',
      table,
      index: index.meta.name,
      column: term.column,
      value: term.value,
      recheck: index.meta.hashed,
    };
  }

  return { op: 'seq_scan', table };
}

type Range = { lo: number; hi: number };

function keyRange(terms: Comparison[], key: string): Range | null {
  let lo = 0;
  let hi = KEY_MAX;
  let found = false;

  for (const term of terms) {
    if (term.column !== key || typeof term.value !== 'number') continue;
    if (term.op === '>') { lo = Math.max(lo, term.value + 1); found = true; }
    if (term.op === '>=') { lo = Math.max(lo, term.value); found = true; }
    if (term.op === '<') { hi = Math.min(hi, term.value - 1); found = true; }
    if (term.op === '<=') { hi = Math.min(hi, term.value); found = true; }
  }
  return found ? { lo, hi } : null;
}

/**
 * Does the plan still owe the query a per-row check?
 *
 * A pk_lookup answered exactly one term. If the WHERE had two, the second one
 * still has to run. Getting this wrong returns rows that do not match, which no
 * test of the tree itself would ever catch.
 */
function needsFilter(plan: Plan, key: string, terms: Comparison[] | null): boolean {
  if (!terms) return true;
  if (plan.op === 'index_lookup') return plan.recheck || terms.length > 1;
  if (plan.op === 'pk_lookup') return terms.length > 1;
  // A range answered every term that named the key. Anything else still runs.
  if (plan.op === 'pk_range') return terms.some((t) => t.column !== key);
  return true;
}

/** The plan, as the lines EXPLAIN prints. Indented by depth, cheapest last. */
export function explain(plan: Plan, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  const line = (text: string) => `${pad}${depth ? '-> ' : ''}${text}`;

  switch (plan.op) {
    case 'pk_lookup':
      return [line(`pk lookup on ${plan.table}  key = ${plan.key}`)];
    case 'pk_range':
      return [line(`pk range on ${plan.table}  ${plan.lo} .. ${plan.hi}`)];
    case 'index_lookup':
      return [
        line(
          `index lookup ${plan.index}  ${plan.column} = ${show(plan.value)}` +
            (plan.recheck ? '  (hashed, rechecked)' : ''),
        ),
      ];
    case 'seq_scan':
      return [line(`seq scan on ${plan.table}`)];
    case 'filter':
      return [
        line(`filter  ${showExpr(plan.where)}`),
        ...explain(plan.input, depth + 1),
      ];
    case 'nested_loop':
      return [
        line(`nested loop  ${plan.outerColumn} = ${plan.table}.${plan.column}`),
        ...explain(plan.outer, depth + 1),
        `${'  '.repeat(depth + 1)}-> seq scan on ${plan.table}  (per outer row)`,
      ];
    case 'project':
      return [
        line(`project  ${plan.columns.join(', ')}`),
        ...explain(plan.input, depth + 1),
      ];
    case 'limit':
      return [line(`limit ${plan.n}`), ...explain(plan.input, depth + 1)];
  }
}

function show(value: Value): string {
  return typeof value === 'number' ? String(value) : `'${value}'`;
}

function showExpr(expr: Expr): string {
  if (expr.kind === 'compare') {
    return `${expr.column} ${expr.op} ${show(expr.value)}`;
  }
  const joiner = expr.kind.toUpperCase();
  return `${showExpr(expr.left)} ${joiner} ${showExpr(expr.right)}`;
}
