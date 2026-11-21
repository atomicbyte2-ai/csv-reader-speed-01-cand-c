# csv-reader-speed-01-cand-c

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/atomicbyte2-ai/csv-reader-speed-01-cand-c/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/atomicbyte2-ai/csv-reader-speed-01-cand-c/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0: `solve.js` answers `{columns, rows, errors}`
exactly as the reference does on every case, in ~4–6x less CPU time on the
practice set (local, 1 CPU, `node --no-incremental-marking`: ~165–210 ms for
the full 6-case set vs ~690–1,280 ms for the house baseline — same machine,
same session).

## Design (record-chunked hybrid)

1. **Record fast path** — take one physical line (up to the next LF) as a slice.
   When no field in it *opens* with a quote (a quote mid-field is literal, so
   `split(',')` stays valid) and it holds no stray CR (a trailing CR is only
   the CRLF terminator), the record is one slice + `split(',')`.
2. **Slow path** — per-field scanning driven by `indexOf`, never per
   character. An unquoted field is one slice once the nearest of `,` / LF is
   known; a stray CR inside that slice is found by a bounded `indexOf` on the
   slice itself, never an unbounded scan over the rest of the file. A quoted
   field is one slice when it holds no `""` and no CR/LF; otherwise it is
   rebuilt once with `split`/`join`, counting its line breaks in the same pass.
3. **Exact error attribution** — every error's `line` is the record's start
   line and its `row` the record's index in `rows` (`null` for the header);
   `stray_cr` inside quote junk comes before that field's `quote_junk`, and
   `unterminated_quote` fires before any `stray_cr` from the re-read.

Verified 6/6 identical to the reference on the kit practice set, 12/12 on
fresh full-size cases drawn from the kit's own generator with new seeds, and
5,130/5,130 on a differential fuzzer (hand-written edge cases + random
quote/CR-heavy inputs) against csv-reader 1.0.0.

## Run it

```sh
MAKEFUN_INPUT_DIR=path/to/cases MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is the kit baseline's driver as shipped (it sets
`--no-incremental-marking` before importing `solve.js`). Dependency-free ES
module, Node 22, deterministic, no network, no WASM/native code. All paths
resolve from the script's own directory.

Made with [make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121?ref=pnttjnyx).
