Before you start — what you need, and what you do not

This course builds a database from an empty file. Every lecture is one commit in a public
repository, and every one of them runs on its own. This page takes about two minutes, and you
only read it once.


WHAT YOU NEED TO KNOW

You should have written some code before. If you can read this and say what it does, you are
ready:

    const rows = [];
    rows.push({ id: 1, name: 'ada' });

That is the bar. Variables, arrays, functions, and a loop.


WHAT YOU DO NOT NEED TO KNOW

You do not need to have used a database. You do not need to know SQL. We build a small one, so
learning it here is the point.

You do not need to know TypeScript. The code is TypeScript, but only for the types on the edges
of a function. If you can read JavaScript you can read all of it, and every new piece is
explained on screen the first time it appears.

You do not need to know how files work at the byte level. That is most of what the course
teaches.


WHAT YOU NEED INSTALLED

Node.js 22.18 or newer, a terminal, and an editor. That is the whole list.

There is no framework to install and no database to install. Writing one is what the course is.


GET THE CODE

    git clone https://github.com/rajeshpillai/build-your-own-database
    cd build-your-own-database
    node main.ts

There is no npm install step, and that is on purpose rather than an oversight. Node reads the
types and runs the file, so what you see on screen is exactly what runs.


HOW A LECTURE MAPS TO THE CODE

Each lecture has a tag. Check one out and your files become the code as it stood in that video:

    git checkout db-step-01     # a JSON file, and everything it costs you
    git checkout db-step-02     # a file of fixed-size pages
    git log --oneline           # the whole course, in order

Every step ships its own checks, and they are the same ones I run:

    ./verify.sh

The difference between two tags is one lecture.


IF YOU WANT TO SEE THE ENDING FIRST

The finished engine lives on its own branch — the pager, the B-tree, the log, the query planner
and transactions, all working, with tests and a benchmark against SQLite:

    git checkout feat/reference

Some people learn better with the destination in view. If that is you, read it on day one. It
will not spoil anything, because the interesting part is why each piece is shaped the way it is.


ABOUT THE NUMBERS

Every figure this course says out loud is computed from fixed inputs. Five hundred rows are the
same five hundred rows on your machine and on mine, so you get the same numbers I do.

Nothing is timed on camera. A timing changes between runs, and a number in a video should not.


ABOUT THE NARRATION

The voice is synthesised from my own. The script, the code and the teaching are mine.
