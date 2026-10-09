'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

function dataName(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function selectorPart(selector) {
  return selector.trim().split(/\s+/).at(-1);
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);


function findTagEnd(markup, start) {
  let quote = '';
  for (let i = start; i < markup.length; i += 1) {
    const char = markup[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function applyAttributes(element, source) {
  for (const attr of source.matchAll(/([:\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = attr[1], valueText = attr[2] ?? attr[3] ?? attr[4] ?? '';
    element.attributes.set(name, valueText);
    if (name === 'id') {
      element.id = valueText;
      element.ownerDocument?.ids?.set(valueText, element);
    } else if (name === 'class') {
      valueText.split(/\s+/).filter(Boolean).forEach(c => element.classList.add(c));
    } else if (name.startsWith('data-')) {
      element.dataset[dataName(name)] = valueText;
    } else if (name === 'value') {
      element.value = valueText;
    } else if (name === 'type') {
      element.type = valueText;
    } else if (name === 'min' || name === 'max') {
      element[name] = valueText;
    } else if (name === 'disabled') {
      element.disabled = true;
    } else {
      element[name] = valueText;
    }
  }
}

function parseMarkup(root, markup) {
  const stack = [root];
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf('<', cursor);
    if (start < 0) break;
    if (markup.startsWith('<!--', start)) {
      const commentEnd = markup.indexOf('-->', start + 4);
      cursor = commentEnd < 0 ? markup.length : commentEnd + 3;
      continue;
    }
    const end = findTagEnd(markup, start + 1);
    if (end < 0) break;
    const token = markup.slice(start, end + 1);
    const closing = token.match(/^<\s*\/\s*([a-z][\w-]*)[^>]*>$/i);
    if (closing) {
      const name = closing[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === name) {
          stack.length = i;
          break;
        }
      }
      cursor = end + 1;
      continue;
    }
    const opening = token.match(/^<\s*([a-z][\w-]*)([\s\S]*)>$/i);
    if (!opening || token.startsWith('<!') || token.startsWith('<?')) {
      cursor = end + 1;
      continue;
    }
    const tagName = opening[1];
    const attributes = opening[2];
    const selfClosing = /\/\s*$/.test(attributes);
    const child = new FakeElement(root.ownerDocument, tagName);
    applyAttributes(child, selfClosing ? attributes.replace(/\/\s*$/, '') : attributes);
    stack.at(-1).appendChild(child);
    if (!selfClosing && !VOID_ELEMENTS.has(tagName.toLowerCase())) stack.push(child);
    cursor = end + 1;
  }
}

function matches(element, selector) {
  selector = selectorPart(selector);
  if (selector.includes(',')) return selector.split(',').some(part => matches(element, part));
  const id = selector.match(/^#([\w-]+)$/);
  if (id) return element.id === id[1];
  const className = selector.match(/^\.([\w-]+)$/);
  if (className) return element.classList.contains(className[1]);
  const tag = selector.match(/^[a-z]+/i)?.[0]?.toUpperCase();
  if (tag && element.tagName !== tag) return false;
  for (const attr of selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    const [, name, expected] = attr;
    let actual;
    if (name.startsWith('data-')) actual = element.dataset[dataName(name)];
    else actual = element[name] ?? element.attributes.get(name);
    if (expected === undefined ? actual == null : String(actual) !== expected) return false;
  }
  return Boolean(tag || selector.startsWith('['));
}

class FakeElement {
  constructor(document, tagName = 'div', id = '') {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new ClassList();
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.value = '';
    this.type = '';
    this.min = '0';
    this.max = '100';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.scrollTop = 0;
    this.onclick = null;
    this.oninput = null;
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    parseMarkup(this, this._innerHTML);
  }
  get innerHTML() { return this._innerHTML; }
  set outerHTML(value) { this.innerHTML = value; }
  get outerHTML() { return this.innerHTML; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[dataName(name)] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    const e = { type, target: this, currentTarget: this, preventDefault() {}, ...event };
    if (type === 'click' && this.onclick) this.onclick(e);
    if (type === 'input' && this.oninput) this.oninput(e);
    for (const listener of this.listeners.get(type) || []) listener(e);
    return e;
  }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() {}
  matches(selector) { return matches(this, selector); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, 'document');
    this.ownerDocument = this;
    this.ids = new Map();
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.activeElement = null;
    this.title = 'Needle';
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    for (const id of ['gate','gateSetup','gateLogin','gateErr','redir','cid','saveCid','loginBtn','resetCid',
      'main','status','toast','pls','nav','genres','genreBtn','qset','ql','now','likeNow','pp','shuf','bar',
      'barFill','tpos','tdur','vol','back','theme','q','qclose','qtoggle','next','prev','radioNow']) {
      const element = new FakeElement(this, id === 'q' || id === 'vol' || id === 'cid' ? 'input' : 'div', id);
      this.ids.set(id, element);
      this.body.appendChild(element);
    }
    const meta = new FakeElement(this, 'meta');
    meta.attributes.set('name', 'theme-color');
    meta.content = '';
    this.head.appendChild(meta);
  }
  createElement(tag) { return new FakeElement(this, tag); }
  querySelector(selector) {
    if (/^#[\w-]+$/.test(selector)) return this.ids.get(selector.slice(1)) || null;
    return super.querySelector(selector);
  }
}

class FakeClock {
  constructor() { this.now = 0; this.next = 1; this.jobs = new Map(); }
  setTimeout(fn, delay = 0) { const id = this.next++; this.jobs.set(id, { fn, at: this.now + Number(delay), every: 0 }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  setInterval(fn, delay = 0) { const id = this.next++; this.jobs.set(id, { fn, at: this.now + Number(delay), every: Number(delay) || 1 }); return id; }
  clearInterval(id) { this.jobs.delete(id); }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every; else this.jobs.delete(id);
      job.fn();
    }
    this.now = end;
  }
}

function inlineScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  return scripts.at(-1);
}

function createHarness({ storage = {}, random = () => 0.5 } = {}) {
  const document = new FakeDocument();
  const clock = new FakeClock();
  const values = new Map(Object.entries(storage).map(([key, value]) => ['ndl.' + key, JSON.stringify(value)]));
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, document, localStorage,
    location: { origin: 'http://example.test', pathname: '/', search: '', href: '' },
    history: { replaceState() {} }, navigator: {}, innerWidth: 1280,
    CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
    MediaMetadata: class MediaMetadata { constructor(data) { Object.assign(this, data); } },
    URL, URLSearchParams, TextEncoder, Uint8Array, Set, Map, WeakMap, Promise, Error, JSON, Math: Object.create(Math),
    Date, crypto: webcrypto, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async () => { throw new Error('unexpected fetch'); },
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    setInterval: clock.setInterval.bind(clock), clearInterval: clock.clearInterval.bind(clock),
  });
  context.Math.random = random;
  context.window = context;
  vm.runInContext(inlineScript(), context, { filename: 'index.html', timeout: 1000 });
  const run = code => vm.runInContext(code, context, { timeout: 1000 });
  const json = code => JSON.parse(JSON.stringify(run(code)));
  const set = (name, value) => { context.__injected = value; run(`${name}=globalThis.__injected`); delete context.__injected; };
  return { context, document, clock, run, json, set, storage: values, element: id => document.ids.get(id) };
}

function artist(name, id = name.toLowerCase().replace(/\W+/g, '-')) { return { name, id }; }
function track(name, artists, extra = {}) {
  const credits = (Array.isArray(artists) ? artists : [artists]).map(value => typeof value === 'string' ? artist(value) : value);
  const slug = `${credits[0]?.id || 'none'}-${name.toLowerCase().replace(/\W+/g, '-')}`;
  return { uri: `spotify:track:${slug}`, id: slug, name, artists: credits,
    album: { id: `album-${slug}`, name: `Release ${name}`, img: '' }, ms: 180000, playable: true, ...extra };
}
function rawTrack(value) {
  return { uri: value.uri, id: value.id, name: value.name, artists: value.artists,
    album: { ...value.album, images: [] }, duration_ms: value.ms, is_playable: value.playable, is_local: Boolean(value.is_local), type: 'track' };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/* A macrotask barrier drains all currently resolvable promise chains, not an arbitrary depth. */
function settle() { return new Promise(resolve => setImmediate(resolve)); }

module.exports = { createHarness, artist, track, rawTrack, deferred, settle, FakeElement };
