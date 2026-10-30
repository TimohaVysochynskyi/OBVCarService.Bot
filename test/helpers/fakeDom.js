const camel = (name) => name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseSelector(selector) {
  const m = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\](\[(\w+)\])?$/);
  if (!m) throw new Error(`фейковий DOM не розуміє селектор ${selector}`);
  return { attr: m[1], value: m[2], flag: m[4] };
}

function el(tag, attrs = {}, children = []) {
  const node = {
    tag,
    attrs: { ...attrs },
    children,
    parent: null,
    hidden: false,
    innerHTML: '',
    textContent: '',
    style: {},
    listeners: {},
    boxWidth: null,
  };
  node.dataset = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) node.dataset[camel(k)] = v;

  node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
  node.removeAttribute = (name) => { delete node.attrs[name]; };
  node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
  node.contains = (other) => other === node || node.children.some((c) => c.contains(other));
  node.querySelectorAll = (selector) => descendants(node).filter((n) => matches(n, selector));
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.getBoundingClientRect = () => ({ width: visibleWidth(node), left: 0, top: 0 });
  node.fire = (type, event = {}) => (node.listeners[type] || []).forEach((fn) => fn(event));

  for (const child of children) child.parent = node;
  return node;
}

function matches(node, selector) {
  const { attr, value, flag } = parseSelector(selector);
  if (!(attr in node.attrs)) return false;
  if (value != null && node.attrs[attr] !== value) return false;
  if (flag && !(flag in node.attrs)) return false;
  return true;
}

function descendants(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function visibleWidth(node) {
  let width = null;
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.hidden) return 0;
    if (width == null && cur.boxWidth != null) width = cur.boxWidth;
  }
  return width == null ? 0 : width;
}

function makeDom(root, { data = null, readyState = 'complete' } = {}) {
  const frames = [];
  const timers = [];
  let nextFrame = 1;

  const dataNode = data ? el('script', { id: 'report-data' }) : null;
  if (dataNode) {
    dataNode.textContent = JSON.stringify(data);
    dataNode.parent = root;
    root.children.push(dataNode);
  }

  const document = {
    readyState,
    listeners: {},
    getElementById: (id) => descendants(root).find((n) => n.attrs.id === id) || null,
    querySelectorAll: (selector) => descendants(root).filter((n) => matches(n, selector)),
    querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
    addEventListener: (type, fn) => { (document.listeners[type] = document.listeners[type] || []).push(fn); },
  };

  const window = {
    listeners: {},
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => { (window.listeners[type] = window.listeners[type] || []).push(fn); },
    fire: (type, event = {}) => (window.listeners[type] || []).forEach((fn) => fn(event)),
  };

  const requestAnimationFrame = (fn) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.push({ id, fn });
    return id;
  };
  const cancelAnimationFrame = (id) => {
    const at = frames.findIndex((f) => f.id === id);
    if (at >= 0) frames.splice(at, 1);
  };
  const setTimeout = (fn) => {
    const id = timers.length + 1;
    timers.push({ id, fn });
    return id;
  };
  const clearTimeout = (id) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };

  const runFrames = (times) => {
    for (const at of times) {
      const due = frames.splice(0, frames.length);
      for (const frame of due) frame.fn(at);
    }
  };
  const runTimers = () => {
    const due = timers.splice(0, timers.length);
    for (const timer of due) timer.fn();
  };

  const run = (source) => {
    const fn = new Function(
      'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'console',
      source
    );
    fn(document, window, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout, console);
  };

  return { document, window, run, runFrames, runTimers, pendingFrames: () => frames.length };
}

const viewBoxWidth = (svg) => Number(String(svg.getAttribute('viewBox') || '').split(' ')[2]);

function pathYs(svg) {
  return [...String(svg.innerHTML).matchAll(/<path d="([^"]+)"/g)].map((m) =>
    m[1].split(/[ML]\s*/).filter(Boolean).map((pair) => Number(pair.trim().split(/\s+/)[1]))
  );
}

export { el, makeDom, viewBoxWidth, pathYs, descendants };
