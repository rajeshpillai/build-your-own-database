// The tokeniser. Text in, a flat list of tokens out.
//
// This is the smallest piece of a query language and the one people skip. It is
// worth writing because every confusing parser error starts here: a parser can
// only be as clear as the pieces it was handed.
//
// One pass, one character of lookahead, no regular expressions. A regex-based
// lexer is shorter and it is also where the string-with-an-escaped-quote bug
// lives, so this walks the characters and stays boring.

export type TokenKind = 'word' | 'number' | 'string' | 'symbol' | 'end';

export type Token = {
  kind: TokenKind;
  text: string;
  /** Where it started, so an error can point at the character that caused it. */
  at: number;
};

// Two-character operators have to be tried before one-character ones, or `>=`
// lexes as `>` followed by `=` and the parser reports something baffling.
const DOUBLES = ['>=', '<=', '!=', '<>'];
const SINGLES = '()*,.;=<>+-';

export class SyntaxError extends Error {
  readonly at: number;

  constructor(message: string, at: number) {
    super(message);
    this.name = 'SyntaxError';
    this.at = at;
  }
}

export function tokenise(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // A comment runs to the end of the line. Two dashes, like SQL, not two
    // slashes — this language is not JavaScript and should not look like it.
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    if (isDigit(c)) {
      const start = i;
      while (i < sql.length && isDigit(sql[i]!)) i++;
      out.push({ kind: 'number', text: sql.slice(start, i), at: start });
      continue;
    }

    if (isWordStart(c)) {
      const start = i;
      while (i < sql.length && isWordPart(sql[i]!)) i++;
      out.push({ kind: 'word', text: sql.slice(start, i), at: start });
      continue;
    }

    if (c === "'") {
      const start = i;
      i++;
      let text = '';
      for (;;) {
        if (i >= sql.length) {
          throw new SyntaxError('a string starts here and never ends', start);
        }
        // Two quotes in a row are one quote, which is how SQL escapes them.
        // Miss this and every name with an apostrophe ends the string early.
        if (sql[i] === "'" && sql[i + 1] === "'") {
          text += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        text += sql[i];
        i++;
      }
      out.push({ kind: 'string', text, at: start });
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (DOUBLES.includes(two)) {
      out.push({ kind: 'symbol', text: two === '<>' ? '!=' : two, at: i });
      i += 2;
      continue;
    }

    if (SINGLES.includes(c)) {
      out.push({ kind: 'symbol', text: c, at: i });
      i++;
      continue;
    }

    throw new SyntaxError(`I do not know what to do with ${JSON.stringify(c)}`, i);
  }

  out.push({ kind: 'end', text: '', at: sql.length });
  return out;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isWordStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isWordPart(c: string): boolean {
  return isWordStart(c) || isDigit(c);
}
