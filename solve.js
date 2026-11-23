// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Original implementation, written from makefun-site's README and its
// reference behaviour. No vendor code is copied: every function here is
// written fresh, shaped for speed where the reference is slow:
//
//   - inline Markdown scans for the next special character instead of
//     walking (and escaping) one character at a time;
//   - block Markdown renders in a single pass over the body's lines,
//     without token objects, and counts the body's words on the way;
//   - front matter is parsed over the same line array the renderer uses,
//     so a body is never joined and re-split;
//   - templates compile once per case into flat op lists and render into
//     one flat scope object, with string pieces joined once per render;
//     templates that read only the case-level values (site, tags, recent)
//     are rendered once per (name, depth) and the string reused, since
//     the shared header, navigation and footer are identical on every
//     page of a case;
//   - slugs (and long dates) are memoised: titles and tag names repeat
//     across a site far more often than they vary.
//
// The output is byte-for-byte makefun-site 1.0.0's for every input:
// every quirk of its dialect (fence/heading/list rules, inline closers,
// front-matter refusals, template errors, link resolution, the report)
// is preserved exactly. Where in doubt, the reference code is the spec.

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
function valueOf(key, raw) {
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

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body start: { data, bodyAt }, or { error }
 * with the first reason it is refused. `lines` is the source split on
 * "\n"; the body is the lines from bodyAt, never re-joined.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    const lastCh = raw.charCodeAt(raw.length - 1);
    if (lastCh === 32 || lastCh === 9) raw = raw.replace(TRAILING_WS, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyAt: close + 1 };
}

// ---------------------------------------------------------------- markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  if (
    line.charCodeAt(0) !== 32 &&
    line.charCodeAt(0) !== 9 &&
    line.charCodeAt(line.length - 1) !== 32 &&
    line.charCodeAt(line.length - 1) !== 9
  ) {
    return line;
  }
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence-opening line's language, or null (three backticks, a language of [A-Za-z0-9_+-]*, then spaces/tabs only). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence (three backticks, then spaces/tabs only). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (1-6 #, space/tab, non-empty text). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  if (a === n) return null;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { level: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break (--- or ***, then spaces/tabs only). */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. Every kind is anchored at the first character, so one look dispatches. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9 || line.length === 0) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A bullet item's text (`- x` / `* x`), or null. */
function bulletItem(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's [start, text] (`12. x`, 1-9 digits), or null. */
function orderedItem(line) {
  let j = 0;
  while (j < 9 && j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return [Number(line.slice(0, j)), line.slice(j + 2)];
}

/** Whether `line` continues a list item (two or more spaces, then a non-whitespace character). */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  const c = line.charCodeAt(j);
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

/**
 * The words of one line: its runs of characters other than whitespace
 * (the same set /\s/ names, including the non-ASCII whitespace
 * characters). A body's word count is the sum over its lines: the "\n"
 * a join would put between them is whitespace, so no run ever spans it.
 * A plain scan beats the regex here: the /\S+/g exec loop allocates a
 * match array per word, and the loop below optimises cleanly.
 */
function countWords(line) {
  let n = 0;
  let inWord = false;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
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

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when an odd run of
 * backslashes stands right before it (each pair escapes the next, so an
 * odd run leaves one backslash to escape the match's first character,
 * which is itself escapable for the two words this is called with).
 */
function findUnescaped(s, what, from) {
  let pos = from;
  for (;;) {
    const j = s.indexOf(what, pos);
    if (j === -1) return -1;
    let n = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
    if (n % 2 === 0) return j;
    pos = j + 1;
  }
}

/**
 * The first single * from `from` (one whose run is not **), outside an
 * escape, or -1. In a run of stars the pairs cancel left to right, so a
 * single star exists exactly when the run is odd, at its last star.
 */
function findSingleStar(s, from) {
  let pos = from;
  for (;;) {
    const j = s.indexOf('*', pos);
    if (j === -1) return -1;
    let n = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
    if (n % 2 === 1) {
      pos = j + 1;
      continue;
    }
    let e = j;
    while (s[e + 1] === '*') e++;
    if ((e - j + 1) % 2 === 1) return e;
    pos = e + 1;
  }
}

/**
 * `s` rendered inline; `link(target)` is a link's href. The scan jumps
 * from one special character to the next with a regex, so a stretch of
 * plain text is copied whole instead of escaped character by character;
 * the structure (code spans, strong, emphasis, links, backslash escapes)
 * follows the reference exactly, including every no-closer fallback.
 */
function inline(s, link) {
  const re = /[\\`*\[&<>"']/g;
  let m = re.exec(s);
  if (m === null) return s;
  let out = '';
  let last = 0;
  while (m !== null) {
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
      const nx = s[at + 1];
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
      if (j > at + 1) {
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
      if (s[at + 1] === '*') {
        const j = findUnescaped(s, '**', at + 2);
        if (j > at + 2) {
          out += s.slice(last, at);
          out += '<strong>';
          out += inline(s.slice(at + 2, j), link);
          out += '</strong>';
          last = j + 2;
        } else {
          out += s.slice(last, at);
          out += '**';
          last = at + 2;
        }
      } else {
        const j = findSingleStar(s, at + 1);
        if (j > at + 1) {
          out += s.slice(last, at);
          out += '<em>';
          out += inline(s.slice(at + 1, j), link);
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
      const k = findUnescaped(s, ']', at + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out += s.slice(last, at);
        out += '<a href="';
        out += escapeHtml(link(target));
        out += '">';
        out += inline(s.slice(at + 1, k), link);
        out += '</a>';
        last = m2 + 1;
      } else {
        out += s.slice(last, at);
        out += '[';
        last = at + 1;
      }
    }
    re.lastIndex = last;
    m = re.exec(s);
  }
  out += s.slice(last);
  return out;
}

/**
 * The body at `lines[start..]` rendered in one pass: its HTML (each block
 * followed by "\n"), its table of contents (every level 2 and 3 heading),
 * its excerpt (the first paragraph's inline HTML, or "") and its word
 * count. Every line's words are counted exactly where the line is read,
 * so the pass never revisits a line.
 */
function renderBody(lines, start, link) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // Every block kind is anchored at the line's first character, so one
    // look at it dispatches: the full test runs only when the first
    // character allows a match at all.
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9 || line.length === 0) && isBlank(line)) {
      // A blank line holds no words.
      i++;
      continue;
    }
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      words += countWords(line);
      const body = [];
      i++;
      let closeLine = null;
      while (i < n) {
        const l = lines[i];
        if (isFenceClose(l)) {
          closeLine = l;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      const joined = body.join('\n');
      words += countWords(joined);
      if (closeLine !== null) words += countWords(closeLine);
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      const inner = body.length === 0 ? '' : `${escapeHtml(joined)}\n`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const h = c0 === 35 ? headingOf(line) : null;
    if (h !== null) {
      words += countWords(line);
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, link);
      blocks.push(`<h${h.level} id="${id}">${html}</h${h.level}>`);
      if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      words += countWords(line);
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        words += countWords(l);
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? bulletItem(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const item = isOrdered ? orderedItem(l) : bulletItem(l);
        if (item !== null) {
          items.push([trimLine(isOrdered ? item[1] : item)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else {
          break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered[0] !== 1 ? `<ol start="${ordered[0]}">` : `<${tag}>`;
      const parts = [`${open}\n`];
      for (const item of items) {
        const joined = item.join('\n');
        words += countWords(joined) + 1;
        parts.push(`<li>${inline(joined, link)}</li>\n`);
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const joined = body.join('\n');
    words += countWords(joined);
    const html = inline(joined, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '', words };
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
 * newline included.
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
//   [4, name, path, bodyOps]           {% for name in path %}
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
        const node = [4, m[1], pathOf(name, m[2]), []];
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
// A template whose every read (through its includes) names only the
// case-level values site, tags and recent renders the same string at
// every include site, at a given depth: those three objects are the same
// for every page of a case. Such a template — typically the shared
// header, navigation and footer, rendered hundreds of times per case —
// is rendered once per (name, depth) and the string reused.
//
// The analysis threads the loop-bound names through includes, so a read
// of a name bound by an enclosing loop inside the fragment is local to
// it and safe; a cycle contributes nothing, because the outer analysis
// of the cycled template already covers its ops under a smaller bound
// set. At an include site the cache is used only when the scope's site,
// tags and recent are still the case-level objects (a loop in the caller
// may shadow them), which the identity check proves.

const CASE_LEVEL = new Set(['site', 'tags', 'recent']);
let fragStatic = null; // Set<string>: templates safe to cache
let fragCache = null; // Map<string, Array<string|undefined>>: name -> cached string by render depth
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
 * `ops` rendered into `out` (an array of string pieces) in the flat scope
 * `vars`. A for loop writes its element and loop info into the scope and
 * restores what was there before (an absent name is restored to
 * undefined, which a lookup reads exactly as an absent name); an include
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
        const hadName = Object.hasOwn(vars, name);
        const oldName = vars[name];
        const hadLoop = Object.hasOwn(vars, 'loop');
        const oldLoop = vars.loop;
        for (let k = 0; k < len; k++) {
          if (name !== 'loop') vars[name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderOps(body, vars, out, depth, templates);
        }
        vars[name] = hadName ? oldName : undefined;
        if (name !== 'loop') vars.loop = hadLoop ? oldLoop : undefined;
        break;
      }
      case 5: {
        if (depth < INCLUDE_DEPTH) {
          const t = templates.get(op[1]);
          if (t !== undefined) {
            if (fragStatic.has(op[1]) && vars.site === fragSite && vars.tags === fragTags && vars.recent === fragRecent) {
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
              renderOps(t, vars, out, depth + 1, templates);
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

/** A link target's href: kept as written with a scheme, a leading / or #; otherwise resolved to a page, a static file, or reported broken. */
function resolveLink(target, dir, bySource, staticPaths, base, broken, sourcePath) {
  if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const page = bySource.get(path);
    if (page !== undefined) return page.url + frag;
    if (staticPaths.has(path)) return `${base}/${path}${frag}`;
  }
  broken.add(`broken-link ${sourcePath} -> ${target}`);
  return target;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
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

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagList,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
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
        lines: text.split('\n'),
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
    const fm = parseFrontMatter(s.lines);
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
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(target, dir, bySource, staticPaths, base, broken, s.path);
    const md = renderBody(s.lines, s.bodyAt, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
    s.lines = null;
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
  fragCache = new Map();
  fragSite = site;
  fragTags = allTags;
  fragRecent = recent;
  const output = {};
  // One scope object for every render of this case: the per-render keys
  // are overwritten (to undefined when absent, which a lookup reads
  // exactly as an absent name) and the loop bindings renderOps leaves
  // behind are undefined-valued for the same reason.
  const scope = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    const out = [];
    renderOps(ops, scope, out, 0, templates);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
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
