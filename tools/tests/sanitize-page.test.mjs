import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, leftoverTokens } from '../lib/sanitize-page.mjs';

test('removes scripts, frames and inline handlers', () => {
  const out = sanitizeHtml(
    '<head><script>var a=1;</script><script src="x.js"></script></head>' +
    '<body onload="go()"><iframe src="https://x"></iframe><a href="javascript:void(0)">x</a></body>'
  );
  assert.doesNotMatch(out, /<script|<iframe|onload|javascript:/i);
});

test('scrubs session and tracking tokens but keeps the page shape', () => {
  const out = sanitizeHtml(
    '<meta http-equiv="refresh" content="5; URL=\'/s?k=a&bm-verify=AAQ123\'">' +
    '<meta name="anti-csrftoken-a2z" content="hSecret">' +
    '<input type="hidden" name="anti-csrftoken-a2z" value="hSecret">' +
    '<a href="/dp/B000000001?dib=eyJ2&amp;qid=1790222636&amp;sr=8-1">p</a>' +
    '<span data-session-id="145-0919687-6183966"></span>'
  );
  assert.doesNotMatch(out, /hSecret|AAQ123|eyJ2|1790222636|145-0919687/);
  assert.match(out, /http-equiv="refresh"/);
  assert.match(out, /bm-verify=x/);
  assert.match(out, /\/dp\/B000000001/);
  assert.deepEqual(leftoverTokens(out), []);
});

test('flags a page that still has a script', () => {
  assert.deepEqual(leftoverTokens('<script>1</script>'), ['script tag']);
});
