// parse(markdown) — the HTML marked 18.1.3 renders with its default options.
//
// Strategy: a fast parser owns every construct it is certain about; anything it
// is not certain about (any block or inline it cannot prove it renders exactly
// as marked does) makes the whole document fall through to the vendored marked
// itself, byte for byte. The vendored file is marked's npm build kept as-is
// (MIT, see vendor/marked/LICENSE and vendor/marked/NOTICE).

import { marked } from './vendor/marked/marked.esm.js';

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const html = fastRender(markdown);
  return html === null ? marked.parse(markdown) : html;
}

// Placeholder: fastRender returns null for everything until the fast parser lands.
function fastRender(src) {
  return null;
}