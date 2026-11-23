# site-generator-speed-01 — a faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/thepetax15/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/thepetax15/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An original, dependency-free reimplementation of makefun-site 1.0.0 that
returns byte-for-byte the same output tree for every site, several times
faster. Built for make.fun's "Build a static site faster" bounty.

## Layout

- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run()` from `solve.js`, writes
  `/output/answers.json`.
- `solve.js` — the whole generator in one ES module: `run(input)`.

## How it is faster

- **Inline Markdown** scans for the next special character with one
  regex instead of walking (and escaping) one character at a time; plain
  runs are copied whole. Strong/emphasis closers are found with
  `indexOf` plus a backslash-parity check instead of a forward scan.
- **Block Markdown** renders in a single pass over the body's lines,
  with no token objects, and counts the body's words on the same pass.
- **Front matter** is parsed over the same line array the renderer uses,
  so a body is never joined and re-split.
- **Templates** compile once per case into flat op lists and render into
  one flat scope object (loop bindings saved and restored), with string
  pieces joined once per render. Templates that read only the
  case-level values (`site`, `tags`, `recent`) — typically the shared
  header, navigation and footer — are rendered once per (name, depth)
  and the string reused: a static analysis threads the loop-bound names
  through includes to prove a fragment's output depends only on those
  three objects, and an identity check at each include site guards
  against a loop in the caller shadowing them.
- **Block dispatch** looks at each line's first character before running
  any test: every block kind is anchored there, so a plain paragraph
  line costs one character check instead of six helper calls.
- **Word counting** is batched per block, not per line: a paragraph's,
  list item's or fence body's words are counted once on the string that
  is joined for rendering anyway (a list item's marker adds one word).
- **Slugs and long dates** are memoised: titles and tag names repeat
  across a site far more often than they vary. Pure-ASCII slugs take a
  regex fast path; anything else goes through NFKD normalisation.
  Link-path resolution is memoised too.
- **String building** collects pieces in arrays and joins once for every
  rendered page and block; inline rendering concatenates (ropes beat
  array+join there, measured).

## Behaviour

Every quirk of makefun-site's dialect is preserved exactly: its front
matter refusals and error strings, its Markdown subset (fences, headings
with unique ids, lists, blockquotes, inline code/strong/emphasis/links
with their exact closer rules), its template dialect (standalone `{% %}`
lines, include depth limit, scope lookup, `textOf`/`truthy` rules), its
slug rule, its link resolution and broken-link report, and its
`build-report.txt`.

## Verify locally

```sh
# practice set, against the kit's reference + the oracle
node check-practice.mjs
# hand-crafted adversarial cases vs the oracle (170 cases)
node edge.mjs
# fuzz vs the oracle on random generated sites
node fuzz.mjs 30 <seed>
# CPU-time comparison vs the house baseline + the null entry
python3 time2.py 7
```

(Those harnesses live beside the kit, not in this repository.)
