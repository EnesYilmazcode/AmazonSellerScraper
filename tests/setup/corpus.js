/**
 * Reads the golden page corpus in tests/pages/<yyyy-mm>/.
 */
const fs = require('fs');
const path = require('path');

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

module.exports = { corpus, PAGES };
