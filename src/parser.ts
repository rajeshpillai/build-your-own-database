// The parser. Tokens in, a tree out.
//
// The tree is the point. A query is text, and text is a terrible thing to make
// decisions about — every question the planner wants to ask ("is there a WHERE
// on an indexed column?") is one line against a tree and a mess against a
// string.
//
// This is a recursive descent parser, which means the shape of the code is the
// shape of the grammar. `parseSelect` reads exactly what a SELECT contains, in
// the order it contains it. Nothing generates anything.
//
// finch understands a small dialect on purpose:
//
//   CREATE TABLE users (id int, name text, age int)
//   CREATE INDEX ON users (age)
//   INSERT INTO users VALUES (1, 'ada', 36)
//   SELECT * FROM users WHERE age >= 30 AND name = 'ada' LIMIT 5
//   SELECT users.name, orders.total FROM users
//     JOIN orders ON users.id = orders.owner
//   UPDATE users SET age = 37 WHERE id = 1
//   DELETE FROM users WHERE id = 1

import { SyntaxError, tokenise, type Token } from './tokeniser.ts';
import type { Column, ColumnType, Value } from './schema.ts';

export type Comparison = {
  kind: 'compare';
  column: string;
  op: string;
  value: Value;
};
export type Conjunction = { kind: 'and' | 'or'; left: Expr; right: Expr };
export type Expr = Comparison | Conjunction;

export type Join = { table: string; leftColumn: string; rightColumn: string };

export type SelectStatement = {
  kind: 'select';
  columns: string[]; // empty means *
  from: string;
  join?: Join;
  where?: Expr;
  limit?: number;
};

export type InsertStatement = {
  kind: 'insert';
  table: string;
  columns: string[];
  values: Value[];
};

export type UpdateStatement = {
  kind: 'update';
  table: string;
  set: Array<[string, Value]>;
  where?: Expr;
};

export type DeleteStatement = { kind: 'delete'; table: string; where?: Expr };
export type CreateTableStatement = {
  kind: 'create_table';
  table: string;
  columns: Column[];
};
export type CreateIndexStatement = {
  kind: 'create_index';
  table: string;
  column: string;
};
export type ExplainStatement = { kind: 'explain'; statement: Statement };

export type Statement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | CreateTableStatement
  | CreateIndexStatement
  | ExplainStatement;

const COMPARISONS = ['=', '!=', '<', '<=', '>', '>='];

export function parse(sql: string): Statement {
  return new Parser(tokenise(sql)).statement();
}

class Parser {
  private tokens: Token[];
  private i = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  statement(): Statement {
    const statement = this.oneStatement();
    this.skipIf(';');
    this.expectEnd();
    return statement;
  }

  private oneStatement(): Statement {
    if (this.matchWord('explain')) {
      return { kind: 'explain', statement: this.oneStatement() };
    }
    if (this.matchWord('select')) return this.select();
    if (this.matchWord('insert')) return this.insert();
    if (this.matchWord('update')) return this.update();
    if (this.matchWord('delete')) return this.remove();
    if (this.matchWord('create')) return this.create();
    throw this.fail(
      'a statement starts with select, insert, update, delete or create',
    );
  }

  // ── statements ────────────────────────────────────────────────────────────

  private select(): SelectStatement {
    const columns: string[] = [];
    if (!this.matchSymbol('*')) {
      do {
        columns.push(this.qualifiedName());
      } while (this.matchSymbol(','));
    }

    this.expectWord('from');
    const from = this.name();

    let join: Join | undefined;
    if (this.matchWord('join')) {
      const table = this.name();
      this.expectWord('on');
      const left = this.qualifiedName();
      this.expectSymbol('=');
      const right = this.qualifiedName();
      // Written either way round. The planner drives the join from the outer
      // table, so which side is which has to be settled here rather than there.
      const leftIsOuter = left.startsWith(`${from}.`);
      join = {
        table,
        leftColumn: bare(leftIsOuter ? left : right),
        rightColumn: bare(leftIsOuter ? right : left),
      };
    }

    const where = this.matchWord('where') ? this.expression() : undefined;
    const limit = this.matchWord('limit') ? this.integer() : undefined;
    return { kind: 'select', columns, from, join, where, limit };
  }

  private insert(): InsertStatement {
    this.expectWord('into');
    const table = this.name();

    const columns: string[] = [];
    if (this.matchSymbol('(')) {
      do {
        columns.push(this.name());
      } while (this.matchSymbol(','));
      this.expectSymbol(')');
    }

    this.expectWord('values');
    this.expectSymbol('(');
    const values: Value[] = [];
    do {
      values.push(this.literal());
    } while (this.matchSymbol(','));
    this.expectSymbol(')');

    return { kind: 'insert', table, columns, values };
  }

  private update(): UpdateStatement {
    const table = this.name();
    this.expectWord('set');
    const set: Array<[string, Value]> = [];
    do {
      const column = this.name();
      this.expectSymbol('=');
      set.push([column, this.literal()]);
    } while (this.matchSymbol(','));

    const where = this.matchWord('where') ? this.expression() : undefined;
    return { kind: 'update', table, set, where };
  }

  private remove(): DeleteStatement {
    this.expectWord('from');
    const table = this.name();
    const where = this.matchWord('where') ? this.expression() : undefined;
    return { kind: 'delete', table, where };
  }

  private create(): Statement {
    if (this.matchWord('table')) {
      const table = this.name();
      this.expectSymbol('(');
      const columns: Column[] = [];
      do {
        const name = this.name();
        const type = this.name().toLowerCase();
        if (type !== 'int' && type !== 'text') {
          throw this.fail(`a column is int or text, not ${type}`);
        }
        columns.push({ name, type: type as ColumnType });
      } while (this.matchSymbol(','));
      this.expectSymbol(')');
      return { kind: 'create_table', table, columns };
    }

    this.expectWord('index');
    this.expectWord('on');
    const table = this.name();
    this.expectSymbol('(');
    const column = this.name();
    this.expectSymbol(')');
    return { kind: 'create_index', table, column };
  }

  // ── expressions ───────────────────────────────────────────────────────────
  //
  // OR binds loosest, then AND, then a comparison. Two levels of function call
  // is the whole of precedence, and getting the order wrong here makes
  // `a = 1 OR b = 2 AND c = 3` mean something the person did not type.

  private expression(): Expr {
    let left = this.conjunction();
    while (this.matchWord('or')) {
      left = { kind: 'or', left, right: this.conjunction() };
    }
    return left;
  }

  private conjunction(): Expr {
    let left = this.comparison();
    while (this.matchWord('and')) {
      left = { kind: 'and', left, right: this.comparison() };
    }
    return left;
  }

  private comparison(): Expr {
    if (this.matchSymbol('(')) {
      const inner = this.expression();
      this.expectSymbol(')');
      return inner;
    }
    const column = bare(this.qualifiedName());
    const op = this.peek().text;
    if (this.peek().kind !== 'symbol' || !COMPARISONS.includes(op)) {
      throw this.fail(`expected a comparison after ${column}`);
    }
    this.i++;
    return { kind: 'compare', column, op, value: this.literal() };
  }

  // ── pieces ────────────────────────────────────────────────────────────────

  private literal(): Value {
    const token = this.peek();
    if (token.kind === 'number') {
      this.i++;
      return Number(token.text);
    }
    if (token.kind === 'string') {
      this.i++;
      return token.text;
    }
    if (token.kind === 'symbol' && token.text === '-') {
      this.i++;
      return -this.integer();
    }
    throw this.fail('expected a number or a quoted string');
  }

  private integer(): number {
    const token = this.peek();
    if (token.kind !== 'number') throw this.fail('expected a whole number');
    this.i++;
    return Number(token.text);
  }

  private name(): string {
    const token = this.peek();
    if (token.kind !== 'word') throw this.fail('expected a name');
    this.i++;
    return token.text;
  }

  private qualifiedName(): string {
    let name = this.name();
    if (this.matchSymbol('.')) name += `.${this.name()}`;
    return name;
  }

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private matchWord(word: string): boolean {
    const token = this.peek();
    if (token.kind === 'word' && token.text.toLowerCase() === word) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectWord(word: string): void {
    if (!this.matchWord(word)) throw this.fail(`expected ${word}`);
  }

  private matchSymbol(symbol: string): boolean {
    const token = this.peek();
    if (token.kind === 'symbol' && token.text === symbol) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectSymbol(symbol: string): void {
    if (!this.matchSymbol(symbol)) throw this.fail(`expected ${symbol}`);
  }

  private skipIf(symbol: string): void {
    this.matchSymbol(symbol);
  }

  private expectEnd(): void {
    if (this.peek().kind !== 'end') {
      throw this.fail('there is more here than I can read');
    }
  }

  private fail(message: string): SyntaxError {
    const token = this.peek();
    const saw = token.kind === 'end' ? 'the end of the query' : `"${token.text}"`;
    return new SyntaxError(`${message}, and found ${saw}`, token.at);
  }
}

/** `users.name` names a column, and the column itself is called `name`. */
export function bare(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/** The table part of `users.name`, or undefined for a bare column. */
export function qualifier(name: string): string | undefined {
  const dot = name.indexOf('.');
  return dot === -1 ? undefined : name.slice(0, dot);
}
