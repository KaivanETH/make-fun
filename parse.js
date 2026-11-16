// parse(markdown) — exactly the HTML marked 18.1.3 renders with its default
// options (GFM on, breaks off, pedantic off, async off).
//
// How it gets there:
//   * Block structure comes from vendored marked's own lexer, and every
//     inline rule body is run by vendored marked's own Tokenizer, so what each
//     rule matches is marked's code, byte for byte
//     (vendor/marked/marked.esm.js, MIT, see vendor/marked/LICENSE and
//     vendor/marked/NOTICE).
//   * On top sits a controller of our own that only ever skips a rule when
//     that rule provably cannot match at the current position — every marked
//     rule is anchored and needs a specific first character, so at each
//     position we run the one or two rules that could match instead of the
//     eleven marked tries in order. Nothing is cached between calls: parse
//     returns for each input what it returns for that input alone.
//   * Anything the controller is not sure about throws Unsupported and
//     parse() then hands the whole document to marked itself.
//
// parse is deterministic: no clock, no environment, no files, no network.

import { marked, Lexer, Tokenizer, Parser, defaults } from './vendor/marked/marked.esm.js';

/** Raised when this controller cannot prove it renders as marked does. */
class Unsupported extends Error {}

// Rule masks for the first character of the remaining source. Every inline
// rule marked's GFM grammar runs is anchored, so a match is impossible unless
// the first character is one this rule can start with. TEXT (gfm) can start
// with anything and is last, so it is in every mask.
const M_ESC = 1;      // ^\\([punct])
const M_TAG = 2;      // ^<!-- | ^</?tag | ^<\? | ^<! | ^<![CDATA[
const M_LINK = 4;     // ^!?\[
const M_REF = 8;      // ^!?\[..\]\[..\] / nolink
const M_EM = 16;      // ^\*+ / ^_+
const M_CODE = 32;    // ^`+
const M_BR = 64;      // ^( {2,}|\\)\n
const M_DEL = 128;    // ^~~?
const M_AUTO = 256;   // ^<(scheme|email)>
const M_URL = 512;    // ^(mailto|xmpp): | ^(https?|ftp):// | ^www\. | ^[A-Za-z0-9._+-]+@...
const M_TEXT = 1024;  // gfm inline text, matches from any character

const DISPATCH = new Uint16Array(128);
for (let c = 0; c < 128; c++) {
  let m = M_TEXT;
  if (c === 0x5c) m |= M_ESC | M_BR;                  // '\'
  if (c === 0x3c) m |= M_TAG | M_AUTO;                 // '<'
  if (c === 0x21 || c === 0x5b) m |= M_LINK | M_REF;   // '!' '['
  if (c === 0x2a || c === 0x5f) m |= M_EM;             // '*' '_'
  if (c === 0x60) m |= M_CODE;                         // '`'
  if (c === 0x20) m |= M_BR;                           // ' '
  if (c === 0x7e) m |= M_DEL;                          // '~'
  // the gfm url rule starts with a letter, digit, '.', '_', '+' or '-'
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      || c === 0x2e || c === 0x5f || c === 0x2b || c === 0x2d) m |= M_URL;
  DISPATCH[c] = m;
}
/** First-char gate: non-ASCII can only start the gfm text rule. */
function dispatch(charCode) {
  return charCode < 128 ? DISPATCH[charCode] : M_TEXT;
}

/** marked's label key: trim, collapse inner whitespace runs, case-fold. */
function normalizeLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

/** Does this inline run's text already hold a link? (marked's own test.) */
function linkInText(lexer, text) {
  if (!text.includes('[')) return false;
  const rules = lexer.tokenizer.rules.inline;
  const linkRule = rules.link;
  for (const match of text.matchAll(rules.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(rules.reflinkSearch)) {
    const found = match[0];
    const refStart = found.lastIndexOf('[');
    if (found.charAt(0) === '!'
        || !Object.hasOwn(lexer.tokens.links, normalizeLabel(found.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(lexer, found.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Mask links, code, html and escapes so em/strong/del do not see their
 * delimiters inside them — marked's own masking, same replacements in the
 * same order, so the masked source (and every index into it) is identical.
 */
function maskSrc(lexer, src) {
  const rules = lexer.tokenizer.rules.inline;
  let masked = src;
  const links = lexer.tokens.links;

  if (links && src.includes('[')) {
    const reflinkSearch = rules.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(lexer, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearch, maskReflink);
  }

  masked = masked.replace(rules.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });

  masked = masked.replace(rules.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });

  return masked;
}

/**
 * The inline loop: marked's own order and its own rule bodies, with each
 * rule's trial gated on the first character of `src`. Every consume step is
 * marked's.
 */
function tokenizeInlines(lexer, src, maskedSrc, tokens) {
  if (lexer.options.pedantic || lexer.options.breaks || lexer.options.extensions) {
    throw new Unsupported();
  }
  const tk = lexer.tokenizer;
  const state = lexer.state;
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;

  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Unsupported();
    }
    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    let token;
    const mask = dispatch(src.charCodeAt(0));

    // escape
    if (mask & M_ESC) {
      if ((token = tk.escape(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // tag
    if (mask & M_TAG) {
      if ((token = tk.tag(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // link
    if (mask & M_LINK) {
      if ((token = tk.link(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // reflink, nolink
    if (mask & M_REF) {
      if ((token = tk.reflink(src, lexer.tokens.links))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
        if (token.type === 'text' && lastToken && lastToken.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    }
    // em & strong
    if (mask & M_EM) {
      if ((token = tk.emStrong(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // code
    if (mask & M_CODE) {
      if ((token = tk.codespan(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // br
    if (mask & M_BR) {
      if ((token = tk.br(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // del (gfm)
    if (mask & M_DEL) {
      if ((token = tk.del(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // autolink
    if (mask & M_AUTO) {
      if ((token = tk.autolink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // url (gfm)
    if ((mask & M_URL) && !state.inLink) {
      if ((token = tk.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // text
    if ((token = tk.inlineText(src))) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // track prevChar before a run of _
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
      const lastToken = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
      if (lastToken && lastToken.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    throw new Unsupported();
  }
  return tokens;
}

/** One inline run: marked's wrapper state, then our gated loop. */
function inlineRunInto(lexer, src, tokens) {
  const state = lexer.state;
  const prevLinkParenPossible = state.linkParenPossible;
  // run-start state; an aborted run must hand marked's loop the state it
  // itself would have started from
  const heldRawBlock = state.inRawBlock;
  const heldInLink = state.inLink;
  const heldLinkEmitted = state.linkEmitted;
  state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    const hasDelims = src.includes('*') || src.includes('_') || src.includes('~');
    const maskedSrc = hasDelims ? maskSrc(lexer, src) : src;
    tokenizeInlines(lexer, src, maskedSrc, tokens);
  } catch (err) {
    if (!(err instanceof Unsupported)) throw err;
    // This run is not certain: drop whatever we produced, rewind every piece
    // of run state we touched, and let marked's own inline loop have it (it
    // starts from the whole run; nothing is shared with earlier calls).
    tokens.length = 0;
    state.inRawBlock = heldRawBlock;
    state.inLink = heldInLink;
    state.linkEmitted = heldLinkEmitted;
    state.linkParenPossible = prevLinkParenPossible;
    Lexer.prototype.inlineTokens.call(lexer, src, tokens);
    return;
  }
  state.linkParenPossible = prevLinkParenPossible;
}

/** Build fresh per-call options so nothing is shared between parses. */
function freshOptions() {
  const opts = {};
  for (const key of Object.keys(defaults)) opts[key] = defaults[key];
  return opts;
}

/** Render `src` with our controller; throw Unsupported to hand it to marked. */
function fastRender(md) {
  const src = md.includes('\r') ? md.replace(/\r\n|\r/g, '\n') : md;

  const lexOpts = freshOptions();
  lexOpts.tokenizer = new Tokenizer();
  const lexer = new Lexer(lexOpts);
  if (lexer.options.pedantic || lexer.options.breaks || lexer.options.extensions) {
    throw new Unsupported();
  }

  lexer.blockTokens(src, lexer.tokens);

  // Recursion (link labels, em/strong/del contents) goes through our gate too.
  lexer.inlineTokens = function (s, toks) {
    const out = toks || [];
    inlineRunInto(lexer, s, out);
    return out;
  };

  for (let i = 0; i < lexer.inlineQueue.length; i++) {
    const next = lexer.inlineQueue[i];
    // an inline <pre>, <code>, <kbd> or <script> left open ends with the block
    // holding it
    lexer.state.inRawBlock = false;
    inlineRunInto(lexer, next.src, next.tokens);
  }
  lexer.inlineQueue = [];

  const parseOpts = freshOptions();
  return new Parser(parseOpts).parse(lexer.tokens);
}

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  try {
    return fastRender(markdown);
  } catch (err) {
    if (!(err instanceof Unsupported)) throw err;
    return marked.parse(markdown);
  }
}