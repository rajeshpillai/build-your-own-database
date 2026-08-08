# finch — the finished engine

This is the **reference branch** of *Build Your Own Database*. It holds the whole
engine, working: a pager, a slotted page, a B-tree, a write-ahead log, a small
SQL dialect, a query planner, and transactions.

If you are following the course, you probably want the **`main`** branch instead.
There the same code arrives one step at a time, one commit and one tag per
lecture, and each step runs on its own. This branch is the ending.

## Running it

Node 22.18 or newer. **Nothing to install, and no build step.**

```bash
git clone -b feat/reference https://github.com/rajeshpillai/build-your-own-database
cd build-your-own-database
node main.ts demo        # a scripted tour
node main.ts             # a shell — type SQL at it
./verify.sh              # every claim in here, checked
```

Node strips the types and runs the file directly, so what you read is exactly
what executes. `npm install` is only needed to run the type checker.

## The shell

```
finch> CREATE TABLE users (id int, name text, age int)
finch> INSERT INTO users VALUES (1, 'ada', 36)
finch> SELECT * FROM users WHERE id = 1
finch> CREATE INDEX ON users (age)
finch> EXPLAIN SELECT * FROM users WHERE age = 36
finch> .tables    .schema    .checkpoint    .exit
```

The dialect is small on purpose: `CREATE TABLE`, `CREATE INDEX`, `INSERT`,
`SELECT` with `WHERE`, `LIMIT` and one `JOIN`, `UPDATE`, `DELETE`, and `EXPLAIN`.
Columns are `int` or `text`. There is no `NULL`, and that is a real
simplification — `NULL` turns every comparison into three-valued logic and
changes the meaning of every operator above it.

## What is in here

| File | What it is |
|---|---|
| `src/pager.ts` | The file, cut into 4 KiB pages, with an LRU cache in front |
| `src/page.ts` | The slotted page. Slots grow forward, rows grow backward |
| `src/schema.ts` | A table's columns, and the bytes one row turns into |
| `src/heap.ts` | A heap file — pages in a row, scanned end to end |
| `src/inode.ts` | The internal node: separator keys and child pointers |
| `src/btree.ts` | The tree. Lookups, ranges, splits, and a height that stays small |
| `src/wal.ts` | The write-ahead log, its checksums, recovery and checkpointing |
| `src/db.ts` | The catalog, tables, indexes, and transactions |
| `src/tokeniser.ts` | Text to tokens |
| `src/parser.ts` | Tokens to a tree |
| `src/plan.ts` | The tree to a plan, and the access path decision |
| `src/execute.ts` | The plan to rows |
| `src/jsonstore.ts` | Where the course starts: rows in a JSON file |
| `tools/` | `pagemap`, `treeshape`, and a benchmark against SQLite |

## The measurements

Every number below is pure computation over fixed inputs, so it is the same on
your machine as on mine.

```bash
node main.ts costs           # what 500 rows in a JSON file cost
node tools/pagemap.ts        # the byte layout of one real page
ROWS=60000 node tools/treeshape.ts
node tools/bench.ts          # against SQLite, which ships inside Node
```

The benchmark is not flattering and it is not meant to be. finch inserts far
slower than SQLite, because every page it changes is written to the log in full.
That is the first thing the last section of the course measures and fixes.

## Licence

MIT. Built for the course
[Build Your Own Database](https://github.com/rajeshpillai/build-your-own-database).
