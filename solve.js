// solve.js — a fast drop-in for makefun-site 1.0.0 (v2).
//
// Written fresh from makefun-site's README and reference behaviour. No
// vendor code is copied. The design, shaped by profiling v1:
//
//   - Markdown renders straight over the source string. Nothing is ever
//     split into lines: block boundaries come from an indexOf('\n') scan,
//     paragraph and code bodies are single span slices, and each body's
//     words are counted in one pass over the body string.
//   - Inline Markdown works on (string, start, end) ranges, so strong,
//     emphasis and link text recurse without slicing, and one module
//     regex serves every call (its lastIndex is set explicitly before
//     every exec, so recursion cannot disturb the outer scan).
//   - Links resolve through one shared function and a small context
//     object, never a closure per source, so the call site stays
//     monomorphic and the optimiser can inline it.
//   - Templates compile once per case into flat op lists. A for loop
//     only builds its loop-info object when its body can actually read
//     it. Templates that read only the case-level values render once per
//     (name, depth); templates that read one loop variable on top of
//     those, and render inside a loop, render once per (name, depth,
//     variable identity) — a post's card is the same string on its index
//     page and on every tag page, so it renders once.
//   - The page, tag and pager scope objects are filled in place and
//     reused across renders instead of rebuilt per page.
//
// Output is byte-for-byte makefun-site 1.0.0's: every quirk of its
// dialect (fence/heading/list rules, inline closers, front-matter
// refusals, template errors, link resolution, the report) is preserved
// exactly. Where in doubt, the reference code is the spec.

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `t` with & < > " ' escaped. */
function escapeHtml(t) {
  return t.replace(ESC_RE, (c) => ESCAPES[c]);
}

const NON_ASCII = /[^\x00-\x7F]/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const MARKS = /\p{M}/gu;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 * run of characters other than a-z and 0-9 one "-", none at either end,
 * at most 64 characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Pure-ASCII input takes a regex fast path that yields
 * exactly the same string; anything else goes through normalisation.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII.test(text)) {
    out = text.toLowerCase().replace(NON_ALNUM_RUN, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(MARKS, '');
    let built = '';
    let gap = false;
    for (const ch of plain) {
      const lo = ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch;
      if ((lo >= 'a' && lo <= 'z') || (lo >= '0' && lo <= '9')) {
        if (gap) built += '-';
        gap = false;
        built += lo;
      } else {
        gap = built.length > 0;
      }
    }
    built = built.slice(0, 64);
    let e = built.length;
    while (e > 0 && built.charCodeAt(e - 1) === 45) e--;
    out = built.slice(0, e);
    if (out === '') out = 'untitled';
  }
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const TRAILING_WS = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (const t of tags) {
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body start: { data, bodyAt }, or { error }
 * with the first reason it is refused. `text` is the whole source; the
 * scan walks its lines by indexOf('\n') and never splits it. `bodyAt` is
 * the character offset where the body starts (just past the closing
 * fence's newline, or the end of the string).
 */
function parseFrontMatter(text) {
  let eol = text.indexOf('\n');
  if (eol === -1) eol = text.length;
  if (eol !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // One scan finds the closing fence and parses the lines: the first
  // parse error is remembered but not returned until the fence is found,
  // because a missing fence is reported before any line error.
  const data = {};
  let pos = eol + 1;
  let lineNo = 1; // 0-based index of the line starting at pos
  let closeAt = -1;
  let firstError = null;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeAt = end;
      break;
    }
    if (firstError === null) {
      const c0 = text.charCodeAt(pos);
      if (pos !== end && c0 !== 35 && !isBlankSpan(text, pos, end)) {
        let k = pos;
        while (k < end) {
          const c = text.charCodeAt(k);
          if ((c >= 97 && c <= 122) || c === 95) k++;
          else break;
        }
        if (k === pos || text.charCodeAt(k) !== 58) {
          firstError = { error: `line ${lineNo + 1} is not "key: value"` };
        } else {
          const key = text.slice(pos, k);
          let raw;
          let bad = false;
          if (k + 1 === end) raw = '';
          else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, end);
          else {
            firstError = { error: `line ${lineNo + 1} is not "key: value"` };
            bad = true;
          }
          if (!bad) {
            const lastCh = raw.charCodeAt(raw.length - 1);
            if (lastCh === 32 || lastCh === 9) raw = raw.replace(TRAILING_WS, '');
            if (!FM_KEYS.has(key)) firstError = { error: `unknown key "${key}"` };
            else if (Object.hasOwn(data, key)) firstError = { error: `key "${key}" is given twice` };
            else if (raw === '') firstError = { error: `key "${key}" has no value` };
            else {
              const v = fmValueOf(key, raw);
              if ('error' in v) firstError = v;
              else data[key] = v.value;
            }
          }
        }
      }
    }
    if (end === text.length) break;
    pos = end + 1;
    lineNo++;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  if (firstError !== null) return firstError;
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyAt: closeAt === text.length ? text.length : closeAt + 1 };
}

// ---------------------------------------------------------------- markdown
//
// Every helper below works on a (text, start, end) range: no line is ever
// sliced out just to be classified. `end` is the index of the line's
// '\n', or the string's length for the last line.

/** Whether the span holds only spaces and tabs (or nothing). */
function isBlankSpan(text, start, end) {
  for (let k = start; k < end; k++) {
    const c = text.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language, or null (three backticks, a language of [A-Za-z0-9_+-]*, then spaces/tabs only). */
function fenceLangSpan(text, start, end) {
  if (text.charCodeAt(start) !== 96 || text.charCodeAt(start + 1) !== 96 || text.charCodeAt(start + 2) !== 96) return null;
  let j = start + 3;
  while (j < end) {
    const c = text.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = text.slice(start + 3, j);
  while (j < end) {
    const c = text.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether the span closes a fence (three backticks, then spaces/tabs only). */
function isFenceCloseSpan(text, start, end) {
  if (text.charCodeAt(start) !== 96 || text.charCodeAt(start + 1) !== 96 || text.charCodeAt(start + 2) !== 96) return false;
  for (let j = start + 3; j < end; j++) {
    const c = text.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's [level, textStart, textEnd], or null (1-6 #, space/tab,
 * non-empty text). The text range is trimmed of spaces/tabs at both ends;
 * closing hashes are part of the text, not stripped.
 */
function headingSpan(text, start, end) {
  let n = 0;
  while (start + n < end && text.charCodeAt(start + n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let a = start + n;
  while (a < end && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
  if (a === start + n) return null;
  let b = end;
  while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return [n, a, b];
}

/** Whether the span is a thematic break (--- or ***, then spaces/tabs only). */
function isHrSpan(text, start, end) {
  const c0 = text.charCodeAt(start);
  if (c0 !== 45 && c0 !== 42) return false;
  if (text.charCodeAt(start + 1) !== c0 || text.charCodeAt(start + 2) !== c0) return false;
  for (let j = start + 3; j < end; j++) {
    const c = text.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the span ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraphSpan(text, start, end) {
  const c0 = text.charCodeAt(start);
  if (start === end || c0 === 32 || c0 === 9) return isBlankSpan(text, start, end);
  if (c0 === 96) return fenceLangSpan(text, start, end) !== null;
  if (c0 === 35) return headingSpan(text, start, end) !== null;
  if (c0 === 45 || c0 === 42) return isHrSpan(text, start, end);
  return false;
}

/** A bullet item's text start (`- x` / `* x`), or -1. */
function bulletSpan(text, start, end) {
  const c0 = text.charCodeAt(start);
  if ((c0 === 45 || c0 === 42) && start + 1 < end && text.charCodeAt(start + 1) === 32) return start + 2;
  return -1;
}

/** An ordered item's [start number, text start] (`12. x`, 1-9 digits), or null. */
function orderedSpan(text, start, end) {
  let j = start;
  while (j < start + 9 && j < end && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
  if (j === start) return null;
  if (text.charCodeAt(j) !== 46 || text.charCodeAt(j + 1) !== 32) return null;
  return [Number(text.slice(start, j)), j + 2];
}

/** Whether the span continues a list item (two or more spaces, then a non-whitespace character). */
function isContinuedSpan(text, start, end) {
  let j = start;
  while (j < end && text.charCodeAt(j) === 32) j++;
  if (j - start < 2 || j >= end) return false;
  const c = text.charCodeAt(j);
  if (c < 127) return !(c === 32 || (c >= 9 && c <= 13));
  return !(
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The span with spaces and tabs at either end dropped, as [start, end]. */
function trimSpan(text, start, end) {
  let a = start;
  let b = end;
  while (a < b && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
  while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/**
 * The words of the span: its runs of characters other than whitespace
 * (the same set /\s/ names, including the non-ASCII whitespace
 * characters). Called once per body, over the whole body string: the
 * "\n" between lines is whitespace, so no run ever spans one, and the
 * total equals the sum over the lines.
 */
function countWordsSpan(text, start, end) {
  let n = 0;
  let inWord = false;
  for (let k = start; k < end; k++) {
    const c = text.charCodeAt(k);
    let ws;
    if (c < 127) {
      ws = c === 32 || (c >= 9 && c <= 13);
    } else {
      ws =
        c === 0xa0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff;
    }
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * The first index in [from, end) where `s` holds `what` outside a
 * backslash escape, or -1. A match is escaped exactly when an odd run of
 * backslashes stands right before it. The match must end inside the
 * range: a pair straddling `end` does not count.
 */
function findUnescaped(s, what, from, end) {
  let pos = from;
  for (;;) {
    const j = s.indexOf(what, pos);
    if (j === -1 || j + what.length > end) return -1;
    let n = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
    if (n % 2 === 0) return j;
    pos = j + 1;
  }
}

/**
 * The first single * in [from, end) (one whose run is not **), outside an
 * escape, or -1. In a run of stars the pairs cancel left to right, so a
 * single star exists exactly when the run is odd, at its last star. A
 * run is cut off at `end`: stars past it are not part of it.
 */
function findSingleStar(s, from, end) {
  let pos = from;
  for (;;) {
    const j = s.indexOf('*', pos);
    if (j === -1 || j >= end) return -1;
    let n = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
    if (n % 2 === 1) {
      pos = j + 1;
      continue;
    }
    let e = j;
    while (e + 1 < end && s[e + 1] === '*') e++;
    if ((e - j + 1) % 2 === 1) return e;
    pos = e + 1;
  }
}

/**
 * `s[start..end)` rendered inline; `ctx` is the link context for
 * resolveLink. The scan jumps from one special character to the next
 * with one shared regex, so a stretch of plain text is copied whole
 * instead of escaped character by character; the structure (code spans,
 * strong, emphasis, links, backslash escapes) follows the reference
 * exactly, including every no-closer fallback. Strong, emphasis and link
 * text recurse on ranges, never on slices. The regex's lastIndex is set
 * explicitly before every exec, so a recursive call cannot disturb the
 * outer scan.
 */
function inline(s, start, end, ctx) {
  INLINE_RE.lastIndex = start;
  let m = INLINE_RE.exec(s);
  if (m === null || m.index >= end) return start === 0 && end === s.length ? s : s.slice(start, end);
  let out = '';
  let last = start;
  while (m !== null && m.index < end) {
    const at = m.index;
    const c = s[at];
    if (c === '&') {
      out += s.slice(last, at);
      out += '&amp;';
      last = at + 1;
    } else if (c === '<') {
      out += s.slice(last, at);
      out += '&lt;';
      last = at + 1;
    } else if (c === '>') {
      out += s.slice(last, at);
      out += '&gt;';
      last = at + 1;
    } else if (c === '"') {
      out += s.slice(last, at);
      out += '&quot;';
      last = at + 1;
    } else if (c === "'") {
      out += s.slice(last, at);
      out += '&#39;';
      last = at + 1;
    } else if (c === '\\') {
      const nx = at + 1 < end ? s[at + 1] : undefined;
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += s.slice(last, at);
        out += nx === '>' ? '&gt;' : nx;
        last = at + 2;
      } else {
        out += s.slice(last, at);
        out += '\\';
        last = at + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', at + 1);
      if (j !== -1 && j < end && j > at + 1) {
        out += s.slice(last, at);
        out += '<code>';
        out += escapeHtml(s.slice(at + 1, j));
        out += '</code>';
        last = j + 1;
      } else {
        out += s.slice(last, at);
        out += '`';
        last = at + 1;
      }
    } else if (c === '*') {
      if (at + 1 < end && s[at + 1] === '*') {
        const j = findUnescaped(s, '**', at + 2, end);
        if (j > at + 2) {
          out += s.slice(last, at);
          out += '<strong>';
          out += inline(s, at + 2, j, ctx);
          out += '</strong>';
          last = j + 2;
        } else {
          out += s.slice(last, at);
          out += '**';
          last = at + 2;
        }
      } else {
        const j = findSingleStar(s, at + 1, end);
        if (j > at + 1) {
          out += s.slice(last, at);
          out += '<em>';
          out += inline(s, at + 1, j, ctx);
          out += '</em>';
          last = j + 1;
        } else {
          out += s.slice(last, at);
          out += '*';
          last = at + 1;
        }
      }
    } else {
      // '[': the first unescaped ']' closes the text, '(' must follow at
      // once, and the next ')' (escaped or not) closes the target, which
      // must be non-empty and hold no whitespace.
      const k = findUnescaped(s, ']', at + 1, end);
      const m2 = k !== -1 && k + 1 < end && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= end ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out += s.slice(last, at);
        out += '<a href="';
        out += escapeHtml(resolveLink(target, ctx));
        out += '">';
        out += inline(s, at + 1, k, ctx);
        out += '</a>';
        last = m2 + 1;
      } else {
        out += s.slice(last, at);
        out += '[';
        last = at + 1;
      }
    }
    INLINE_RE.lastIndex = last;
    m = INLINE_RE.exec(s);
  }
  out += s.slice(last, end);
  return out;
}

/**
 * The body at `text[bodyAt..]` rendered in one pass over the raw string:
 * its HTML (each block followed by "\n"), its table of contents (every
 * level 2 and 3 heading), its excerpt (the first paragraph's inline HTML,
 * or "") and its word count. No line array is ever built: block
 * boundaries come from an indexOf('\n') scan, paragraph and code bodies
 * are single span slices, and words are counted once over the whole body.
 */
function renderBody(text, bodyAt, ctx) {
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const words = countWordsSpan(text, bodyAt, text.length);
  const len = text.length;
  let pos = bodyAt;
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = len;
    const next = end === len ? len : end + 1;
    const c0 = text.charCodeAt(pos);
    if ((pos === end || c0 === 32 || c0 === 9) && isBlankSpan(text, pos, end)) {
      pos = next;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceLangSpan(text, pos, end);
      if (lang !== null) {
        let p = next;
        const bodyStart = p;
        let lastEnd = p;
        let anyBody = false;
        let closed = false;
        while (p < len) {
          let e2 = text.indexOf('\n', p);
          if (e2 === -1) e2 = len;
          if (isFenceCloseSpan(text, p, e2)) {
            closed = true;
            p = e2 === len ? len : e2 + 1;
            break;
          }
          anyBody = true;
          lastEnd = e2;
          p = e2 === len ? len : e2 + 1;
        }
        // An unclosed fence at a text ending in "\n" holds one phantom
        // empty body line (the split's trailing element): it adds a "\n"
        // to the joined body when real lines precede it, and makes an
        // otherwise empty body non-empty.
        const phantom = !closed && len > 0 && text.charCodeAt(len - 1) === 10;
        const joined = anyBody ? text.slice(bodyStart, lastEnd) + (phantom ? '\n' : '') : '';
        const inner = anyBody || phantom ? `${escapeHtml(joined)}\n` : '';
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        parts.push(`<pre><code${cls}>${inner}</code></pre>`, '\n');
        pos = p;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingSpan(text, pos, end);
      if (h !== null) {
        const id = uniqueSlug(slugify(text.slice(h[1], h[2])), ids);
        const html = inline(text, h[1], h[2], ctx);
        parts.push(`<h${h[0]} id="${id}">${html}</h${h[0]}>`, '\n');
        if (h[0] === 2 || h[0] === 3) toc.push({ level: h[0], id, html });
        pos = next;
        continue;
      }
    } else if (c0 === 62) {
      const pieces = [];
      let p = pos;
      while (p < len) {
        let e2 = text.indexOf('\n', p);
        if (e2 === -1) e2 = len;
        if (text.charCodeAt(p) !== 62) break;
        let a = p + 1;
        if (a < e2 && text.charCodeAt(a) === 32) a++;
        const t = trimSpan(text, a, e2);
        if (t[1] > t[0]) pieces.push(text.slice(t[0], t[1]));
        p = e2 === len ? len : e2 + 1;
      }
      if (pieces.length === 0) {
        parts.push('<blockquote>\n</blockquote>', '\n');
      } else {
        const joined = pieces.join('\n');
        parts.push(`<blockquote>\n<p>${inline(joined, 0, joined.length, ctx)}</p>\n</blockquote>`, '\n');
      }
      pos = p;
      continue;
    } else {
      let listKind = 0; // 1 bullet, 2 ordered
      let startNum = 1;
      if (c0 === 45 || c0 === 42) {
        if (isHrSpan(text, pos, end)) {
          parts.push('<hr>', '\n');
          pos = next;
          continue;
        }
        if (bulletSpan(text, pos, end) !== -1) listKind = 1;
      } else if (c0 >= 48 && c0 <= 57) {
        const o = orderedSpan(text, pos, end);
        if (o !== null) {
          listKind = 2;
          startNum = o[0];
        }
      }
      if (listKind !== 0) {
        const isOrdered = listKind === 2;
        const items = [];
        let p = pos;
        while (p < len) {
          let e2 = text.indexOf('\n', p);
          if (e2 === -1) e2 = len;
          let itemAt = -1;
          if (isOrdered) {
            const o = orderedSpan(text, p, e2);
            if (o !== null) itemAt = o[1];
          } else {
            itemAt = bulletSpan(text, p, e2);
          }
          if (itemAt !== -1) {
            const t = trimSpan(text, itemAt, e2);
            items.push(text.slice(t[0], t[1]));
          } else if (isContinuedSpan(text, p, e2)) {
            const t = trimSpan(text, p, e2);
            items[items.length - 1] += `\n${text.slice(t[0], t[1])}`;
          } else {
            break;
          }
          p = e2 === len ? len : e2 + 1;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
        const lp = [`${open}\n`];
        for (const it of items) lp.push(`<li>${inline(it, 0, it.length, ctx)}</li>\n`);
        lp.push(`</${tag}>`);
        parts.push(lp.join(''), '\n');
        pos = p;
        continue;
      }
    }
    // A paragraph: the lines until one ends it. When no line needs
    // trimming, the joined text is one span slice; otherwise each line
    // is trimmed and joined (a second scan, only for those paragraphs).
    let p = next;
    let lastEnd = end;
    let needsTrim =
      c0 === 32 || c0 === 9 || text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9;
    while (p < len) {
      let e2 = text.indexOf('\n', p);
      if (e2 === -1) e2 = len;
      if (endsParagraphSpan(text, p, e2)) break;
      if (!needsTrim) {
        const cc = text.charCodeAt(p);
        needsTrim =
          cc === 32 || cc === 9 || text.charCodeAt(e2 - 1) === 32 || text.charCodeAt(e2 - 1) === 9;
      }
      lastEnd = e2;
      p = e2 === len ? len : e2 + 1;
    }
    let joined;
    if (!needsTrim) {
      joined = text.slice(pos, lastEnd);
    } else {
      const pieces = [];
      let q = pos;
      for (;;) {
        let e2 = text.indexOf('\n', q);
        if (e2 === -1 || e2 > lastEnd) e2 = lastEnd;
        const t = trimSpan(text, q, e2);
        pieces.push(text.slice(t[0], t[1]));
        if (e2 === lastEnd) break;
        q = e2 + 1;
      }
      joined = pieces.join('\n');
    }
    const html = inline(joined, 0, joined.length, ctx);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>`, '\n');
    pos = p;
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const WS_ONLY_RE = /^[ \t]*$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a {% %} tag alone on
 * its line (only spaces or tabs beside it) takes its whole line with it,
 * newline included. Tokenising runs fully before parsing, so an unclosed
 * delimiter is reported before any structural error, wherever it sits.
 */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = WS_ONLY_RE.test(src.slice(lineStart, open)) && WS_ONLY_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Op lists, one array per op, the first element its kind:
//   [0, text]                          literal text
//   [1, path]                          {{ path }}, escaped
//   [2, path]                          {{{ path }}}, raw
//   [3, path, not, thenOps, elseOps?]  {% if [not] path %} (elseOps null without an else)
//   [4, name, path, bodyOps, needsLoop] {% for name in path %} (needsLoop filled in after parsing)
//   [5, name]                          {% include "name" %}

/** `src` compiled into its op list (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var') body.push([1, tok.path]);
    else if (tok.t === 'raw') body.push([2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), [], true];
        body.push(node);
        stack.push({ kind: 'for', body: node[3] });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, pathOf(name, m[2]), m[1] !== undefined, [], null];
        body.push(node);
        stack.push({ kind: 'if', node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        body = stack[stack.length - 1].body;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push([5, m[1]]);
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/**
 * The value at `path` in `vars`: the first name is an own property of the
 * flat scope (loop bindings shadow the page's values, restored on exit),
 * each next name an own property of the value so far, or undefined.
 */
function lookup(vars, path) {
  if (!Object.hasOwn(vars, path[0])) return undefined;
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INCLUDE_DEPTH = 8;

// ------------------------------------------------------- fragment caching
//
// Two caches, both keyed on what a template can read:
//
//   - Case-level: a template whose every read (through its includes)
//     names only site, tags and recent renders the same string at every
//     include site, at a given depth: those three objects are the same
//     for every page of a case. The shared header, navigation and footer
//     render once per (name, depth) and the string is reused.
//   - Single-variable: a template rendered inside a loop whose every read
//     names only the case-level values plus one loop variable renders the
//     same string for the same value of that variable: a post's card is
//     identical on its index page and on every tag page, so it renders
//     once per (name, depth, variable identity). The variable must be a
//     genuine loop binding, never one of the shared mutable scope objects
//     (page, pager, tag) or the per-iteration loop info, and the
//     case-level identity check still applies (a loop may shadow them).
//
// The analysis threads the loop-bound names through includes, so a read
// of a name bound by an enclosing loop inside the fragment is local to
// it and safe; a cycle contributes nothing, because the outer analysis
// of the cycled template already covers its ops under a smaller bound
// set. At an include site the cache is used only when the scope's site,
// tags and recent are still the case-level objects, which the identity
// check proves.

const CASE_LEVEL = new Set(['site', 'tags', 'recent']);
const TOPLEVEL = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag', 'loop']);
let fragStatic = null; // Set<string>: templates safe to cache case-level
let fragCache = null; // Map<string, Array<string|undefined>>: name -> cached string by render depth
let fragVar = null; // Map<string, string>: template name -> its single loop variable
let fragVarCache = null; // Map<string, Map<any, Array<string|undefined>>>: name -> variable value -> cached string by depth
let fragSite = null;
let fragTags = null;
let fragRecent = null;

/**
 * The names `ops` reads from outside the fragment: first names neither
 * bound by an enclosing for loop (`bound`) nor, for includes, read by
 * the included template under that same bound set. `visiting` breaks
 * include cycles; a missing include reads nothing.
 */
function externalNames(ops, bound, templates, visiting, out) {
  for (const op of ops) {
    if (op[0] === 1 || op[0] === 2) {
      if (!bound.has(op[1][0])) out.add(op[1][0]);
    } else if (op[0] === 3) {
      if (!bound.has(op[1][0])) out.add(op[1][0]);
      externalNames(op[3], bound, templates, visiting, out);
      if (op[4] !== null) externalNames(op[4], bound, templates, visiting, out);
    } else if (op[0] === 4) {
      if (!bound.has(op[2][0])) out.add(op[2][0]);
      const inner = new Set(bound);
      inner.add(op[1]);
      inner.add('loop');
      externalNames(op[3], inner, templates, visiting, out);
    } else if (op[0] === 5) {
      const t = templates.get(op[1]);
      if (t !== undefined && !visiting.has(op[1])) {
        visiting.add(op[1]);
        externalNames(t, bound, templates, visiting, out);
        visiting.delete(op[1]);
      }
    }
  }
  return out;
}

/** The templates of this case whose rendering depends only on the case-level values. */
function computeStatic(templates) {
  const stat = new Set();
  for (const [name, ops] of templates) {
    const ext = externalNames(ops, new Set(), templates, new Set([name]), new Set());
    let ok = true;
    for (const n of ext) {
      if (!CASE_LEVEL.has(n)) {
        ok = false;
        break;
      }
    }
    if (ok) stat.add(name);
  }
  return stat;
}

/**
 * Whether `ops` reads the enclosing loop's info object: any read of a
 * path starting with `loop`, through if branches and includes — but not
 * inside a nested for body, whose reads see the nested loop's info, and
 * not counting the nested for's own iterable, which is evaluated in the
 * enclosing scope and does count. A for loop whose body cannot read the
 * info object never builds one.
 */
function readsLoop(ops, templates, visiting) {
  for (const op of ops) {
    if (op[0] === 1 || op[0] === 2) {
      if (op[1][0] === 'loop') return true;
    } else if (op[0] === 3) {
      if (op[1][0] === 'loop') return true;
      if (readsLoop(op[3], templates, visiting)) return true;
      if (op[4] !== null && readsLoop(op[4], templates, visiting)) return true;
    } else if (op[0] === 4) {
      if (op[2][0] === 'loop') return true;
    } else if (op[0] === 5) {
      const t = templates.get(op[1]);
      if (t !== undefined && !visiting.has(op[1])) {
        visiting.add(op[1]);
        const found = readsLoop(t, templates, visiting);
        visiting.delete(op[1]);
        if (found) return true;
      }
    }
  }
  return false;
}

/** Fill in every for-op's needsLoop flag: false when its body cannot read the loop-info object. */
function annotateLoopInfo(templates) {
  const walk = (ops) => {
    for (const op of ops) {
      if (op[0] === 3) {
        walk(op[3]);
        if (op[4] !== null) walk(op[4]);
      } else if (op[0] === 4) {
        op[4] = readsLoop(op[3], templates, new Set());
        walk(op[3]);
      }
    }
  };
  for (const ops of templates.values()) walk(ops);
}

/**
 * The templates safe for the single-variable cache: rendered inside a
 * loop (included from inside a for body, or included by such a template)
 * and reading only the case-level values plus one loop variable. Maps
 * each such template's name to its variable.
 */
function computeVarCache(templates) {
  const includedInLoop = new Set();
  const includedBy = new Map();
  for (const [name, ops] of templates) {
    const inc = new Set();
    includedBy.set(name, inc);
    const walk = (list, inside) => {
      for (const op of list) {
        if (op[0] === 3) {
          walk(op[3], inside);
          if (op[4] !== null) walk(op[4], inside);
        } else if (op[0] === 4) {
          walk(op[3], true);
        } else if (op[0] === 5) {
          inc.add(op[1]);
          if (inside) includedInLoop.add(op[1]);
        }
      }
    };
    walk(ops, false);
  }
  const loopRendered = new Set(includedInLoop);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of loopRendered) {
      const inc = includedBy.get(name);
      if (inc === undefined) continue;
      for (const t of inc) {
        if (!loopRendered.has(t)) {
          loopRendered.add(t);
          changed = true;
        }
      }
    }
  }
  const out = new Map();
  for (const name of loopRendered) {
    const ops = templates.get(name);
    if (ops === undefined) continue;
    const ext = externalNames(ops, new Set(), templates, new Set([name]), new Set());
    let vn = null;
    let ok = true;
    for (const n of ext) {
      if (CASE_LEVEL.has(n)) continue;
      if (vn === null && !TOPLEVEL.has(n)) {
        vn = n;
        continue;
      }
      ok = false;
      break;
    }
    if (ok && vn !== null) out.set(name, vn);
  }
  return out;
}

/**
 * `ops` rendered into `out` (an array of string pieces) in the flat scope
 * `vars`. A for loop writes its element and loop info into the scope and
 * restores what was there before (an absent name is restored to
 * undefined, which a lookup reads exactly as an absent name); the loop
 * info object is only built when the body can read it. An include
 * renders nothing past the depth limit or when its template is missing.
 */
function renderOps(ops, vars, out, depth, templates) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    switch (op[0]) {
      case 0:
        out.push(op[1]);
        break;
      case 1:
        out.push(escapeHtml(textOf(lookup(vars, op[1]))));
        break;
      case 2:
        out.push(textOf(lookup(vars, op[1])));
        break;
      case 3: {
        const branch = truthy(lookup(vars, op[1])) !== op[2] ? op[3] : op[4];
        if (branch !== null) renderOps(branch, vars, out, depth, templates);
        break;
      }
      case 4: {
        const xs = lookup(vars, op[2]);
        if (!Array.isArray(xs) || xs.length === 0) break;
        const name = op[1];
        const body = op[3];
        const len = xs.length;
        const needLoop = op[4];
        const hadName = Object.hasOwn(vars, name);
        const oldName = vars[name];
        let hadLoop = false;
        let oldLoop;
        if (needLoop) {
          hadLoop = Object.hasOwn(vars, 'loop');
          oldLoop = vars.loop;
        }
        for (let k = 0; k < len; k++) {
          if (name !== 'loop') vars[name] = xs[k];
          if (needLoop) vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderOps(body, vars, out, depth, templates);
        }
        vars[name] = hadName ? oldName : undefined;
        if (needLoop && name !== 'loop') vars.loop = hadLoop ? oldLoop : undefined;
        break;
      }
      case 5: {
        if (depth < INCLUDE_DEPTH) {
          const t = templates.get(op[1]);
          if (t !== undefined) {
            const caseLevel = vars.site === fragSite && vars.tags === fragTags && vars.recent === fragRecent;
            if (fragStatic.has(op[1]) && caseLevel) {
              let arr = fragCache.get(op[1]);
              if (arr === undefined) {
                arr = new Array(INCLUDE_DEPTH + 1);
                fragCache.set(op[1], arr);
              }
              let s = arr[depth + 1];
              if (s === undefined) {
                const tmp = [];
                renderOps(t, vars, tmp, depth + 1, templates);
                s = tmp.join('');
                arr[depth + 1] = s;
              }
              out.push(s);
            } else {
              const vn = fragVar.get(op[1]);
              if (vn !== undefined && caseLevel) {
                let per = fragVarCache.get(op[1]);
                if (per === undefined) {
                  per = new Map();
                  fragVarCache.set(op[1], per);
                }
                const key = vars[vn];
                let arr = per.get(key);
                if (arr === undefined) {
                  arr = new Array(INCLUDE_DEPTH + 1);
                  per.set(key, arr);
                }
                let s = arr[depth + 1];
                if (s === undefined) {
                  const tmp = [];
                  renderOps(t, vars, tmp, depth + 1, templates);
                  s = tmp.join('');
                  arr[depth + 1] = s;
                }
                out.push(s);
              } else {
                renderOps(t, vars, out, depth + 1, templates);
              }
            }
          }
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ pipeline

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CRLF_RE = /\r\n?/g;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const pathCache = new Map();

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. Pure in (dir, rel), so memoised: the same target is linked from many sources. */
function resolvePath(dir, rel) {
  const key = `${dir}\n${rel}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        pathCache.set(key, null);
        return null;
      }
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const out = parts.join('/');
  pathCache.set(key, out);
  return out;
}

/**
 * The link context: one object per case, its per-source fields (dir,
 * sourcePath) overwritten before each body's render. Links resolve
 * through this one function, never a closure per source.
 */
const linkCtx = { dir: '', bySource: null, staticPaths: null, base: '', broken: null, sourcePath: '' };

/** A link target's href: kept as written with a scheme, a leading / or #; otherwise resolved to a page, a static file, or reported broken. */
function resolveLink(target, ctx) {
  if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dir, rel);
  if (path !== null) {
    const page = ctx.bySource.get(path);
    if (page !== undefined) return page.url + frag;
    if (ctx.staticPaths.has(path)) return `${ctx.base}/${path}${frag}`;
  }
  ctx.broken.add(`broken-link ${ctx.sourcePath} -> ${target}`);
  return target;
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagList,
  };
}

// The page, tag and pager scope objects are filled in place and reused
// across renders: no template keeps a reference past its own render, so
// overwriting the fields is exactly rebuilding the object.
const pageScope = {
  title: '',
  url: '',
  date: '',
  date_long: '',
  summary: '',
  excerpt: '',
  reading_minutes: 1,
  tags: null,
  slug: '',
  content: '',
  toc: null,
  newer: null,
  older: null,
  is_post: false,
};
const newerScope = { title: '', url: '', date: '', date_long: '' };
const olderScope = { title: '', url: '', date: '', date_long: '' };
const tagScope = { name: '', slug: '', url: '', count: 0, posts: null };
const pagerScope = { number: 1, total: 1, url: '', newer_url: '', older_url: '' };

function fillLink(scope, s) {
  scope.title = s.data.title;
  scope.url = s.url;
  scope.date = s.data.date ?? '';
  scope.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
}

/** `pageScope` filled from `s`, as its layout reads it. */
function fillPage(s) {
  pageScope.title = s.data.title;
  pageScope.url = s.url;
  pageScope.date = s.data.date ?? '';
  pageScope.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
  pageScope.summary = s.data.summary ?? '';
  pageScope.excerpt = s.excerpt;
  pageScope.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
  pageScope.tags = s.tagList;
  pageScope.slug = s.slug;
  pageScope.content = s.html;
  pageScope.toc = s.toc;
  if (s.newer === null || s.newer === undefined) {
    pageScope.newer = null;
  } else {
    fillLink(newerScope, s.newer);
    pageScope.newer = newerScope;
  }
  if (s.older === null || s.older === undefined) {
    pageScope.older = null;
  } else {
    fillLink(olderScope, s.older);
    pageScope.older = olderScope;
  }
  pageScope.is_post = s.post;
  return pageScope;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmpStr);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  annotateLoopInfo(templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made
  // "\n"; a source that is not .md is static. Every field a later step
  // sets is declared here, so all sources share one shape.
  const files = input.files.slice().sort((a, b) => cmpStr(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CRLF_RE, '\n');
      sources.push({
        path: f.path,
        text,
        data: null,
        bodyAt: 0,
        post: false,
        layout: null,
        slug: null,
        outDir: null,
        url: null,
        html: null,
        toc: null,
        excerpt: null,
        words: 0,
        tagList: null,
        newer: null,
        older: null,
      });
    } else {
      statics.push(f);
    }
  }

  // 2. Each source's front matter: a refused source is reported and
  // dropped, and so is a draft. The checks run in order; the first one
  // that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyAt = fm.bodyAt;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order; at the root, posts/tags/page are taken.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  linkCtx.bySource = bySource;
  linkCtx.staticPaths = staticPaths;
  linkCtx.base = base;
  linkCtx.broken = broken;
  for (const s of kept) {
    linkCtx.dir = dirOf(s.path);
    linkCtx.sourcePath = s.path;
    const md = renderBody(s.text, s.bodyAt, linkCtx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
    s.text = null;
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const tagSeen = new Set();
  const ownTags = (s) => {
    tagSeen.clear();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (tagSeen.has(slug)) continue;
      tagSeen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagList = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagList.push({ name: tag.name, slug: tag.slug, url: tag.url });
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagList = ownTags(s).map((name) => {
      const slug = slugify(name);
      const tag = bySlug.get(slug);
      return tag === undefined ? { name, slug, url: '' } : { name: tag.name, slug: tag.slug, url: tag.url };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  fragStatic = computeStatic(templates);
  fragVar = computeVarCache(templates);
  fragCache = new Map();
  fragVarCache = new Map();
  fragSite = site;
  fragTags = allTags;
  fragRecent = recent;
  const output = {};
  // One scope object for every render of this case: the per-render keys
  // are overwritten (to undefined when absent, which a lookup reads
  // exactly as an absent name) and the loop bindings renderOps leaves
  // behind are undefined-valued for the same reason.
  const scope = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, scope, out, 0, templates);
    return out.join('');
  };
  for (const s of kept) {
    fillPage(s);
    scope.page = pageScope;
    scope.posts = undefined;
    scope.pager = undefined;
    scope.tag = undefined;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  scope.page = undefined;
  scope.tag = undefined;
  for (let k = 1; k <= pages; k++) {
    scope.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    pagerScope.number = k;
    pagerScope.total = pages;
    pagerScope.url = indexUrl(k);
    pagerScope.newer_url = k === 1 ? '' : indexUrl(k - 1);
    pagerScope.older_url = k === pages ? '' : indexUrl(k + 1);
    scope.pager = pagerScope;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  scope.posts = undefined;
  scope.pager = undefined;
  for (const t of tags) {
    tagScope.name = t.name;
    tagScope.slug = t.slug;
    tagScope.url = t.url;
    tagScope.count = t.posts.length;
    tagScope.posts = t.posts.map((p) => cards.get(p));
    scope.tag = tagScope;
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  scope.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that
  // did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
