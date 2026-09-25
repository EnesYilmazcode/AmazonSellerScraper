// Reaches the dock inside its closed shadow root through CDP, which can
// pierce closed roots. Page scripts cannot, and neither can Playwright's
// locators, so the tests read and click it here. Clicks are real mouse
// clicks at the element's center.

import { sleep } from './extension.mjs';

const HOST = 'proscan-dock-host';

function findHost(node) {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'id' && a[i + 1] === HOST) return node;
  for (const c of node.children || []) {
    const f = findHost(c);
    if (f) return f;
  }
  return null;
}

export async function dock(page) {
  const cdp = await page.context().newCDPSession(page);

  async function shadowId() {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findHost(root);
    return host && host.shadowRoots && host.shadowRoots[0] ? host.shadowRoots[0].nodeId : null;
  }

  async function query(selector) {
    const id = await shadowId();
    if (!id) return null;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: id, selector });
    return nodeId || null;
  }

  async function call(selector, fn) {
    const nodeId = await query(selector);
    if (!nodeId) return undefined;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: fn, returnByValue: true,
    });
    return result.value;
  }

  const api = {
    /** True when the page has a dock host at all. */
    async present() {
      return page.evaluate((id) => !!document.getElementById(id), HOST);
    },
    has: async (selector) => !!(await query(selector)),
    text: async (selector = '.dock') => {
      const t = await call(selector, 'function () { return this.textContent; }');
      return t === undefined ? null : t.replace(/\s+/g, ' ').trim();
    },
    attr: (selector, name) => call(selector, `function () { return this.getAttribute(${JSON.stringify(name)}); }`),
    count: async (selector) => {
      const id = await shadowId();
      if (!id) return 0;
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: id, selector });
      return nodeIds.length;
    },
    async box(selector) {
      const nodeId = await query(selector);
      if (!nodeId) return null;
      const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
      const q = model.border;
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    },
    async click(selector) {
      const b = await api.box(selector);
      if (!b) throw new Error(`dock has no ${selector}`);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    },
    /** Focuses the element as a keyboard user would, so :focus-visible shows. */
    async focus(selector) {
      await page.keyboard.press('Shift');
      const nodeId = await query(selector);
      if (!nodeId) throw new Error(`dock has no ${selector}`);
      await cdp.send('DOM.focus', { nodeId });
    },
    async waitFor(selector, { timeout = 15000 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await query(selector)) return true;
        await sleep(150);
      }
      throw new Error(`dock never showed ${selector}`);
    },
    async waitForText(re, { selector = '.dock', timeout = 15000 } = {}) {
      const end = Date.now() + timeout;
      let last = null;
      while (Date.now() < end) {
        last = await api.text(selector);
        if (last && re.test(last)) return last;
        await sleep(150);
      }
      throw new Error(`dock text never matched ${re}; last: ${last}`);
    },
  };
  return api;
}
