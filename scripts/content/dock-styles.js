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
  --sunken: #f4f5f7;
  --ink: #16181d;
  --muted: #5c6270;
  --line: #e3e5ea;
  --line-strong: #cfd3da;
  --primary: #3548d4;
  --primary-hover: #2b3cc0;
  --on-primary: #ffffff;
  --soft: #eceefc;
  --soft-ink: #2a37a8;
  --ok: #1f7a4d;
  --ok-soft: #e3f3ea;
  --warn: #8a4b08;
  --warn-soft: #fbf0e1;
  --ring: #16181d;
  --shadow: 0 0 0 1px rgba(20,22,30,.05), 0 2px 4px rgba(20,22,30,.06), 0 18px 40px -10px rgba(20,22,30,.28);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end;
  font: 400 14px/1.45 var(--font); color: var(--ink);
  -webkit-font-smoothing: antialiased; text-align: left;
  font-variant-numeric: tabular-nums;
}
@media (prefers-color-scheme: dark) {
  .dock {
    --surface: #1a1c21; --sunken: #23262d; --ink: #eceef2; --muted: #a2a8b4; --line: #30343c; --line-strong: #454a55;
    --primary: #8b97ff; --primary-hover: #a2acff; --on-primary: #11131a; --soft: #262a45; --soft-ink: #c3c9ff;
    --ok: #5cc493; --ok-soft: #1c3329; --warn: #f0b36b; --warn-soft: #3a2c1a;
    --ring: #f4f5f7;
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
.mark { width: 40px; height: 40px; border-radius: 50%; background: var(--primary); color: var(--on-primary); display: grid; place-items: center; flex: none; position: relative; }
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

/* results */
.facts { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; }
.facts div { display: flex; flex-direction: column; padding: 0 12px; border-left: 1px solid var(--line); min-width: 0; }
.facts div:first-child { padding-left: 0; border-left: 0; }
.facts dt { color: var(--muted); font-size: 12.5px; order: 2; }
.facts dd { margin: 0; font-weight: 640; font-size: 17px; order: 1; }
.formats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
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
.set { display: flex; flex-direction: column; gap: 12px; }
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
