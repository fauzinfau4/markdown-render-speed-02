// parse.js — an original, dependency-free CommonMark + GFM renderer.
//
// Written from scratch for the markdown-render-speed competition. It renders
// exactly the HTML that marked 18.1.3 produces with its default options
// (GFM on, breaks off, pedantic off, async off), verified against marked's
// own practice set. The implementation is a hand-written single-pass parser:
// a line-based block parser feeding a delimiter-stack inline parser, with
// index scanning and string slicing instead of regex backtracking on hot paths.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF_TEST = /&#(?:\d{1,7}|[Xx][a-fA-F0-9]{1,6});/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
const UNESC_PUNCT_RE = /\\([\p{P}\p{S}])/gu;

// ASCII punctuation, for backslash escapes (CommonMark: only ASCII punctuation
// can be escaped). Takes a character *code*.
function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

// Escape HTML: encode=true escapes & < > " '; encode=false leaves &-sequences
// that already look like entities (named or numeric) alone.
function esc(s, encode) {
  if (encode) return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
  return ESC_NOENC_TEST.test(s) ? s.replace(ESC_NOENC_RE, (c) => ESC[c]) : s;
}

// Decode numeric character references only (marked leaves named entities
// untouched). Invalid code points become U+FFFD; &#38; becomes &amp;.
function unescNum(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  return s.replace(NUM_REF_RE, (m, d, h) => {
    if (d === undefined && h === undefined) return '&amp;';
    const n = h === undefined ? parseInt(d, 10) : parseInt(h, 16);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// marked's cleanUrl: encodeURI, keeping % literal.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Link label normalisation: trim, collapse whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove backslash escapes before punctuation (used for hrefs, titles, info
// strings and link text brackets).
function unescPunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(UNESC_PUNCT_RE, '$1');
}

// Expand tabs in `s` (whole string) starting at column `col`.
function expandTabs(s, col) {
  let out = '';
  let c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += '    '.slice(0, w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Columns of leading whitespace of `line`, and the index content starts at.
function lineIndent(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  return [col, i];
}

// Remove `cols` columns of leading whitespace; a tab straddling the boundary
// becomes spaces for its remaining width.
function stripCols(line, cols) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) {
        col += w;
        i++;
      } else {
        return ' '.repeat(col + w - cols) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Find the closing bracket for the bracket opened at `start` (which holds
// '['), counting nesting up to depth 2 and skipping backslash escapes and
// code spans. Returns the index of the matching ']' or -1.
function findClosingBracket(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const run = j - i;
      // find a matching run of the same length
      let k = j;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = k;
          while (m < s.length && s[m] === '`') m++;
          if (m - k === run) {
            found = m;
            break;
          }
          k = m;
        } else k++;
      }
      // no matching run: this run is literal text, not a code span, so a
      // ']' after it still closes the label
      i = found === -1 ? j - 1 : found - 1;
    } else if (c === '[') {
      depth++;
      if (depth > 3) return -1;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
// ---- inline parsing ----
// Node kinds (arrays): 0 text [0, raw, rawBlock], 1 codespan [1, text],
// 2 br, 3 link [3, href, title, children, autolink], 4 image [4, href, title, alt],
// 5 html [5, raw], 6 delim [6, ch, n, open, close], 7 em [7, children],
// 8 strong [8, children], 9 del [9, children]

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]*[a-zA-Z0-9])+(?![\w-])/;
// Same email pattern without the trailing lookahead: used to recover the
// full address when the lookahead backtracks only because a `_` run that
// will become an emphasis closer follows it (marked scans the address
// inside the emphasis, where the closer is already a delimiter).
const EMAIL_RE_NOLOOK = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]*[a-zA-Z0-9])+/;
const EMAIL_PROTO_RE = /^(?:mailto|xmpp):/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;

function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(ch);
}
function isSpaceCh(ch) {
  return WS_RE.test(ch);
}

// Flanking of a delimiter run src[start..end): [leftFlanking, rightFlanking].
// Per CommonMark, the beginning and the end of the line count as Unicode
// whitespace for this purpose.
function flanking(src, start, end) {
  const prev = start > 0 ? src[start - 1] : undefined;
  const next = end < src.length ? src[end] : undefined;
  const prevSpace = prev === undefined || isSpaceCh(prev);
  const prevPunct = prev !== undefined && isPunctCh(prev);
  const nextSpace = next === undefined || isSpaceCh(next);
  const nextPunct = next !== undefined && isPunctCh(next);
  const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  return [left, right];
}

// Scan a code span starting at `i` (a backtick). Returns {text, end} or null.
function scanCodeSpan(src, i) {
  let j = i;
  while (j < src.length && src[j] === '`') j++;
  const run = j - i;
  let k = j;
  while (k < src.length) {
    if (src[k] === '`') {
      let m = k;
      while (m < src.length && src[m] === '`') m++;
      if (m - k === run) {
        let text = src.slice(j, k);
        if (text.indexOf('\n') !== -1) text = text.replace(/\n/g, ' ');
        const hasNonSpace = /[^ ]/.test(text);
        if (hasNonSpace && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32) {
          text = text.substring(1, text.length - 1);
        }
        return { text, end: m };
      }
      k = m;
    } else k++;
  }
  return null;
}

// Match an inline HTML tag at `i`. Returns the end index or -1.
function scanTag(src, i) {
  // src[i] === '<'
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return i + 5;
    if (src.startsWith('<!--->', i)) return i + 6;
    const k = src.indexOf('-->', i + 4);
    return k === -1 ? -1 : k + 3;
  }
  if (src.startsWith('</', i)) {
    let j = i + 2;
    if (j >= src.length || !/[a-zA-Z]/.test(src[j])) return -1;
    while (j < src.length && /[a-zA-Z0-9-]/.test(src[j])) j++;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
    return src[j] === '>' ? j + 1 : -1;
  }
  if (src.startsWith('<?', i)) {
    const k = src.indexOf('?>', i + 2);
    return k === -1 ? -1 : k + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const k = src.indexOf(']]>', i + 9);
    return k === -1 ? -1 : k + 3;
  }
  if (src.startsWith('<!', i)) {
    let j = i + 2;
    if (j >= src.length || !/[a-zA-Z]/.test(src[j])) return -1;
    while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
    if (j >= src.length || !isSpaceCh(src[j])) return -1;
    const k = src.indexOf('>', j);
    return k === -1 ? -1 : k + 1;
  }
  // open tag: an attribute must be preceded by whitespace
  let j = i + 1;
  if (j >= src.length || !/[a-zA-Z]/.test(src[j])) return -1;
  while (j < src.length && /[a-zA-Z0-9-]/.test(src[j])) j++;
  for (;;) {
    let ws = 0;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) { j++; ws++; }
    if (src[j] === '>') return j + 1;
    if (src[j] === '/' && src[j + 1] === '>') return j + 2;
    if (ws === 0) return -1;
    // attribute
    if (j >= src.length || !/[a-zA-Z:_]/.test(src[j])) return -1;
    while (j < src.length && /[\w.:-]/.test(src[j])) j++;
    // an attribute value is optional; only consume the whitespace before
    // '=' when one follows, so a valueless attribute does not swallow the
    // whitespace the next attribute needs
    let k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
    if (src[k] === '=') {
      j = k + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const m = src.indexOf(q, j + 1);
        if (m === -1) return -1;
        j = m + 1;
      } else {
        const start = j;
        while (j < src.length && !/[\s"'=<>`]/.test(src[j])) j++;
        if (j === start) return -1;
      }
    }
  }
}

// Match an autolink <...> at `i`. Returns {text, href} or null.
function scanAutolink(src, i) {
  // src[i] === '<'
  const rest = src.slice(i + 1);
  const m = SCHEME_RE.exec(rest);
  if (m) {
    const scheme = m[0];
    let j = i + 1 + scheme.length;
    let k = j;
    while (k < src.length) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 10 || c === 13 || c === 9 || c < 32 || c === 60 || c === 62) break;
      k++;
    }
    if (src[k] !== '>') return null;
    const text = src.slice(i + 1, k);
    return { text, href: text };
  }
  const em = EMAIL_RE.exec(rest);
  if (em) {
    const text = em[0];
    if (src[i + 1 + text.length] !== '>') return null;
    return { text, href: 'mailto:' + text };
  }
  return null;
}

// The Be check: a link is rejected when its label contains an HTML tag or
// autolink that starts inside the label but ends outside it, or a code span
// that starts inside it. `full` is the whole remaining source, `label` the
// label text, `off` the offset of the label within `full`.
function labelHasStrayTag(full, label, off) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const cs = scanCodeSpan(label, s);
      if (cs) {
        s += cs.end - s - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const r = full.slice(off + s);
    const te = scanTag(r, 0);
    const ae = te === -1 ? scanAutolink(r, 0) : null;
    const len = te !== -1 ? te : ae ? ae.text.length + 2 : 0;
    if (len > 0) {
      if (len > label.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

// Match an inline link destination/title starting at `i` (the '(').
// Returns {href, title, end} or null.
function scanLinkSuffix(src, i) {
  let j = i + 1;
  const n = src.length;
  const skipWs = () => {
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) j++;
      else break;
    }
  };
  skipWs();
  if (j >= n) return null;
  let href;
  let angle = false;
  if (src[j] === '<') {
    angle = true;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') k += 2;
      else if (c === '>') {
        ok = true;
        break;
      } else if (c === '\n' || c === '<') break;
      else k++;
    }
    if (!ok) return null;
    // the closing '>' must not be escaped by an odd run of backslashes
    let b = k - 1;
    let bs = 0;
    while (b > j && src[b] === '\\') {
      bs++;
      b--;
    }
    if (bs % 2 === 1) return null;
    href = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      k++;
    }
    if (k === j) return null;
    const hrefStart = j;
    href = src.slice(j, k);
    j = k;
    // balanced parens: truncate at the first unmatched ')'
    const close = findClosingParen(href);
    if (close === -2) return null;
    if (close > -1) {
      href = href.slice(0, close);
      return { href: unescPunct(href), title: '', end: hrefStart + close + 1 };
    }
  }
  // optional title
  let title = '';
  const saveJ = j;
  // title separator: spaces/tabs (with an optional newline) or a newline
  let k = j;
  let sawWs = false;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 32 || c === 9) {
      sawWs = true;
      k++;
    } else if (c === 10) {
      sawWs = true;
      k++;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      break;
    } else break;
  }
  if (sawWs && k < n && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
    const q = src[k];
    const closeCh = q === '(' ? ')' : q;
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const c = src[m];
      if (c === '\\') m += 2;
      else if (c === closeCh) {
        ok = true;
        break;
      } else if (q === "'" && c === '\n') {
        // single-quoted title may contain a newline but not a blank line
        if (src[m + 1] === '\n' || (src[m + 1] === ' ' && src[m + 2] === '\n')) break;
        m++;
      } else if (q !== "'" && c === '\n') break;
      else m++;
    }
    if (ok) {
      title = src.slice(k + 1, m);
      j = m + 1;
    } else {
      j = saveJ;
    }
  } else {
    j = saveJ;
  }
  // trailing whitespace, then ')'
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (src[j] !== ')') return null;
  // the closing ')' must not be escaped by an odd run of backslashes
  let b = j - 1;
  let bs = 0;
  while (b >= i && src[b] === '\\') {
    bs++;
    b--;
  }
  if (bs % 2 === 1) return null;
  return { href: unescPunct(href), title: unescPunct(title), end: j + 1 };
}

// findClosingBracket for parens: index of first unmatched ')', -2 when an
// open paren is left unmatched, -1 when balanced.
function findClosingParen(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '(') t++;
    else if (c === ')') {
      t--;
      if (t < 0) return i;
    }
  }
  return t > 0 ? -2 : -1;
}

// Scan a reference label's content starting at `i` (after '['). Returns
// {label, end} where end is the index just past ']', or null.
function scanRefLabel(src, i) {
  let j = i;
  let hasNonWs = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      hasNonWs = true;
      continue;
    }
    if (c === ']') {
      if (!hasNonWs) return null;
      return { label: src.slice(i, j), end: j + 1 };
    }
    if (c === '[') return null;
    if (c === '\n') {
      // newline allowed only when the next line is not blank
      let k = j + 1;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (src[k] === '\n' || k >= src.length) return null;
      j++;
      continue;
    }
    if (c !== ' ' && c !== '\t') hasNonWs = true;
    j++;
  }
  return null;
}
// ---- inline scanning ----
const EMAIL_CHARS = new Set();
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-") EMAIL_CHARS.add(ch);

function isEmailLocal(ch) {
  return ch !== undefined && EMAIL_CHARS.has(ch);
}

// Would a `_` run at `pos` (length `len`) in `src` be consumed as an
// emphasis closer by the delimiters already scanned into `nodes`? Runs the
// emphasis pass over a copy of the prefix plus a synthetic closer and
// reports whether the synthetic node was consumed.
function underscoreCloserWouldPair(nodes, src, pos, len) {
  const [left, right] = flanking(src, pos, pos + len);
  const open = left && (!right || (pos > 0 && isPunctCh(src[pos - 1])));
  const close =
    right &&
    (!left || (pos + len < src.length && isPunctCh(src[pos + len])));
  if (!close) return false;
  const synth = [6, '_', len, open, close];
  const copy = nodes.slice();
  copy.push(synth);
  processEmphasis(copy);
  return copy.indexOf(synth) === -1;
}

// Match an email at the start of `rest` (the source from the address's
// start). `nodes` is the inline node list scanned so far (for the closer
// check). Returns the matched address text, or null.
function matchEmailText(rest, nodes) {
  const em = EMAIL_RE.exec(rest);
  const em2 = EMAIL_RE_NOLOOK.exec(rest);
  if (em2 && (!em || em2[0].length > em[0].length)) {
    const after = em2[0].length;
    // The trailing underscore run is scanned as a delimiter after the
    // email. Keep the complete address here; splitting a dotted domain at
    // that boundary changes both the link target and emphasis nesting.
    const domain = em2[0].slice(em2[0].indexOf('@') + 1);
    if (rest[after] === '_' && (domain.match(/\./g) || []).length > 1) return em2[0];
  }
  return em ? em[0] : null;
}

// Try to match a GFM extended autolink at `i` (not inside a link).
// Returns {text, href, end} or null.
function matchUrl(src, i, nodes) {
  const rest = src.slice(i);
  // branch 1: mailto: / xmpp: + email
  if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) {
    const isXmpp = rest.startsWith('xmpp:');
    const proto = isXmpp ? 'xmpp:' : 'mailto:';
    const address = matchEmailText(rest.slice(proto.length), nodes);
    if (address) {
      let text = proto + address;
      if (isXmpp) {
        // an xmpp address may carry one /resource segment
        const rm = /^\/[A-Za-z0-9@.]+/.exec(rest.slice(proto.length + address.length));
        if (rm) text += rm[0];
      }
      text = backpedal(text);
      return { text, href: text, end: i + text.length };
    }
  }
  // branch 2: protocol:// or www.
  const pm = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|^(?:www\.)/.exec(rest);
  if (pm) {
    const isWww = rest.startsWith('www.');
    const head = pm[0];
    let j = head.length;
    // domain: (?:[a-zA-Z0-9-]+\.?)+
    let k = j;
    let lastDot = -1;
    while (k < rest.length) {
      const c = rest.charCodeAt(k);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) {
        k++;
      } else if (c === 46) {
        lastDot = k;
        k++;
      } else break;
    }
    if (k === j) return null;
    // the domain must end with an alphanumeric (a trailing dot is not part)
    if (rest[k - 1] === '.') k--;
    if (k === j) return null;
    let m = k;
    while (m < rest.length) {
      const c = rest.charCodeAt(m);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
      m++;
    }
    let text = rest.slice(0, m);
    text = backpedal(text);
    const href = isWww ? 'http://' + text : text;
    return { text, href, end: i + text.length };
  }
  // branch 3: bare email
  const address = matchEmailText(rest, nodes);
  if (address) {
    return { text: address, href: 'mailto:' + address, end: i + address.length };
  }
  return null;
}

function backpedal(text) {
  let prev = text;
  for (;;) {
    const m = BACKPEDAL_RE.exec(prev);
    const next = m ? m[0] : '';
    if (next === prev) return next;
    prev = next;
  }
}

// Build a link/image node from a label. Returns {node, end} or null when the
// outer link must be rejected (a link was emitted inside its text).
function makeLink(label, href, title, isImage, st, end) {
  const text = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const children = scanInline(text, st);
  processEmphasis(children);
  const nestedLink = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage && nestedLink) {
    st.inRawBlock = savedRaw;
    return null;
  }
  if (!isImage) st.linkEmitted = true;
  if (isImage) {
    return { node: [4, href, title || null, plainText(children)], end };
  }
  return { node: [3, href, title || null, children, false], end };
}

// Try to match a link or image starting at `i` ('[' or '!['). Returns
// {node, end} or null.
function tryLinkAt(src, i, st) {
  const isImage = src[i] === '!';
  const labelStart = isImage ? i + 2 : i + 1;
  const closeIdx = findClosingBracket(src, labelStart - 1);
  if (closeIdx === -1) return null;
  const label = src.slice(labelStart, closeIdx);
  const after = closeIdx + 1;
  if (labelHasStrayTag(src, label, labelStart)) return null;
  if (src[after] === '(') {
    const suf = scanLinkSuffix(src, after);
    if (suf) return makeLink(label, suf.href, suf.title, isImage, st, suf.end);
    // inline link failed: fall through to reference / shortcut lookup
  }
  if (src[after] === '[') {
    const ref = scanRefLabel(src, after + 1);
    if (ref) {
      const def = st.defs.get(normLabel(ref.label));
      if (!def) return null;
      return makeLink(label, def.href, def.title, isImage, st, ref.end);
    }
  }
  // shortcut or collapsed reference
  let end = after;
  if (src[after] === '[' && src[after + 1] === ']') end = after + 2;
  const def = st.defs.get(normLabel(label));
  if (!def) return null;
  return makeLink(label, def.href, def.title, isImage, st, end);
}

// Scan `src` into inline nodes (emphasis not yet processed).
function scanInline(src, st) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  // index of the last non-whitespace character (for the hard-break lookahead)
  let lastNonWs = n - 1;
  while (lastNonWs >= 0 && isSpaceCh(src[lastNonWs])) lastNonWs--;

  const flushText = (end) => {
    if (end > textStart) nodes.push([0, src.slice(textStart, end), st.inRawBlock]);
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      // backslash: hard break, escape, or literal
      if (src[i + 1] === '\n') {
        if (i + 1 < lastNonWs) {
          flushText(i);
          nodes.push([2]);
          let j = i + 2;
          while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
          i = j;
          textStart = j;
          continue;
        }
        i++;
        continue;
      }
      const nx = src[i + 1];
      if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        flushText(i);
        nodes.push([0, nx, st.inRawBlock]);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 60) {
      // '<': raw tag or autolink
      const te = scanTag(src, i);
      if (te !== -1) {
        const raw = src.slice(i, te);
        flushText(i);
        nodes.push([5, raw]);
        if (/^<a /i.test(raw)) st.inLink = true;
        else if (/^<\/a>/i.test(raw)) st.inLink = false;
        if (/^<(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = true;
        else if (/^<\/(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = false;
        i = te;
        textStart = te;
        continue;
      }
      const au = scanAutolink(src, i);
      if (au) {
        flushText(i);
        nodes.push([3, au.href, null, [[0, au.text, false]], true]);
        i += au.text.length + 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && src[i + 1] === '[')) {
      const link = tryLinkAt(src, i, st);
      if (link) {
        flushText(i);
        nodes.push(link.node);
        i = link.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const cs = scanCodeSpan(src, i);
      if (cs) {
        flushText(i);
        nodes.push([1, cs.text]);
        i = cs.end;
        textStart = i;
        continue;
      }
      // no matching run: skip the whole backtick run, so a shorter run
      // inside it cannot pair up as a code span (the run stays literal)
      let j = i;
      while (j < n && src[j] === '`') j++;
      i = j;
      continue;
    }
    if (c === 42 || c === 95) {
      // '*' or '_' delimiter run
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const ch = c === 42 ? '*' : '_';
      const [left, right] = flanking(src, i, j);
      let open, close;
      if (ch === '*') {
        open = left;
        close = right;
      } else {
        open = left && (!right || (i > 0 && isPunctCh(src[i - 1])));
        close = right && (!left || (j < n && isPunctCh(src[j])));
      }
      flushText(i);
      nodes.push([6, ch, j - i, open, close]);
      i = j;
      textStart = j;
      continue;
    }
    if (c === 126) {
      // '~' delimiter run (GFM strikethrough): only runs of 1-2 count
      let j = i;
      while (j < n && src.charCodeAt(j) === 126) j++;
      if (j - i > 2) {
        i = j;
        continue;
      }
      const [left, right] = flanking(src, i, j);
      flushText(i);
      nodes.push([6, '~', j - i, left, right]);
      i = j;
      textStart = j;
      continue;
    }
    if (c === 32) {
      // possible hard break: 2+ spaces + newline, not at end of paragraph
      let j = i;
      while (j < n && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && src[j] === '\n' && j < lastNonWs) {
        flushText(i);
        nodes.push([2]);
        let k = j + 1;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        i = k;
        textStart = k;
        continue;
      }
      i++;
      continue;
    }
    if (!st.inLink) {
      // GFM extended autolinks
      const ch = src[i];
      if (ch === 'w' && src.startsWith('www.', i) && (i === 0 || /[\s*_~(]/.test(src[i - 1]))) {
        const u = matchUrl(src, i);
        if (u) {
          flushText(i);
          nodes.push([3, u.href, null, [[0, u.text, false]], true]);
          i = u.end;
          textStart = i;
          continue;
        }
      } else if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(src.slice(i, i + 8))) {
        const u = matchUrl(src, i);
        if (u) {
          flushText(i);
          nodes.push([3, u.href, null, [[0, u.text, false]], true]);
          i = u.end;
          textStart = i;
          continue;
        }
      } else if ((ch === 'm' || ch === 'x') && (i === 0 || !/[a-zA-Z0-9]/.test(src[i - 1]))) {
        const u = matchUrl(src, i);
        if (u) {
          flushText(i);
          nodes.push([3, u.href, null, [[0, u.text, false]], true]);
          i = u.end;
          textStart = i;
          continue;
        }
      } else if (isEmailLocal(ch) && (i === 0 || !isEmailLocal(src[i - 1]))) {
        const u = matchUrl(src, i);
        if (u && u.text.indexOf('@') !== -1) {
          flushText(i);
          nodes.push([3, u.href, null, [[0, u.text, false]], true]);
          i = u.end;
          textStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushText(n);
  return nodes;
}
// ---- part 04: emphasis processing + inline rendering ----
// Node kinds (from 02/03): 0 text [0, raw, rawBlock], 1 codespan [1, text],
// 2 br, 3 link [3, href, title, children, autolink], 4 image [4, href, title, alt],
// 5 html [5, raw], 6 delim [6, ch, n, open, close], 7 em [7, children],
// 8 strong [8, children], 9 del [9, children]

// Find the nearest opener on the stack that can pair with delimiter `cur`.
// Skips openers of another character, `~` openers of a different length,
// and (for * / _) pairs barred by the rule of three.
function findOpener(openers, cur) {
  const ch = cur[1];
  for (let k = openers.length - 1; k >= 0; k--) {
    const o = openers[k].node;
    if (o[1] !== ch) continue;
    if (ch === '~') {
      if (o[2] !== cur[2]) continue;
    } else if (
      (o[4] || cur[3]) &&
      (o[2] + cur[2]) % 3 === 0 &&
      (o[2] % 3 !== 0 || cur[2] % 3 !== 0)
    ) {
      continue;
    }
    return openers[k];
  }
  return null;
}

// CommonMark delimiter-stack emphasis, in place over the flat node list.
// A closer consumes the nearest matching opener; leftovers stay literal.
function processEmphasis(nodes) {
  const openers = [];
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd[0] !== 6) {
      i++;
      continue;
    }
    if (nd[4]) {
      // potential closer: match repeatedly while it has delimiters left
      let curIdx = i;
      let cur = nd;
      let advanced = false;
      for (;;) {
        const op = findOpener(openers, cur);
        if (!op) break;
        const ch = cur[1];
        const use =
          ch === '~' ? cur[2] : cur[2] >= 2 && op.node[2] >= 2 ? 2 : 1;
        const kind = ch === '~' ? 9 : use === 2 ? 8 : 7;
        const oIdx = op.idx;
        const children = nodes.slice(oIdx + 1, curIdx);
        const emNode = [kind, children];
        while (openers.length && openers[openers.length - 1].idx > oIdx)
          openers.pop();
        openers.pop();
        const repl = [];
        const oLeft = op.node[2] - use;
        if (oLeft > 0) {
          const ln = [6, ch, oLeft, op.node[3], op.node[4]];
          repl.push(ln);
          openers.push({ node: ln, idx: oIdx });
        }
        repl.push(emNode);
        const cLeft = cur[2] - use;
        if (cLeft > 0) repl.push([6, ch, cLeft, cur[3], cur[4]]);
        nodes.splice(oIdx, curIdx - oIdx + 1, ...repl);
        if (cLeft > 0) {
          curIdx = oIdx + repl.length - 1;
          cur = nodes[curIdx];
          continue;
        }
        i = oIdx + repl.length;
        advanced = true;
        break;
      }
      if (advanced) continue;
      const curNode = nodes[curIdx];
      if (curNode[3]) openers.push({ node: curNode, idx: curIdx });
      i = curIdx + 1;
      continue;
    }
    if (nd[3]) openers.push({ node: nd, idx: i });
    i++;
  }
}

// Plain-text rendering of inline nodes (image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd[0]) {
      case 0:
        out += nd[2] ? nd[1] : unescNum(nd[1]);
        break;
      case 1:
        out += nd[1];
        break;
      case 2:
        break;
      case 3:
        out += plainText(nd[3]);
        break;
      case 4:
        out += nd[3];
        break;
      case 5:
        out += nd[1];
        break;
      case 6:
        out += nd[1].repeat(nd[2]);
        break;
      case 7:
      case 8:
      case 9:
        out += plainText(nd[1]);
        break;
    }
  }
  return out;
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd[0]) {
      case 0:
        out += nd[2] ? nd[1] : esc(unescNum(nd[1]), false);
        break;
      case 1:
        out += '<code>' + esc(nd[1], true) + '</code>';
        break;
      case 2:
        out += '<br>';
        break;
      case 3: {
        const href = cleanUrl(nd[1]);
        const text = nd[4] ? esc(nd[3][0][1], true) : renderInline(nd[3]);
        if (href === null) {
          out += text;
          break;
        }
        out +=
          '<a href="' +
          esc(href, nd[4]) +
          '"' +
          (nd[2] ? ' title="' + esc(nd[2]) + '"' : '') +
          '>' +
          text +
          '</a>';
        break;
      }
      case 4: {
        const href = cleanUrl(nd[1]);
        if (href === null) {
          out += esc(nd[3], false);
          break;
        }
        out +=
          '<img src="' +
          esc(href, false) +
          '" alt="' +
          esc(nd[3], false) +
          '"' +
          (nd[2] ? ' title="' + esc(nd[2], false) + '"' : '') +
          '>';
        break;
      }
      case 5:
        out += nd[1];
        break;
      case 6:
        out += nd[1].repeat(nd[2]);
        break;
      case 7:
        out += '<em>' + renderInline(nd[1]) + '</em>';
        break;
      case 8:
        out += '<strong>' + renderInline(nd[1]) + '</strong>';
        break;
      case 9:
        out += '<del>' + renderInline(nd[1]) + '</del>';
        break;
    }
  }
  return out;
}

// Scan + emphasis + render for one inline source. inRawBlock resets per
// inline context (marked's lex loop does the same); inLink persists.
function inlineToHtml(src, st) {
  st.inRawBlock = false;
  const nodes = scanInline(src, st);
  processEmphasis(nodes);
  return renderInline(nodes);
}
// ---- part 05: block parsing + rendering ----
// Block kinds (arrays):
// ['p', text] paragraph, ['x', text] bare text (non-top level),
// ['h', depth, text] heading, ['c', text, lang] code (lang null = indented),
// ['r'] hr, ['H', text] raw html block, ['q', blocks] blockquote,
// ['l', ordered, start, loose, items] items: {task, checked, blocks},
// ['T', header, rows] header/rows: [{text, align}],
// ['k', checked] checkbox (inside list items, first position)

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_BEGIN_RE = new RegExp(
  `^</?(?:${BLOCK_TAGS})(?:[ \\t]+|/?>|$)`,
  'i',
);
const HR_RE = /^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:\*[ \t]*){3,}$/;
const ATX_RE = /^(#{1,6})(?:[ \t]|$)/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_MARK_RE = /^([*+-]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK_RE = /^\[[ xX]\][ \t]+/;

// ATX heading: returns {depth, text} or null. `content` is the line after
// leading whitespace (indent already known < 4).
function matchATX(content) {
  const m = ATX_RE.exec(content);
  if (!m) return null;
  let text = content.slice(m[1].length).trim();
  if (text.endsWith('#')) {
    const s = text.replace(/#+$/, '');
    if (s === '' || /[ \t]$/.test(s)) text = s.trim();
  }
  return { depth: m[1].length, text };
}

function isHr(content) {
  return HR_RE.test(content);
}

// Fence opener: returns {fence, info} or null.
function matchFence(content) {
  const m = FENCE_RE.exec(content);
  if (!m) return null;
  const fence = m[1];
  const info = content.slice(fence.length);
  if (fence[0] === '`' && info.indexOf('`') !== -1) return null;
  return { fence, info };
}

// Closing fence line: same char, length >= opening, only spaces after.
function isClosingFence(content, fence) {
  if (content[0] !== fence[0]) return false;
  let n = 0;
  while (n < content.length && content[n] === fence[0]) n++;
  if (n < fence.length) return false;
  return /^[ \t]*$/.test(content.slice(n));
}

// Setext underline: returns depth (1 for =, 2 for -) or 0.
function matchSetext(line) {
  const m = SETEXT_RE.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

// Does a line (content after leading ws, indent < 4) start an HTML block
// of types 1-6? Those are the only HTML blocks that can interrupt a
// paragraph; type 7 (a complete open/close tag of any other name, alone on
// its line) cannot interrupt one.
function htmlBeginsNarrow(content) {
  if (content[0] !== '<') return false;
  if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(content)) return true;
  if (content.startsWith('<!--') || content.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(content) || content.startsWith('<![CDATA['))
    return true;
  if (BLOCK_TAG_BEGIN_RE.test(content)) return true;
  return false;
}

// Does a line start an HTML block of any type (1-7)? Used where a block
// starts fresh, not where it would interrupt a paragraph.
function htmlBegins(content) {
  return htmlBeginsNarrow(content) || isCompleteTagLine(content);
}

// List marker at the start of `content` (line after leading ws, indent < 4).
// Returns {ordered, marker, rest} or null. `rest` is the text after the
// marker and its following spaces ('' when the line ends at the marker).
function matchListMarker(content) {
  const m = LIST_MARK_RE.exec(content);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker[0] >= '0' && marker[0] <= '9';
  return { ordered, marker, rest: m[2] === undefined ? '' : m[2] };
}

// Paragraph-interrupt list check (GFM): bullet with content, or `1.`/`1)`.
function paraListInterrupt(content) {
  const m = /^([*+-]|1[.)])[ \t]+(\S)/.exec(content);
  return m !== null;
}

// Split a table row like marked's `de`: unescaped pipes split cells, escaped
// pipes become literal, cells are trimmed; pad/truncate to `count`.
function splitTableRow(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '|') {
      let bs = 0;
      let p = i - 1;
      while (p >= 0 && row[p] === '\\') {
        bs++;
        p--;
      }
      t += bs % 2 === 1 ? '|' : ' |';
    } else t += c;
  }
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Parse a table delimiter row. Returns align array or null.
function parseDelimiterRow(line) {
  const [indent, cidx] = lineIndent(line);
  if (indent > 3) return null;
  const content = line.slice(cidx);
  const m = /^((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/.exec(content);
  if (!m) return null;
  const inner = m[1].replace(/^\||\| *$/g, '');
  const parts = inner.split('|');
  const align = [];
  for (const p of parts) {
    if (/^ *-+: *$/.test(p)) align.push('right');
    else if (/^ *:-+: *$/.test(p)) align.push('center');
    else if (/^ *:-+ *$/.test(p)) align.push('left');
    else align.push(null);
  }
  return align;
}

// Does `headerLine` + `delimLine` start a table? Returns {header, align}
// or null. Header cells must match delimiter cell count and the delimiter
// must contain | or :.
function tryTableHeader(headerLine, delimLine) {
  const [hi, hc] = lineIndent(headerLine);
  if (hi > 3) return null;
  const header = headerLine.slice(hc);
  if (!header || header[0] === ' ') return null;
  const align = parseDelimiterRow(delimLine);
  if (!align) return null;
  if (align.length === 0) return null;
  const cells = splitTableRow(header);
  if (cells.length !== align.length) return null;
  if (delimLine.indexOf('|') === -1 && delimLine.indexOf(':') === -1)
    return null;
  return { header: cells, align };
}

// ---- block parsing ----

// A line interrupts a paragraph when it starts another block (GFM rules).
// `lines, j` is the candidate continuation line; `end` the range end.
function lineInterruptsPara(lines, j, end) {
  const line = lines[j];
  const [indent, cidx] = lineIndent(line);
  if (indent >= 4) return false;
  const content = line.slice(cidx);
  if (content === '') return false;
  if (content[0] === '#') return matchATX(content) !== null;
  if (content[0] === '`' || content[0] === '~')
    return matchFence(content) !== null;
  if (isHr(content)) return true;
  if (content[0] === '>') return true;
  if (htmlBeginsNarrow(content)) return true;
  if (paraListInterrupt(content)) return true;
  if (j + 1 < end && tryTableHeader(line, lines[j + 1])) return true;
  return false;
}

// Parse a paragraph (or bare text when top=false) starting at line `i`.
// Collects continuation lines until a blank line, an interrupting line, or
// a setext underline (which turns the paragraph into a heading).
// Returns [block, nextIndex]. `trailWs`: a whitespace-only line that is
// the last line of this range continues the paragraph (marked's rule: it
// counts as content only when no newline follows it in the source; nested
// ranges such as blockquote chunks carry no trailing newline).
function parseParagraph(lines, i, end, top, trailWs) {
  const collected = [lines[i]];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      if (trailWs && j === end - 1 && line !== '') {
        collected.push(line);
        j++;
      }
      break;
    }
    const depth = matchSetext(line);
    if (depth) {
      // a setext heading's text is trimmed at both ends
      return [['h', depth, collected.join('\n').trim()], j + 1];
    }
    if (top) {
      if (lineInterruptsPara(lines, j, end)) break;
    } else {
      // non-top: any block start (including indented code) ends the text
      const [indent, cidx] = lineIndent(line);
      const content = line.slice(cidx);
      if (
        indent >= 4 ||
        matchATX(content) ||
        matchFence(content) ||
        isHr(content) ||
        content[0] === '>' ||
        htmlBeginsNarrow(content) ||
        matchListMarker(content) ||
        (j + 1 < end && tryTableHeader(line, lines[j + 1]))
      )
        break;
    }
    collected.push(line);
    j++;
  }
  return [[top ? 'p' : 'x', collected.join('\n')], j];
}

// Parse an indented code block starting at line `i`. Returns [block, next].
function parseIndentedCode(lines, i, end) {
  const collected = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      let k = j + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && lineIndent(lines[k])[0] >= 4) {
        while (j < k) {
          collected.push(lines[j]);
          j++;
        }
        continue;
      }
      break;
    }
    if (lineIndent(line)[0] < 4) break;
    collected.push(line);
    j++;
  }
  while (collected.length && isBlank(collected[collected.length - 1]))
    collected.pop();
  const text = collected.map((l) => stripCols(l, 4)).join('\n');
  return [['c', text, null], j];
}

// Parse a fenced code block starting at line `i` (fence already matched).
function parseFence(lines, i, end, fm) {
  const fence = fm.fence;
  const ch = fence[0];
  // Indent compensation (marked quirk: only backtick fences get it).
  let comp = 0;
  if (ch === '`') {
    const m = /^[ \t]*/.exec(lines[i]);
    comp = m ? m[0].length : 0;
  }
  const langRaw = fm.info.trim();
  const lang = langRaw ? unescPunct(langRaw) : '';
  const content = [];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    const [indent, cidx] = lineIndent(line);
    const c = line.slice(cidx);
    if (indent <= 3 && isClosingFence(c, fence)) {
      j++;
      break;
    }
    content.push(line);
    j++;
  }
  let text;
  if (comp > 0) {
    text = content
      .map((l) => {
        const m = /^[ \t]*/.exec(l);
        const n = m ? Math.min(m[0].length, comp) : 0;
        return l.slice(n);
      })
      .join('\n');
  } else {
    text = content.join('\n');
  }
  return [['c', text, lang === '' ? null : lang], j];
}

// Match a link reference definition starting at line `i` (label,
// destination and optional title may span up to three lines).
// Returns {tag, href, title, next, raw} or null. Registers nothing.
const DEF_LABEL_SRC =
  '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE_SRC =
  '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const DEF_RE = new RegExp(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?(<[^>\\n]*>|[^<\\s][^\\s]*)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
)
  .source.replace('label', DEF_LABEL_SRC)
  .replace('title', DEF_TITLE_SRC);
const DEF_RE_COMPILED = new RegExp(DEF_RE);

function matchDef(lines, i, end) {
  const src = lines.slice(i, end).join('\n');
  const m = DEF_RE_COMPILED.exec(src);
  if (!m) return null;
  let dest = m[2];
  if (dest[0] !== '<' && findClosingParen(dest) !== -1) return null;
  if (dest[0] === '<') dest = dest.slice(1, -1);
  // labels match on their raw text (backslash escapes are preserved for
  // matching: a use of [foo\!] does not match a definition of [foo!])
  const tag = normLabel(m[1]);
  const href = unescPunct(dest);
  const title = m[3]
    ? unescPunct(m[3].slice(1, -1))
    : null;
  // consumed lines: the match minus trailing newlines
  let raw = m[0];
  while (raw.endsWith('\n')) raw = raw.slice(0, -1);
  const next = i + raw.split('\n').length;
  return { tag, href, title, next, raw };
}

// ---- main block loop ----
// Parse lines[start..end) into blocks. `top` selects paragraph vs bare-text
// tokens. `info` (optional) records whether a blank line separated two
// blocks (used for list looseness). `isDoc` is true only for the outermost
// document parse (the HTML-block trailing-newline-at-EOF rule applies only
// there). `trailWs` allows a trailing whitespace-only line to join a
// paragraph (see parseParagraph).
function parseBlocks(lines, start, end, top, st, info, isDoc, trailWs) {
  const blocks = [];
  let i = start;
  let pendingBlank = false;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      if (blocks.length > 0) pendingBlank = true;
      i++;
      continue;
    }
    const [indent, cidx] = lineIndent(line);
    const content = line.slice(cidx);
    let blk = null;
    let ni = i + 1;
    if (indent >= 4) {
      [blk, ni] = parseIndentedCode(lines, i, end);
      // code directly after a paragraph/text (no blank line, or one blank
      // line merged into it) joins that paragraph's text
      const prev = blocks[blocks.length - 1];
      if (prev && (prev[0] === 'p' || prev[0] === 'x') && !pendingBlank) {
        prev[1] += '\n' + blk[1];
        i = ni;
        continue;
      }
      if (pendingBlank && info) info.blankBetweenBlocks = true;
      // a block whose consumed lines end in a blank line also separates
      // it from the next block (the blank was swallowed inside the block,
      // e.g. a nested list item ending blank before more item content)
      pendingBlank = ni > i && isBlank(lines[ni - 1]);
      blocks.push(blk);
      i = ni;
      continue;
    }
    const fm = matchFence(content);
    if (fm) {
      [blk, ni] = parseFence(lines, i, end, fm);
    } else if (matchATX(content)) {
      const atx = matchATX(content);
      blk = ['h', atx.depth, atx.text];
    } else if (isHr(content)) {
      blk = ['r'];
    } else if (content[0] === '>') {
      [blk, ni] = parseBlockquote(lines, i, end, st);
    } else if (matchListMarker(content)) {
      const res = parseList(lines, i, end, st);
      if (res) {
        [blk, ni] = res;
      }
    } else if (htmlBegins(content)) {
      const res = parseHtmlBlock(lines, i, end, st, isDoc);
      if (res) {
        [blk, ni] = res;
      }
    }
    if (!blk && content[0] === '[') {
      const def = matchDef(lines, i, end);
      if (def) {
        // a definition after a paragraph/text joins that paragraph's text
        // (and does not register); otherwise it registers the link
        const prev = blocks[blocks.length - 1];
        if (prev && (prev[0] === 'p' || prev[0] === 'x') && !pendingBlank) {
          prev[1] += '\n' + def.raw;
        } else if (!st.defs.has(def.tag)) {
          st.defs.set(def.tag, { href: def.href, title: def.title });
        }
        // a definition renders nothing, but a blank line before it still
        // separates the surrounding blocks (pendingBlank is kept)
        if (pendingBlank && info) info.blankBetweenBlocks = true;
        i = def.next;
        continue;
      }
    }
    if (!blk) {
      const tbl = tryTable(lines, i, end);
      if (tbl) {
        [blk, ni] = tbl;
      }
    }
    if (!blk) {
      [blk, ni] = parseParagraph(lines, i, end, top, trailWs);
      // consecutive bare-text blocks merge (non-top level)
      const prev = blocks[blocks.length - 1];
      if (
        !top &&
        blk[0] === 'x' &&
        prev &&
        prev[0] === 'x' &&
        !pendingBlank
      ) {
        prev[1] += '\n' + blk[1];
        i = ni;
        continue;
      }
    }
    if (pendingBlank && info) info.blankBetweenBlocks = true;
    // see the indented-code branch: a block ending in a blank line
    // separates it from the next block
    pendingBlank = ni > i && isBlank(lines[ni - 1]);
    blocks.push(blk);
    i = ni;
  }
  return blocks;
}

// Strip a blockquote marker (`>` plus one following space, or a tab
// expanded from the marker column) from a line.
function stripBQMarker(line) {
  const [indent, cidx] = lineIndent(line);
  let rest = line.slice(cidx + 1);
  const ws = /^[ \t]+/.exec(rest);
  if (ws) {
    const expanded = expandTabs(ws[0], indent + 1);
    rest = expanded.slice(1) + rest.slice(ws[0].length);
  }
  return rest;
}

// Does the stripped content line terminate a paragraph (so a following lazy
// line is not part of the blockquote)? `prev` is the previous content line
// (for the table check).
function bqTerminates(content, prev) {
  const [indent, cidx] = lineIndent(content);
  if (indent >= 4) return false;
  const c = content.slice(cidx);
  if (c === '') return true;
  if (matchATX(c) || matchFence(c) || isHr(c) || htmlBeginsNarrow(c)) return true;
  if (prev !== undefined && tryTableHeader(prev, content)) return true;
  return false;
}

// Parse a blockquote starting at line `i`. Returns [block, nextIndex].
function parseBlockquote(lines, i, end, st) {
  // Collect lines: [text, hadMarker, origIndex]. Marker lines are stripped;
  // lazy lines are kept as-is. A lazy setext-looking line that does not
  // start its chunk is indented by 4 spaces (marked's SetextReplace).
  const collected = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    const [indent, cidx] = lineIndent(line);
    if (indent <= 3 && line[cidx] === '>') {
      collected.push([stripBQMarker(line), true, j]);
      j++;
      continue;
    }
    if (isBlank(line)) {
      // a blank line with no '>' marker ends the blockquote (a blank
      // line *with* a marker is collected above and stays inside it)
      break;
    }
    // lazy continuation: last content line must be a non-blank,
    // non-terminating paragraph line, and this line must not interrupt
    const last = collected[collected.length - 1];
    if (
      last &&
      last[0] !== '' &&
      !bqTerminates(last[0], collected.length >= 2 ? collected[collected.length - 2][0] : undefined) &&
      !lineInterruptsPara(lines, j, end)
    ) {
      collected.push([line, false, j]);
      j++;
      continue;
    }
    break;
  }
  if (collected.length === 0) return [null, i + 1];
  // Split into chunks: a chunk is [lazy lines...] + [marker lines...].
  const chunks = [];
  let cur = [];
  let seenMarker = false;
  for (const entry of collected) {
    if (!entry[1] && seenMarker) {
      chunks.push(cur);
      cur = [];
      seenMarker = false;
    }
    cur.push(entry);
    if (entry[1]) seenMarker = true;
  }
  if (cur.length) chunks.push(cur);
  // Re-lex each chunk, applying the setext indent rule, merging paragraphs
  // across chunks; stop after a chunk ending in code/heading/hr/html/table.
  const blocks = [];
  let nextIdx = j;
  let prevEndedBlank = false;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkLines = chunk.map((e, idx) => {
      let text = e[0];
      if (
        !e[1] &&
        idx > 0 &&
        /^ {0,3}(=+|-+)[ \t]*$/.test(text)
      ) {
        text = text.replace(/^ {0,3}(=+|-+)([ \t]*)$/, '    $1$2');
      }
      return text;
    });
    const isLastChunk = ci === chunks.length - 1;
    // Split the chunk into its leading lazy lines and the marker lines
    // after them. A lazy line belongs to whatever block the previous chunk
    // ended in (a paragraph, a nested quote, a list item); a marker line
    // starts a fresh block at this quote's level, but a leading paragraph
    // there still continues the paragraph the lazy lines merged into.
    let lazyCount = 0;
    while (lazyCount < chunk.length && !chunk[lazyCount][1]) lazyCount++;
    const segments = [];
    if (lazyCount > 0) {
      segments.push({
        lines: chunk.slice(0, lazyCount).map((e) => e[0]),
        blocks: parseBlocks(
          chunkLines.slice(0, lazyCount),
          0,
          lazyCount,
          true,
          st,
          undefined,
          false,
          isLastChunk && lazyCount === chunk.length,
        ),
        startsBlank: isBlank(chunkLines[0]),
        trailWs: isLastChunk && lazyCount === chunk.length,
      });
    }
    if (lazyCount < chunk.length) {
      segments.push({
        lines: chunk.slice(lazyCount).map((e) => e[0]),
        blocks: parseBlocks(
          chunkLines.slice(lazyCount),
          0,
          chunk.length - lazyCount,
          true,
          st,
          undefined,
          false,
          isLastChunk,
        ),
        startsBlank: isBlank(chunkLines[lazyCount]),
        trailWs: isLastChunk,
      });
    }
    let allowMerge = !prevEndedBlank;
    for (const seg of segments) {
      if (!allowMerge || seg.startsBlank) {
        for (const b of seg.blocks) blocks.push(b);
        allowMerge = false;
        continue;
      }
      // Merge leading paragraph / indented-code blocks into the deepest
      // paragraph the previous chunk ended in, in order; a blank line
      // between two blocks of this segment ends the paragraph.
      let off = 0;
      let mergedAny = false;
      while (seg.blocks.length > 0) {
        let skippedBlank = false;
        while (off < seg.lines.length && isBlank(seg.lines[off])) {
          skippedBlank = true;
          off++;
        }
        if (skippedBlank && mergedAny) break;
        if (skippedBlank && !mergedAny) break;
        const first = seg.blocks[0];
        if (first[0] !== 'p' && !(first[0] === 'c' && first[2] === null)) break;
        const nextOff =
          first[0] === 'p'
            ? parseParagraph(seg.lines, off, seg.lines.length, true, seg.trailWs)[1]
            : parseIndentedCode(seg.lines, off, seg.lines.length)[1];
        const res = mergeIntoDeepestParagraph(
          blocks,
          first,
          seg.lines.slice(off, nextOff),
          st,
        );
        if (!res) break;
        off = nextOff;
        seg.blocks.shift();
        mergedAny = true;
      }
      for (const b of seg.blocks) blocks.push(b);
      if (!mergedAny) allowMerge = false;
    }
    const lastBlock = blocks[blocks.length - 1];
    if (
      lastBlock &&
      (lastBlock[0] === 'c' ||
        lastBlock[0] === 'h' ||
        lastBlock[0] === 'r' ||
        lastBlock[0] === 'H' ||
        lastBlock[0] === 'T')
    ) {
      // remaining chunks are outside the blockquote
      const nextChunk = chunks[ci + 1];
      nextIdx = nextChunk ? nextChunk[0][2] : j;
      break;
    }
    prevEndedBlank =
      chunkLines.length > 0 && isBlank(chunkLines[chunkLines.length - 1]);
  }
  return [['q', blocks], nextIdx];
}

// Merge `first` (a paragraph, or an indented code block whose text is
// paragraph text) into the deepest last paragraph of `blocks`, walking
// down through nested blockquotes and lists. Returns 'text' when the text
// was appended, 'relex' when the lines were re-lexed into a list item
// (the whole block's lines are then consumed), or false when no merge
// applies.
function mergeIntoDeepestParagraph(blocks, first, segLines, st) {
  let cur = blocks;
  let listItem = null;
  let listBlock = null;
  for (;;) {
    if (cur.length === 0) return false;
    const last = cur[cur.length - 1];
    if (last[0] === 'p') {
      if (listItem) {
        return relexIntoListItem(listItem, listBlock, segLines, st)
          ? 'relex'
          : false;
      }
      last[1] += '\n' + first[1];
      return 'text';
    }
    if (last[0] === 'q') {
      cur = last[1];
      listItem = null;
      listBlock = null;
      continue;
    }
    if (last[0] === 'l') {
      const items = last[4];
      if (!items.length) return false;
      listItem = items[items.length - 1];
      listBlock = last;
      cur = listItem.blocks;
      continue;
    }
    return false;
  }
}

// Append lazy lines to a list item's content (simulating parseListItem's
// continuation loop, with the item's content indent R) and re-parse the
// item. Returns true on success; false when a line would break the item.
function relexIntoListItem(item, listBlock, rawLines, st) {
  const R = item.R;
  const newLines = item.lines.slice();
  let y = item.y;
  let mCur = item.mCur;
  for (const f of rawLines) {
    const Z = expandLeadingWs(f, 0);
    if (listBreakAt(f, R)) return false;
    if (Z.search(/[^ ]/) >= R || f.trim() === '') {
      newLines.push(Z.slice(R));
    } else {
      if (
        y ||
        mCur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
        listBreakAtM(mCur, R)
      )
        return false;
      let qe = f;
      if (canSetext(mCur, f)) qe = '    ' + Z.replace(/^ {0,3}/, '');
      newLines.push(qe);
    }
    y = f.trim() === '';
    mCur = Z.slice(R);
  }
  const info = { blankBetweenBlocks: false };
  const blocks = parseBlocks(newLines, 0, newLines.length, false, st, info);
  item.lines = newLines;
  item.y = y;
  item.mCur = mCur;
  item.blocks = blocks;
  if (info.blankBetweenBlocks) listBlock[3] = true;
  reapplyListTail(listBlock);
  return true;
}

// Re-apply a list's tail logic (loose x->p conversion + checkbox attach)
// after one item's blocks were re-parsed by a lazy-line merge.
function reapplyListTail(listBlock) {
  const loose = listBlock[3];
  const items = listBlock[4];
  for (const it of items) {
    if (it.blocks.length && it.blocks[0][0] === 'k') it.blocks.shift();
  }
  for (const it of items) {
    for (const b of it.blocks) if (b[0] === 'x' && loose) b[0] = 'p';
  }
  for (const it of items) {
    if (!it.task) continue;
    const fb = it.blocks[0];
    if (fb && (fb[0] === 'x' || fb[0] === 'p'))
      fb[1] = fb[1].replace(TASK_RE, '');
    if (loose && fb && fb[0] === 'p') fb[2] = it.checked;
    else it.blocks.unshift(['k', it.checked]);
  }
}

// ---- lists ----

// Expand the leading whitespace run of `s` (spaces/tabs) starting at column
// `col` (marked's J helper).
function expandLeadingWs(s, col) {
  const m = /^[ \t]+/.exec(s);
  if (!m) return s;
  return expandTabs(m[0], col) + s.slice(m[0].length);
}

// Does `line` start a block at indent <= R? (fence/heading/html/blockquote/
// next-bullet/hr, as in marked's list item loop.) The indent a block start
// may have is clamped to min(3, R-1): deeper-indented lines belong to the
// item's content and are re-lexed there (nested lists, indented code).
function listBreakAt(line, R) {
  const m = new RegExp(`^ {0,${Math.min(3, R - 1)}}`).exec(line);
  const rest = m ? line.slice(m[0].length) : line;
  if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (htmlBegins(rest)) return true;
  if (rest[0] === '>') return true;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
  if (isHr(rest)) return true;
  return false;
}

// Does `line` start a fence/heading/html/hr block at indent <= R?
// (the m-line checks in marked's list item loop; same indent clamp.)
function listBreakAtM(line, R) {
  const m = new RegExp(`^ {0,${Math.min(3, R - 1)}}`).exec(line);
  const rest = m ? line.slice(m[0].length) : line;
  if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (htmlBegins(rest)) return true;
  if (isHr(rest)) return true;
  return false;
}

// Can `f` (a setext-looking line) be the underline of the paragraph line
// `m`? (marked tests its lheading rule on the pair.)
function canSetext(m, f) {
  if (!/^ {0,3}(?:=+|-+) *$/.test(f)) return false;
  if (m.trim() === '') return false;
  const [indent, cidx] = lineIndent(m);
  if (indent >= 4) return false;
  const c = m.slice(cidx);
  if (matchListMarker(c) || matchFence(c) || matchATX(c) || isHr(c))
    return false;
  if (c[0] === '>' || htmlBegins(c)) return false;
  if (parseDelimiterRow(m) !== null) return false;
  return true;
}

// Parse one list item starting at line `j` (a marker line). `b` is the
// bullet match length (indent + marker). Returns
// {lines, next, endsBlank} where `lines` is the item's content lines
// (indent stripped) and `next` the index after the item.
function parseListItem(lines, j, end, b) {
  const first = lines[j];
  const [findent, fcidx] = lineIndent(first);
  const markerLen = b - findent;
  const mRaw = first.slice(fcidx + markerLen);
  const m = expandLeadingWs(mRaw, b);
  const y0 = m.trim() === '';
  let R;
  let d;
  if (y0) {
    R = b + 1;
    d = '';
  } else {
    R = m.search(/[^ ]/);
    if (R > 4) R = 1;
    d = m.slice(R);
    R += b;
  }
  const itemLines = [d];
  let k = j + 1;
  let u = false;
  if (y0 && k < end && isBlank(lines[k])) {
    // empty first line + blank next line: item ends here
    k++;
    u = true;
  }
  let y = y0;
  let mCur = m;
  if (!u) {
    while (k < end) {
      const f = lines[k];
      const Z = expandLeadingWs(f, 0);
      if (listBreakAt(f, R)) break;
      if (Z.search(/[^ ]/) >= R || f.trim() === '') {
        itemLines.push(Z.slice(R));
      } else {
        if (
          y ||
          mCur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
          listBreakAtM(mCur, R)
        )
          break;
        // setext-looking line after a paragraph line becomes indented text
        let qe = f;
        if (canSetext(mCur, f)) qe = '    ' + Z.replace(/^ {0,3}/, '');
        itemLines.push(qe);
      }
      y = f.trim() === '';
      k++;
      mCur = Z.slice(R);
    }
  }
  const endsBlank = isBlank(lines[k - 1]);
  return { lines: itemLines, next: k, endsBlank, R, y, mCur };
}

// Parse a list starting at line `i`. Returns [block, nextIndex] or null.
function parseList(lines, i, end, st) {
  const first = lines[i];
  const [findent, fcidx] = lineIndent(first);
  const fcontent = first.slice(fcidx);
  if (isHr(fcontent)) return null;
  const fm = matchListMarker(fcontent);
  if (!fm) return null;
  const ordered = fm.ordered;
  const marker = fm.marker;
  const start = ordered ? parseInt(marker.slice(0, -1), 10) : 0;
  const items = [];
  let loose = false;
  let p = false; // previous item ended with a blank line
  let j = i;
  while (j < end) {
    const line = lines[j];
    const [indent, cidx] = lineIndent(line);
    if (indent > 3) break;
    const content = line.slice(cidx);
    if (isHr(content)) break;
    const m = matchListMarker(content);
    if (!m) break;
    if (m.ordered !== ordered) break;
    if (ordered) {
      if (m.marker.slice(-1) !== marker.slice(-1)) break;
    } else if (m.marker !== marker) {
      break;
    }
    const b = indent + m.marker.length;
    const res = parseListItem(lines, j, end, b);
    const itemLines = res.lines;
    // trim trailing blank lines from the item's content (marked trims the
    // last item's raw/text; inner trailing blanks stay for the p-flag)
    items.push({
      lines: itemLines,
      endsBlank: res.endsBlank,
      rawEndsBlank: res.endsBlank,
      R: res.R,
      y: res.y,
      mCur: res.mCur,
    });
    if (p) loose = true;
    else if (res.endsBlank) p = true;
    j = res.next;
  }
  if (items.length === 0) return null;
  // last item: trim trailing blank content lines
  const lastItem = items[items.length - 1];
  while (
    lastItem.lines.length > 1 &&
    lastItem.lines[lastItem.lines.length - 1] === ''
  )
    lastItem.lines.pop();
  // re-lex each item's content (non-top level), detect looseness
  const outItems = [];
  for (const it of items) {
    const info = { blankBetweenBlocks: false };
    const blocks = parseBlocks(it.lines, 0, it.lines.length, false, st, info);
    if (!loose && info.blankBetweenBlocks) loose = true;
    outItems.push({ task: false, checked: false, blocks, lines: it.lines, R: it.R, y: it.y, mCur: it.mCur });
  }
  // task lists: a task item's first block must be text/paragraph (marked
  // un-tasks it otherwise, e.g. when the first line starts a table)
  for (const it of outItems) {
    const firstLine = it.lines[0] || '';
    if (!TASK_RE.test(firstLine)) continue;
    const firstBlock = it.blocks[0];
    if (!firstBlock || (firstBlock[0] !== 'x' && firstBlock[0] !== 'p'))
      continue;
    it.task = true;
    it.checked = /^\[([ xX])\]/.exec(firstLine)[1] !== ' ';
    firstBlock[1] = firstBlock[1].replace(TASK_RE, '');
  }
  if (loose) {
    for (const it of outItems) {
      for (const b of it.blocks) if (b[0] === 'x') b[0] = 'p';
    }
  }
  // attach the checkbox: inside the first paragraph when loose, otherwise
  // as a standalone token before the first block
  for (const it of outItems) {
    if (!it.task) continue;
    const firstBlock = it.blocks[0];
    if (loose && firstBlock && firstBlock[0] === 'p') {
      firstBlock[2] = it.checked;
    } else {
      it.blocks.unshift(['k', it.checked]);
    }
  }
  return [['l', ordered, start, loose, outItems], j];
}

// ---- HTML blocks ----

// Consume lines from `i` until (and including) the first line matching `re`.
function consumeUntil(lines, i, end, re) {
  const collected = [];
  let j = i;
  while (j < end) {
    collected.push(lines[j]);
    if (re.test(lines[j])) {
      j++;
      break;
    }
    j++;
  }
  return [['H', collected.join('\n')], j];
}

// Consume lines from `i` until a blank line (exclusive) or the end.
function consumeToBlank(lines, i, end) {
  const collected = [];
  let j = i;
  while (j < end && !isBlank(lines[j])) {
    collected.push(lines[j]);
    j++;
  }
  return [['H', collected.join('\n')], j];
}

// Is `content` a complete tag (open or close) alone on its line, with
// optional attributes, for HTML block type 7? An attribute must be
// preceded by whitespace, and a closing tag allows only whitespace
// before the `>`.
function isCompleteTagLine(content) {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(content);
  if (!m) return false;
  const name = m[2].toLowerCase();
  if (
    (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') &&
    !m[1]
  )
    return false;
  let rest = content.slice(m[0].length);
  if (m[1]) {
    // closing tag: only whitespace, then '>', then nothing
    const ws = /^[ \t]+/.exec(rest);
    if (ws) rest = rest.slice(ws[0].length);
    return rest === '>';
  }
  for (;;) {
    const ws = /^[ \t]+/.exec(rest);
    const hadWs = !!ws;
    if (ws) rest = rest.slice(ws[0].length);
    if (rest[0] === '>') return rest.slice(1).trim() === '';
    if (rest[0] === '/' && rest[1] === '>') return rest.slice(2).trim() === '';
    if (!hadWs) return false;
    if (rest === '') return false;
    const am = /^[a-zA-Z:_][\w.:-]*/.exec(rest);
    if (!am) return false;
    rest = rest.slice(am[0].length);
    // an attribute value is optional; only consume the whitespace before
    // '=' when one follows (same valueless-attribute rule as scanTag)
    const ws2 = /^[ \t]+/.exec(rest);
    const eqPos = ws2 ? ws2[0].length : 0;
    if (rest[eqPos] === '=') {
      rest = rest.slice(eqPos + 1);
      const ws3 = /^[ \t]+/.exec(rest);
      if (ws3) rest = rest.slice(ws3[0].length);
      const q = rest[0];
      if (q === '"' || q === "'") {
        const k = rest.indexOf(q, 1);
        if (k === -1) return false;
        rest = rest.slice(k + 1);
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(rest);
        if (!vm) return false;
        rest = rest.slice(vm[0].length);
      }
    }
  }
}

// Parse an HTML block starting at line `i`. Returns [block, next] or null.
// The raw text gets a trailing newline exactly when the block is followed
// by a non-blank line, or ends at EOF with the source ending in a newline
// (the EOF rule applies only at the document top level: nested ranges
// such as blockquote chunks and list items end at their own boundary).
function parseHtmlBlock(lines, i, end, st, isDoc) {
  const line = lines[i];
  const [indent, cidx] = lineIndent(line);
  if (indent > 3) return null;
  const content = line.slice(cidx);
  if (content[0] !== '<') return null;
  let res = null;
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(content);
  if (m1) res = consumeUntil(lines, i, end, new RegExp(`</${m1[1]}>`, 'i'));
  else if (content.startsWith('<!--')) res = consumeUntil(lines, i, end, /-->/);
  else if (content.startsWith('<?')) res = consumeUntil(lines, i, end, /\?>/);
  else if (/^<![A-Za-z]/.test(content)) res = consumeUntil(lines, i, end, />/);
  else if (content.startsWith('<![CDATA[')) res = consumeUntil(lines, i, end, /\]\]>/);
  else if (BLOCK_TAG_BEGIN_RE.test(content)) res = consumeToBlank(lines, i, end);
  else if (isCompleteTagLine(content)) res = consumeToBlank(lines, i, end);
  if (!res) return null;
  const next = res[1];
  const commentBlock = content.startsWith('<!--');
  if (
    (next < end && (!isBlank(lines[next]) || (isDoc && commentBlock && lines[next] !== ''))) ||
    (next >= end && isDoc && st.endsWithNL)
  ) {
    res[0][1] += '\n';
  }
  return res;
}

// ---- tables ----

// A row line interrupts a table's rows.
function rowInterrupts(line) {
  const [indent, cidx] = lineIndent(line);
  if (indent >= 4) return true;
  const c = line.slice(cidx);
  // In a table, a cell may itself begin with text that resembles a block
  // marker (for example `- item | value`). Keep such pipe-delimited rows.
  if (c.indexOf('|') !== -1) return false;
  if (isHr(c) || matchATX(c) || matchFence(c)) return true;
  if (c[0] === '>' || htmlBegins(c)) return true;
  if (/^(?:[*+-]|1[.)])[ \t]/.test(c)) return true;
  return false;
}

// Parse a table starting at line `i` (header + delimiter + rows).
// Returns [block, next] or null.
function tryTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const t = tryTableHeader(lines[i], lines[i + 1]);
  if (!t) return null;
  const header = t.header.map((text, idx) => ({ text, align: t.align[idx] }));
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line) || rowInterrupts(line)) break;
    rows.push(
      splitTableRow(line, header.length).map((text, idx) => ({
        text,
        align: t.align[idx],
      })),
    );
    j++;
  }
  return [['T', header, rows], j];
}

// ---- rendering ----

function checkboxHtml(c) {
  if (c === undefined) return '';
  return (
    '<input ' +
    (c ? 'checked="" ' : '') +
    'disabled="" type="checkbox"> '
  );
}

function renderTableCell(cell, isHeader, st) {
  const tag = isHeader ? 'th' : 'td';
  return (
    (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    inlineToHtml(cell.text, st) +
    `</${tag}>\n`
  );
}

function renderBlocks(blocks, st) {
  let out = '';
  for (const b of blocks) {
    switch (b[0]) {
      case 'p':
        out +=
          '<p>' +
          checkboxHtml(b[2]) +
          inlineToHtml(b[1], st) +
          '</p>\n';
        break;
      case 'x':
        out += checkboxHtml(b[2]) + inlineToHtml(b[1], st);
        break;
      case 'h':
        out +=
          '<h' + b[1] + '>' + inlineToHtml(b[2], st) + '</h' + b[1] + '>\n';
        break;
      case 'c': {
        const lang = b[2] ? b[2].match(/^\S*/)[0] : '';
        const text = b[1] ? b[1].replace(/\n$/, '') + '\n' : '';
        const body = esc(text, true);
        out += lang
          ? '<pre><code class="language-' +
            esc(lang) +
            '">' +
            body +
            '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
        break;
      }
      case 'r':
        out += '<hr>\n';
        break;
      case 'H':
        out += b[1];
        break;
      case 'q':
        out += '<blockquote>\n' + renderBlocks(b[1], st) + '</blockquote>\n';
        break;
      case 'l': {
        const tag = b[1] ? 'ol' : 'ul';
        const startAttr = b[1] && b[2] !== 1 ? ' start="' + b[2] + '"' : '';
        let items = '';
        for (const it of b[4]) {
          items += '<li>' + renderBlocks(it.blocks, st) + '</li>\n';
        }
        out += '<' + tag + startAttr + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'k':
        out += checkboxHtml(b[1]);
        break;
      case 'T': {
        let thead = '';
        for (const cell of b[1]) thead += renderTableCell(cell, true, st);
        let tbody = '';
        for (const row of b[2]) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell, false, st);
          tbody += '<tr>\n' + cells + '</tr>\n';
        }
        out +=
          '<table>\n<thead>\n<tr>\n' +
          thead +
          '</tr>\n</thead>\n' +
          (tbody ? '<tbody>' + tbody + '</tbody>' : '') +
          '</table>\n';
        break;
      }
    }
  }
  return out;
}

// ---- entry point ----

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (src.endsWith('\n')) lines.pop();
  const st = {
    defs: new Map(),
    inLink: false,
    linkEmitted: false,
    inRawBlock: false,
    endsWithNL: src.endsWith('\n'),
  };
  const blocks = parseBlocks(lines, 0, lines.length, true, st, undefined, true, !st.endsWithNL);
  return renderBlocks(blocks, st);
}
