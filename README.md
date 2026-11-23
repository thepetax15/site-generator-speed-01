# site-generator-speed-01 v2 — a faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/thepetax15/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/thepetax15/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An original, dependency-free reimplementation of makefun-site 1.0.0 that
returns byte-for-byte the same output tree for every site, several times
faster. Built for make.fun's "Build a static site faster" bounty. This is
the second iteration: the Markdown renderer and the template engine were
rebuilt around profiling of the first version.

## Layout

- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run()` from `solve.js`, writes
  `/output/answers.json`.
- `solve.js` — the whole generator in one ES module: `run(input)`.

## How it is faster

- **Markdown renders straight over the source string.** Nothing is ever
  split into lines: block boundaries come from an `indexOf('\n')` scan,
  block kinds are dispatched on the line's first character, and paragraph
  and code bodies are single span slices. Each body's words are counted
  in one pass over the body string.
- **Inline Markdown works on ranges**, so strong, emphasis and link text
  recurse without slicing, and one module-level regex serves every call
  (its `lastIndex` is set explicitly before every exec, so recursion
  cannot disturb the outer scan). Links resolve through one shared
  function and a context object, never a closure per source, so the call
  site stays monomorphic.
- **Templates compile once per case into flat op lists** and render into
  one flat scope object, with string pieces joined once per render. A
  `for` loop only builds its loop-info object when a static analysis
  proves its body can read it. Templates that read only the case-level
  values (`site`, `tags`, `recent`) render once per (name, depth); a
  template rendered inside a loop that reads one loop variable on top of
  those renders once per (name, depth, variable identity) — a post's
  card is the same string on its index page and on every tag page, so it
  renders once. Page, tag and pager scope objects are filled in place
  and reused across renders.
- **Slugs and long dates** are memoised: titles and tag names repeat
  across a site far more often than they vary. Pure-ASCII slugs take a
  regex fast path; anything else goes through NFKD normalisation.
  Link-path resolution is memoised too.

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
