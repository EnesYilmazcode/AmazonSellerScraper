/**
 * Reads the golden page corpus in tests/pages/<yyyy-mm>/.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { quietConsole } = require('./dom-helpers');

const PAGES = path.resolve(__dirname, '../pages');

/** Every page with an expected.json, sorted, as {id, html, expected}. */
function corpus() {
  const out = [];
  for (const month of fs.readdirSync(PAGES).sort()) {
    const dir = path.join(PAGES, month);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.expected.json')) continue;
      const name = f.replace(/\.expected\.json$/, '');
      out.push({
        id: `${month}/${name}`,
        expected: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
        html: fs.readFileSync(path.join(dir, `${name}.html`), 'utf8'),
      });
    }
  }
  return out;
}

/**
 * A Document for `html` at `url`. jsdom has no innerText, so it falls back to
 * textContent as in the content-script loader. Chromium's innerText can
 * differ, which the e2e harness covers.
 */
function parseDoc(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: quietConsole() });
  const proto = dom.window.HTMLElement.prototype;
  if (!Object.prototype.hasOwnProperty.call(proto, 'innerText')) {
    Object.defineProperty(proto, 'innerText', {
      get() { return this.textContent; },
      configurable: true
    });
  }
  return dom.window.document;
}

module.exports = { corpus, parseDoc, PAGES };
