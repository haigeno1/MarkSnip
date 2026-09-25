/**
 * @jest-environment node
 *
 * Failure paths in the real service worker: downloads the Downloads API refuses,
 * "all tabs" commands that meet a tab they cannot read, and reader sessions
 * filling session storage.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcRoot = path.join(__dirname, '../..');

// A browser API where every unspecified member is a harmless callable stub.
function createApiStub(overrides) {
  const make = (pathKey, thenable = false) => new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return thenable ? (resolve) => resolve(make(pathKey)) : undefined;
      if (thenable && (prop === 'catch' || prop === 'finally')) return () => make(pathKey, true);
      if (prop === Symbol.toPrimitive) return () => '';
      const key = pathKey ? `${pathKey}.${String(prop)}` : String(prop);
      if (key in overrides) return overrides[key];
      return make(key);
    },
    apply() {
      return make(`${pathKey}()`, true);
    }
  });
  return make('');
}

function createSessionStorage(quotaBytes) {
  const data = new Map();
  const size = () => Array.from(data.values()).reduce((total, value) => total + JSON.stringify(value).length, 0);
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => data.has(key)).map(key => [key, data.get(key)]));
    },
    async set(items) {
      const previous = new Map(data);
      Object.entries(items).forEach(([key, value]) => data.set(key, value));
      if (size() > quotaBytes) {
        data.clear();
        previous.forEach((value, key) => data.set(key, value));
        throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      }
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach(key => data.delete(key));
    }
  };
}

function loadServiceWorker({ downloadError = 'Download failed', sessionQuota = 10 * 1024 * 1024, tabs = [] } = {}) {
  const pageScripts = [];
  const revoked = [];
  const session = createSessionStorage(sessionQuota);
  const browser = createApiStub({
    'storage.sync.get': async () => ({}),
    'storage.local.get': async () => ({}),
    'storage.session': session,
    'runtime.getManifest': () => ({ version: '0.0.0', manifest_version: 3 }),
    'runtime.getURL': (p) => `moz-extension://test/${p}`,
    'i18n.getMessage': () => '',
    'i18n.getUILanguage': () => 'en',
    'tabs.query': async () => tabs,
    'tabs.get': async (id) => tabs.find(tab => tab.id === id) || { id, url: 'https://example.com/article' },
    'downloads.download': async () => { throw new Error(downloadError); },
    'scripting.executeScript': async ({ func, args }) => {
      const source = String(func || '');
      if (source.includes('hasContentScript')) return [{ result: { hasPolyfill: true, hasContentScript: true } }];
      if (source.includes('link.download')) pageScripts.push({ filename: args[0], content: Buffer.from(args[1], 'base64').toString('utf8') });
      return [{ result: true }];
    },
    offscreen: undefined
  });
  class TrackedURL extends URL {
    static createObjectURL(blob) { return URL.createObjectURL(blob); }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    browser,
    chrome: browser,
    fetch: async () => ({ ok: true }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: TrackedURL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob,
    crypto: globalThis.crypto,
    navigator: { userAgent: 'Firefox' },
    structuredClone, queueMicrotask, atob, btoa, Intl
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);

  const swSource = fs.readFileSync(path.join(srcRoot, 'service-worker.js'), 'utf8');
  const importList = swSource.match(/importScripts\(([\s\S]*?)\);/)[1];
  const scripts = Array.from(importList.matchAll(/'([^']+\.js)'/g), m => m[1]).concat('service-worker.js');
  for (const rel of scripts) {
    if (rel.includes('browser-polyfill')) continue;
    vm.runInContext(fs.readFileSync(path.join(srcRoot, rel), 'utf8'), context, { filename: rel });
  }
  const pendingTracked = () => vm.runInContext('markSnipUrls.size + markSnipBlobUrls.size + markSnipDownloads.size', context);
  return { context, pageScripts, revoked, session, pendingTracked };
}

const downloadOptions = { downloadMode: 'downloadsApi', downloadImages: false, saveAs: false };

describe('download failures', () => {
  test('a refused download is saved through the page and its blob is released', async () => {
    const sw = loadServiceWorker();
    await sw.context.downloadMarkdown('# Clip\n\nBody', 'My clip', 5, {}, '', { ...sw.context.defaultOptions, ...downloadOptions });

    expect(sw.pageScripts).toEqual([{ filename: 'My clip.md', content: '# Clip\n\nBody' }]);
    expect(sw.revoked).toHaveLength(1);
    expect(sw.pendingTracked()).toBe(0);
  });

  test('a cancelled Save As dialog cleans up without saving anyway', async () => {
    const sw = loadServiceWorker({ downloadError: 'Download canceled by the user' });
    await sw.context.downloadMarkdown('# Clip', 'My clip', 5, {}, '', { ...sw.context.defaultOptions, ...downloadOptions, saveAs: true });

    expect(sw.pageScripts).toEqual([]);
    expect(sw.revoked).toHaveLength(1);
    expect(sw.pendingTracked()).toBe(0);
  });

  test('the offscreen page\'s failure report saves the Markdown through the page', async () => {
    const sw = loadServiceWorker();
    await sw.context.handleMessages({
      type: 'offscreen-download-failed',
      markdown: '# From offscreen',
      title: 'Folder/Offscreen clip',
      tabId: 5,
      options: sw.context.defaultOptions,
      error: 'Download failed'
    }, {});

    expect(sw.pageScripts).toEqual([{ filename: 'Offscreen clip.md', content: '# From offscreen' }]);
  });
});

describe('commands that act on every tab', () => {
  test('download all tabs continues past a tab that cannot be downloaded', async () => {
    const tabs = [
      { id: 1, url: 'https://example.com/a' },
      { id: 2, url: 'chrome://settings' },
      { id: 3, url: 'https://example.com/broken' },
      { id: 4, url: 'https://example.com/b' }
    ];
    const sw = loadServiceWorker({ tabs });
    const attempted = [];
    sw.context.downloadMarkdownFromContext = async (_info, tab) => {
      attempted.push(tab.id);
      if (tab.id === 3) throw new Error('Cannot access contents of the page');
    };
    vm.runInContext('downloadMarkdownFromContext = globalThis.downloadMarkdownFromContext', sw.context);

    await expect(sw.context.downloadMarkdownForAllTabs({})).resolves.toBeUndefined();
    expect(attempted).toEqual([1, 3, 4]);
  });
});

describe('reader sessions', () => {
  const readerKeys = (sw) => Array.from(sw.session.data.keys()).filter(key => key.startsWith('reader-session:'));

  test('keeps only the most recent sessions', async () => {
    const sw = loadServiceWorker();
    for (let i = 0; i < 40; i++) {
      await sw.context.saveReaderSession({ title: `Page ${i}`, content: '<p>x</p>' });
    }
    expect(readerKeys(sw)).toHaveLength(25);
  });

  test('drops the oldest sessions when storage is full instead of failing', async () => {
    const sw = loadServiceWorker({ sessionQuota: 5000 });
    const big = 'x'.repeat(2000);
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await sw.context.saveReaderSession({ title: `Page ${i}`, content: big }));
    }
    expect(readerKeys(sw).length).toBeGreaterThan(0);
    await expect(sw.context.readReaderSession(ids[5])).resolves.toEqual(expect.objectContaining({ title: 'Page 5' }));
    await expect(sw.context.readReaderSession(ids[0])).resolves.toBeNull();
  });
});
