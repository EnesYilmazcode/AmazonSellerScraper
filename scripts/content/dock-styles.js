/**
 * @fileoverview Styles for the on-page dock (scripts/content/dock.js).
 *
 * Kept as a string so the dock can adopt it as a constructed stylesheet
 * inside its closed shadow root: no web-accessible file, no request, and
 * the page's CSP does not apply. System fonts only.
 *
 * @module DockStyles
 */

const DOCK_CSS = `
:host { all: initial; }
.dock {
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  --surface: #ffffff;
  --sunken: #f2f4f6;
  --ink: #1c232b;
  --muted: #5a6570;
  --line: #e1e5e9;
  --line-strong: #c9d0d7;
  --primary: #2a343e;
  --primary-hover: #1c242c;
  --on-primary: #ffffff;
  --soft: #e8ecef;
  --soft-ink: #2a343e;
  --ok: #1f7a4d;
  --ok-soft: #e3f3ea;
  --warn: #8a4b08;
  --warn-soft: #fbf0e1;
  --ring: #2a343e;
  --shadow: 0 0 0 1px rgba(20,22,30,.05), 0 2px 4px rgba(20,22,30,.06), 0 18px 40px -10px rgba(20,22,30,.28);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end;
  font: 400 14px/1.45 var(--font); color: var(--ink);
  -webkit-font-smoothing: antialiased; text-align: left;
  font-variant-numeric: tabular-nums;
}
@media (prefers-color-scheme: dark) {
  .dock {
    --surface: #2a343e; --sunken: #333e49; --ink: #ffffff; --muted: #b3bcc6; --line: #3b4753; --line-strong: #4c5967;
    --primary: #ffffff; --primary-hover: #e4e8ec; --on-primary: #2a343e; --soft: #36424e; --soft-ink: #ffffff;
    --ok: #5cc493; --ok-soft: #1c3329; --warn: #f0b36b; --warn-soft: #3a2c1a;
    --ring: #ffffff;
    --shadow: 0 0 0 1px rgba(255,255,255,.07), 0 18px 40px -10px rgba(0,0,0,.65);
  }
}
@media print { .dock { display: none; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, a { font: inherit; color: inherit; }
button { background: none; border: 0; margin: 0; padding: 0; cursor: pointer; text-align: inherit; }
button:disabled { cursor: default; opacity: .55; }
a { text-decoration: none; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
svg { display: block; flex: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; }

/* The mark: binoculars in a cobalt disc */
.mark { width: 40px; height: 40px; border-radius: 50%; background: #2a343e url("data:image/png;base64,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") center / cover; box-shadow: 0 0 0 1px var(--line-strong); color: #ffffff; display: grid; place-items: center; flex: none; position: relative; }
/* The logo is the background; the drawn glyph stays in the DOM for the progress ring. */
.mark > svg:first-child { visibility: hidden; }
.mark svg { width: 22px; height: 22px; }
.mark.small { width: 32px; height: 32px; }
.mark.small svg { width: 18px; height: 18px; }
.mark .badge { position: absolute; right: -3px; bottom: -3px; width: 18px; height: 18px; border-radius: 50%; background: var(--ok); color: var(--surface); display: grid; place-items: center; border: 2px solid var(--surface); }
.mark .badge svg { width: 10px; height: 10px; }
.ring { position: absolute; inset: -5px; width: 50px !important; height: 50px !important; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .track { stroke: var(--line); }
.ring .val { stroke: var(--primary); stroke-linecap: round; }

/* ---------- Launcher ---------- */
.launcher {
  display: flex; align-items: center; gap: 6px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 999px;
  box-shadow: var(--shadow); padding: 5px;
  max-width: calc(100vw - 24px);
}
.launch-main { display: flex; align-items: center; gap: 10px; border-radius: 999px; padding-right: 8px; min-width: 0; }
.launch-main:hover .launch-text b { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.launch-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.launch-text b { font-weight: 620; font-size: 14.5px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.launch-text span { font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.launcher.plain { gap: 2px; padding: 4px; }
.launcher.plain .launch-main { padding: 0 10px 0 4px; gap: 8px; height: 36px; }
.launcher.plain .launch-main b { font-size: 13.5px; font-weight: 600; }
.launcher.plain .mark { width: 28px; height: 28px; }
.launcher.plain .mark svg { width: 16px; height: 16px; }
.launcher .sep { width: 1px; height: 20px; background: var(--line); margin: 0 2px; }
.icon-btn { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); flex: none; }
.icon-btn:hover { background: var(--sunken); color: var(--ink); }
.icon-btn svg { width: 16px; height: 16px; }
.pill { background: var(--primary); color: var(--on-primary); border-radius: 999px; padding: 0 16px; height: 38px; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; flex: none; }
.pill:hover { background: var(--primary-hover); }
.pill svg { width: 13px; height: 13px; }
.pill.outline { background: var(--surface); color: var(--ink); border: 1px solid var(--line-strong); height: 34px; padding: 0 12px; font-size: 13px; }
.pill.outline:hover { background: var(--sunken); }
.pill.outline svg { width: 11px; height: 11px; }
@media (max-width: 1279px) { .launcher .launch-text.can-drop span { display: none; } }
@media (max-width: 520px) { .launcher .launch-text.can-drop { display: none; } .launcher .launch-main { padding-right: 0; } }

/* ---------- Card ---------- */
.card {
  width: 376px; max-width: calc(100vw - 24px); max-height: calc(100vh - 40px);
  background: var(--surface); border: 1px solid var(--line); border-radius: 20px;
  box-shadow: var(--shadow); overflow: hidden;
  display: flex; flex-direction: column;
}
.head { display: flex; align-items: center; gap: 8px; padding: 12px 10px 12px 14px; flex: none; }
.head .mark { margin-right: 4px; }
.head .grow { flex: 1; }
.tabs { display: flex; background: var(--sunken); border-radius: 999px; padding: 3px; gap: 2px; }
.tabs button { border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 560; color: var(--muted); }
.tabs button[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(16,24,32,.14); }
.back { display: flex; align-items: center; gap: 6px; font-weight: 620; font-size: 15px; padding: 4px 8px 4px 4px; border-radius: 8px; }
.back svg { width: 16px; height: 16px; }
.body { padding: 4px 20px 18px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
.lede h2 { margin: 0; font-size: 19px; line-height: 1.25; font-weight: 660; letter-spacing: -.01em; overflow-wrap: anywhere; }
.lede p { margin: 4px 0 0; color: var(--muted); font-size: 13.5px; }
.lede.withicon { display: flex; gap: 12px; align-items: flex-start; }
.lede.withicon > div { min-width: 0; }
.state-icon { margin-top: 1px; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--ok-soft); color: var(--ok); }
.state-icon svg { width: 13px; height: 13px; }
.state-icon.neutral { background: var(--sunken); color: var(--muted); }
.state-icon.warn { background: var(--warn-soft); color: var(--warn); }
.panel { background: var(--sunken); border-radius: 14px; padding: 14px 16px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.row .l { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
.row .l b { font-weight: 580; font-size: 14px; }
.row .l span { color: var(--muted); font-size: 12.5px; }
.stepper { display: flex; align-items: center; gap: 2px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 2px; flex: none; }
.stepper button { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--muted); }
.stepper button:hover { background: var(--sunken); color: var(--ink); }
.stepper button svg { width: 12px; height: 12px; }
.stepper input { width: 40px; border: 0; background: none; text-align: center; font-weight: 620; font-variant-numeric: tabular-nums; color: var(--ink); -moz-appearance: textfield; padding: 0; border-radius: 6px; }
.stepper input::-webkit-inner-spin-button, .stepper input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.primary { height: 46px; border-radius: 12px; background: var(--primary); color: var(--on-primary); font-weight: 620; font-size: 15px; display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; }
.primary:hover { background: var(--primary-hover); }
.primary svg { width: 16px; height: 16px; }
.secondary { height: 40px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); font-weight: 580; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 14px; width: 100%; }
.secondary:hover { background: var(--sunken); }
.secondary svg { width: 14px; height: 14px; }
.quiet { color: var(--muted); font-weight: 560; font-size: 13.5px; padding: 6px 6px; border-radius: 8px; }
.quiet:hover { color: var(--ink); background: var(--sunken); }
.actions { display: flex; flex-direction: column; gap: 8px; }
.split { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.note { color: var(--muted); font-size: 12.5px; display: flex; gap: 8px; align-items: flex-start; margin: 0; }
.note svg { width: 14px; height: 14px; margin-top: 2px; }
.notice { font-size: 13px; border-radius: 12px; padding: 10px 12px; background: var(--warn-soft); color: var(--warn); display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.notice.info { background: var(--soft); color: var(--soft-ink); }
.notice button { font-weight: 620; text-decoration: underline; text-underline-offset: 2px; flex: none; }

/* progress */
.progress-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.progress-top b { font-size: 15px; font-weight: 620; }
.progress-top span { color: var(--muted); font-size: 13px; }
.ticks { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; margin: 10px 0; }
.ticks i { height: 8px; border-radius: 4px; background: var(--line); }
.ticks i.done { background: var(--primary); }
.ticks i.now { background: linear-gradient(90deg, var(--primary) 50%, var(--line) 50%); }
.ticks i.skip { background: repeating-linear-gradient(135deg, var(--line-strong) 0 2px, transparent 2px 5px); box-shadow: inset 0 0 0 1px var(--line); }
.count { font-size: 13.5px; }
.count b { font-weight: 620; }
.endline { color: var(--muted); font-size: 12.5px; margin: 0; }

/* the count, its pages strip and one quiet line */
.hero { display: flex; flex-direction: column; gap: 10px; }
.tally { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.num { margin: 0; font-size: 15px; color: var(--muted); }
.num b { font-size: 30px; line-height: 1; font-weight: 680; letter-spacing: -.02em; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 2px; }
.hero .ticks { margin: 0; }
.meta { margin: 0; color: var(--muted); font-size: 13px; }
.meta.warn { color: var(--warn); }
.row .label { font-weight: 580; font-size: 14px; }
/* Download Excel, with the other formats unfolding under it */
.dl-row { display: flex; gap: 2px; }
.dl-main { border-top-right-radius: 4px; border-bottom-right-radius: 4px; }
.dl-more { width: 46px; flex: none; border-top-left-radius: 4px; border-bottom-left-radius: 4px; }
.dl-more svg { width: 14px; height: 14px; }
.dl-more[aria-expanded="true"] svg { transform: rotate(180deg); }
.menu { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.menu button { height: 36px; border-radius: 10px; border: 1px solid var(--line-strong); display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 580; font-size: 13.5px; }
.menu button:hover { background: var(--sunken); }
.menu svg { width: 14px; height: 14px; color: var(--muted); }

/* toast: floats above the dock so the card never changes shape */
.toast { position: absolute; right: 0; bottom: calc(100% + 10px); display: flex; align-items: center; gap: 8px; padding: 9px 14px 9px 12px; border-radius: 999px; background: var(--primary); color: var(--on-primary); font-size: 13.5px; font-weight: 560; box-shadow: var(--shadow); white-space: nowrap; animation: toast-in .18s ease-out; }
.toast svg { width: 14px; height: 14px; }
.toast.warn { background: var(--warn-soft); color: var(--warn); white-space: normal; max-width: 320px; border-radius: 14px; }
@keyframes toast-in { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }

/* results */
.linkrow { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; width: 100%; }
.linkrow:hover { background: var(--sunken); }
.linkrow .l { display: flex; flex-direction: column; line-height: 1.3; margin-right: auto; min-width: 0; }
.linkrow .l b { font-weight: 580; }
.linkrow .l span { color: var(--muted); font-size: 12.5px; }
.linkrow svg { width: 16px; height: 16px; color: var(--muted); }
.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 10px 0 0; }
.bar i { display: block; height: 100%; background: var(--primary); border-radius: 3px; }

/* chat */
.scope { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--soft-ink); background: var(--soft); border-radius: 12px; padding: 5px 12px 5px 10px; align-self: flex-start; max-width: 100%; }
.scope span { overflow-wrap: anywhere; }
.scope svg { width: 14px; height: 14px; }
.scope b { font-weight: inherit; white-space: nowrap; }
.thread { display: flex; flex-direction: column; gap: 10px; min-height: 160px; max-height: 340px; overflow-y: auto; }
.msg { max-width: 86%; padding: 9px 13px; border-radius: 16px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.me { align-self: flex-end; background: var(--primary); color: var(--on-primary); border-bottom-right-radius: 6px; }
.msg.ai { align-self: flex-start; background: var(--sunken); border-bottom-left-radius: 6px; }
.msg.ai.error { background: var(--warn-soft); color: var(--warn); }
.msg.ai.wait { color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line-strong); border-radius: 999px; padding: 6px 12px; font-size: 13px; background: var(--surface); }
.chip:hover { background: var(--sunken); }
.compose { display: flex; gap: 8px; align-items: center; border: 1px solid var(--line-strong); border-radius: 14px; padding: 5px 5px 5px 14px; background: var(--surface); }
.compose:focus-within { border-color: var(--ring); box-shadow: 0 0 0 1px var(--ring); }
.compose input { flex: 1; border: 0; background: none; color: var(--ink); min-width: 0; padding: 6px 0; }
.compose input:focus-visible { outline: none; }
.compose input::placeholder { color: var(--muted); }
.send { width: 34px; height: 34px; border-radius: 10px; background: var(--primary); color: var(--on-primary); display: grid; place-items: center; flex: none; }
.send svg { width: 16px; height: 16px; }

/* settings */
.set { display: flex; flex-direction: column; gap: 16px; }
.set + .set { border-top: 1px solid var(--line); padding-top: 14px; }
.switch { width: 40px; height: 24px; border-radius: 999px; background: var(--line-strong); position: relative; flex: none; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch[aria-checked="true"] { background: var(--primary); }
.switch[aria-checked="true"]::after { left: 19px; background: var(--on-primary); }
.status { font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.status i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.status.on { color: var(--ok); } .status.on i { background: var(--ok); }
.compact { height: 34px; border-radius: 10px; padding: 0 12px; font-size: 13px; width: auto; flex: none; }
.optional { color: var(--muted); font-weight: 400; }
.foot { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; margin: 0; }

@media (max-width: 480px) {
  .dock { right: 12px; bottom: 12px; }
  .card { max-height: calc(100vh - 24px); }
  .body { padding: 4px 16px 16px; }
}
@media (prefers-reduced-motion: no-preference) {
  .card { animation: grow .2s cubic-bezier(.2,.8,.2,1); transform-origin: bottom right; }
  @keyframes grow { from { opacity: 0; transform: translateY(6px) scale(.97); } }
  .ticks i, .bar i, .ring .val { transition: background-color .3s, width .3s, stroke-dasharray .3s; }
}
`;
