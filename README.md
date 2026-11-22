# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cffilham-jpg/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cffilham-jpg/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format: it applies an edit that an
AI model wrote to a tree of text files. Models write edits in four formats, and
`mend` reads all of them — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. Every file is changed or nothing is. `SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A`/`D`/`M`, or `R old -> new` for a move)
and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`, and no file is written. Exit 2 is a usage, patch
or format error, with one `error: ...` line.

Matching is three-tiered: exact lines, then lines equal once trailing spaces
and tabs are removed, then lines equal once leading and trailing spaces and
tabs are removed — with re-indentation at the third tier, so drifted
whitespace and wrong line numbers still apply cleanly.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`.
- `runner.ts`: the trial runner. In a trial it reads the checks from the
  environment, runs `node main.ts` on each one in a fresh directory, and
  posts what it did. Keep it as it is.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score. This entry passes 100 of 100 practice checks.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
