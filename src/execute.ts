// The executor. A plan in, rows out.
//
// Every operator is a generator, so a row is pulled through the whole tree
// before the next one starts. That is not a style choice: `LIMIT 5` on a table
// of a million rows has to stop after five, and it can only stop if nothing
// below it has already built the other 999,995.
//
// `examined` is the number this course cares about. It counts rows the executor
// actually looked at, which is the difference between an index and a scan
// stated as a number rather than as a feeling.

import { Database } from './db.ts';
import { parse } from './parser.ts';
import type { Expr, Statement } from './parser.ts';
import { explain, planSelect, type Plan } from './plan.ts';
import type { Row, Value } from './schema.ts';

export type Result = {
  columns: string[];
  rows: Row[];
  message?: string;
  examined: number;
  plan?: string[];
};

export class Executor {
  readonly db: Database;

  /** Rows the last statement looked at, whether or not it returned them. */
  examined = 0;

  constructor(db: Database) {
    this.db = db;
  }

  run(sql: string): Result {
    return this.statement(parse(sql));
  }

  statement(statement: Statement): Result {
    this.examined = 0;

    switch (statement.kind) {
      case 'explain': {
        const inner = statement.statement;
        if (inner.kind !== 'select') {
          throw new Error('finch only explains a select');
        }
        return {
          columns: ['plan'],
          rows: [],
          examined: 0,
          plan: explain(planSelect(this.db, inner)),
        };
      }

      case 'select': {
        const plan = planSelect(this.db, statement);
        const rows = [...this.rows(plan)];
        return {
          columns: statement.columns.length
            ? statement.columns
            : this.db.table(statement.from).schema.columns.map((c) => c.name),
          rows,
          examined: this.examined,
          plan: explain(plan),
        };
      }

      case 'create_table':
        this.db.createTable(statement.table, statement.columns);
        return this.ok(`table ${statement.table} created`);

      case 'create_index':
        this.db.createIndex(statement.table, statement.column);
        return this.ok(`index on ${statement.table}.${statement.column} created`);

      case 'insert': {
        const schema = this.db.table(statement.table).schema;
        const names = statement.columns.length
          ? statement.columns
          : schema.columns.map((c) => c.name);
        if (names.length !== statement.values.length) {
          throw new Error(
            `${names.length} columns and ${statement.values.length} values`,
          );
        }
        const row: Row = {};
        names.forEach((name, i) => {
          row[name] = statement.values[i] as Value;
        });
        this.db.insert(statement.table, row);
        return this.ok('1 row inserted');
      }

      case 'update': {
        const changes: Row = {};
        for (const [column, value] of statement.set) changes[column] = value;
        let changed = 0;
        for (const key of this.keysMatching(statement.table, statement.where)) {
          if (this.db.update(statement.table, key, changes)) changed++;
        }
        return this.ok(`${changed} row${changed === 1 ? '' : 's'} updated`);
      }

      case 'delete': {
        let removed = 0;
        for (const key of this.keysMatching(statement.table, statement.where)) {
          if (this.db.delete(statement.table, key)) removed++;
        }
        return this.ok(`${removed} row${removed === 1 ? '' : 's'} deleted`);
      }
    }
  }

  private ok(message: string): Result {
    return { columns: [], rows: [], message, examined: this.examined };
  }

  /**
   * The keys an UPDATE or a DELETE is going to touch, collected before anything
   * is written.
   *
   * Collecting first matters. Both of those write a new version of the row, and
   * a walk that is still running while rows are being added to the tree
   * underneath it will happily find the rows it just wrote and rewrite them
   * again, forever.
   */
  private keysMatching(table: string, where: Expr | undefined): number[] {
    const schema = this.db.table(table).schema;
    const plan = planSelect(this.db, {
      kind: 'select',
      columns: [],
      from: table,
      where,
    });
    return [...this.rows(plan)].map((row) => row[schema.key] as number);
  }

  // ── the operators ─────────────────────────────────────────────────────────

  private *rows(plan: Plan): Generator<Row> {
    switch (plan.op) {
      case 'pk_lookup': {
        const row = this.db.get(plan.table, plan.key);
        this.examined += row ? 1 : 0;
        if (row) yield row;
        return;
      }

      case 'pk_range': {
        for (const row of this.db.keysBetween(plan.table, plan.lo, plan.hi)) {
          this.examined++;
          yield row;
        }
        return;
      }

      case 'index_lookup': {
        const index = this.db.indexOn(plan.table, plan.column)!;
        for (const key of this.db.candidates(index, plan.value)) {
          const row = this.db.get(plan.table, key);
          if (!row) continue;
          this.examined++;
          yield row;
        }
        return;
      }

      case 'seq_scan':
        for (const row of this.db.rows(plan.table)) {
          this.examined++;
          yield row;
        }
        return;

      case 'filter':
        for (const row of this.rows(plan.input)) {
          if (matches(row, plan.where)) yield row;
        }
        return;

      case 'nested_loop': {
        // The inner table is scanned once per outer row. That is the whole
        // shape of the cost, and it is why a join without an index on the
        // joining column is the slowest thing in this engine.
        for (const outer of this.rows(plan.outer)) {
          const value = outer[plan.outerColumn];
          if (value === undefined) continue;
          const index = this.db.indexOn(plan.table, plan.column);
          const inner = index
            ? this.db
                .candidates(index, value)
                .map((key) => this.db.get(plan.table, key))
            : [...this.db.rows(plan.table)];

          for (const row of inner) {
            if (!row) continue;
            this.examined++;
            if (row[plan.column] !== value) continue;
            yield join(outer, row, plan.table);
          }
        }
        return;
      }

      case 'project':
        for (const row of this.rows(plan.input)) {
          const out: Row = {};
          for (const name of plan.columns) {
            const value = row[name] ?? row[bareName(name)];
            if (value !== undefined) out[name] = value;
          }
          yield out;
        }
        return;

      case 'limit': {
        // Count AFTER yielding, not before. Checking first pulls one more row
        // out of the operator below than the query asked for — which is
        // invisible in the result and shows up as an examined count of four for
        // `LIMIT 3`. On a scan of a million rows that extra pull is a page read.
        if (plan.n <= 0) return;
        let taken = 0;
        for (const row of this.rows(plan.input)) {
          yield row;
          if (++taken >= plan.n) return;
        }
        return;
      }
    }
  }
}

/** A joined row carries both tables' columns, qualified so neither is lost. */
function join(outer: Row, inner: Row, table: string): Row {
  const out: Row = { ...outer };
  for (const [name, value] of Object.entries(inner)) {
    out[`${table}.${name}`] = value;
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function bareName(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

export function matches(row: Row, where: Expr): boolean {
  if (where.kind !== 'compare') {
    const left = matches(row, where.left);
    return where.kind === 'and' ? left && matches(row, where.right)
                                : left || matches(row, where.right);
  }

  const value = row[where.column] ?? row[bareName(where.column)];
  if (value === undefined) return false;

  switch (where.op) {
    case '=': return value === where.value;
    case '!=': return value !== where.value;
    case '<': return value < where.value;
    case '<=': return value <= where.value;
    case '>': return value > where.value;
    case '>=': return value >= where.value;
    default: return false;
  }
}
