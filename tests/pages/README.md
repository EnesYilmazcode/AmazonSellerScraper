# Page corpus

Saved Amazon pages the parsers and the Chromium harness run against. No test
here touches the network.

Each page is `<yyyy-mm>/<name>.html` plus `<name>.expected.json`. The folder is
the month the page was captured, so a layout change shows up as a new folder
rather than an edited fixture.

`expected.json` holds what a correct parser should report, written from the
page itself and not from the current code:

- `type`: `search` or `offers`
- `url`: the address the page was served at
- `kind`: `results`, `last`, `empty`, `interstitial`, `captcha`, `signin` or `unknown`
- `asins`: the search-result ASINs in page order, each once
- `placements`: search-result cards, repeats included
- `sponsored`: sponsored cards
- `next`: the next-page link, or null on the last page. `nextExact` says whether
  the href must match exactly or only the page number
- `total`: the result count in the header, 0 when there is none
- `minFill`: the share of products that must have an ASIN, title and price
- `spot`: a few products checked field by field
- `offers.prices`: seller prices in dollars, for offer pages
- `synthetic`: true for hand-written pages

Where today's code disagrees, the golden test marks that check as failing with
the finding id from the audit, so the fix flips it.

Captured pages are sanitized with `tools/lib/sanitize-page.mjs`. To capture new
ones, run `node tools/refresh-fixtures.mjs` by hand. It never runs in CI.
