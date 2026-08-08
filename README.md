# finch

A database built from an empty file up, one step at a time — pages, a pager, a B-tree,
a write-ahead log, a small SQL, and transactions.

This is the code for the course **Build Your Own Database**. Every lecture is one commit
and one tag, so the history *is* the syllabus.

## Running it

Node 22.18 or newer. **Nothing to install.**

```bash
git clone https://github.com/rajeshpillai/build-your-own-database
cd build-your-own-database
node main.ts
```

There is no build step. The source is TypeScript, and Node strips the types and runs the
file directly, so what you read is exactly what executes. `npm install` is only needed if
you want to run the type checker (`npm run typecheck`).

Every step ships assertions, and they are the same ones the course build runs:

```bash
./verify.sh
```

## Following the course

Each lecture has a tag. Check one out and the working tree is the code as it stood at that
point in the video:

```bash
git checkout db-step-01     # a JSON file, and everything it costs you
git checkout db-step-02     # a file of fixed-size pages
git log --oneline           # the syllabus, in order
```

The diff between two tags is the lecture. Every tag boots and passes its own `verify.sh`.

## The finished engine

If you want to read the ending rather than build up to it, it is on its own branch:

```bash
git checkout feat/reference
```

That branch holds the whole engine, working — the pager, the B-tree, the log, the query
planner and transactions — with its own tests and a benchmark against SQLite.

## The numbers

Every figure this code prints is computed from fixed inputs, so you get the same ones I do.
Nothing here is timed, because a timing moves between runs and a number in a video should
not.

```bash
node main.ts            # what 500 rows in a JSON file cost
```

## Licence

MIT.
