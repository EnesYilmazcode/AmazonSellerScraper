/**
 * Minimal, scoped Jest transformer that rewrites the ESM `import`/`export`
 * syntax in scripts/background/sync.js to CommonJS so it can be unit-tested
 * under Jest's default (non-ESM) runtime.
 *
 * This is deliberately tiny and applied ONLY to sync.js (see jest.config.js
 * `transform`). It does not touch any other source file — every other module
 * already uses CommonJS `require` + a conditional `module.exports`, and keeps
 * running through the default `babel-jest` transform. We avoid adding a Babel
 * preset/plugin dependency (none are installed) and avoid a global babel.config
 * that could alter how the existing 244 tests are compiled.
 *
 * Supported forms (all that sync.js uses):
 *   import { a, b } from 'mod';          -> const { a, b } = require('mod');
 *   import x from 'mod';                 -> const x = require('mod');
 *   export async function f() {}         -> async function f() {}; module.exports.f = f;
 *   export function f() {}               -> function f() {}; module.exports.f = f;
 *   export const X = ...;                -> const X = ...; module.exports.X = X;
 */
function rewrite(src) {
  const named = [];

  let out = src
    // import { a, b } from 'mod';  (allow multi-line)
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m, names, mod) => {
        const clean = names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(', ');
        return `const { ${clean} } = require('${mod}');`;
      }
    )
    // import x from 'mod';
    .replace(
      /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
      (_m, name, mod) => `const ${name} = require('${mod}');`
    )
    // export const NAME = ... -> strip `export`, remember the name
    .replace(/^export\s+const\s+([A-Za-z_$][\w$]*)/gm, (_m, name) => {
      named.push(name);
      return `const ${name}`;
    })
    // export (async) function name(...) -> strip `export`, remember the name
    .replace(
      /export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      (_m, asyncKw, name) => {
        named.push(name);
        return `${asyncKw || ''}function ${name}`;
      }
    );

  if (named.length) {
    out += `\n${named.map((n) => `module.exports.${n} = ${n};`).join('\n')}\n`;
  }
  return out;
}

module.exports = {
  process(sourceText) {
    return { code: rewrite(sourceText) };
  },
};
