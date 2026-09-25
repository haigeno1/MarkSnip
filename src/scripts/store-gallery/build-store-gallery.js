#!/usr/bin/env node
/*
 * Builds the Chrome Web Store / AMO gallery images in docs/store-screenshots.
 *
 * 1. Capture: loads the real unpacked extension, clips a local fixture article
 *    (fixtures/article.html, served on a fictional domain), makes real highlights,
 *    and screenshots the real popup, Reader View and highlights manager.
 * 2. Compose: drops those captures into branded 1280x800 frames, plus the
 *    1400x560 marquee and 440x280 small promo tile.
 *
 * Usage (from src/):
 *   npm run build:manifests && npm run capture:store-gallery
 *   node scripts/store-gallery/build-store-gallery.js --ext <unpacked dir> --raw <dir to keep raw captures>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(SRC, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(REPO, 'docs/store-screenshots');
const HOST = 'https://thelonghand.example';
const ARTICLE_URL = `${HOST}/why-plain-text-outlives-every-app`;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const EXT = path.resolve(argValue('--ext', path.join(SRC, '.build/chrome')));
const RAW_DIR = argValue('--raw', null);

const FIXTURE_ROUTES = {
  '/why-plain-text-outlives-every-app': ['article.html', 'text/html; charset=utf-8'],
  '/site.css': ['site.css', 'text/css'],
  '/img/hero.svg': ['hero.svg', 'image/svg+xml'],
};

/* ------------------------------------------------------------------ capture */

async function selectText(page, selector, phrase) {
  await page.evaluate(({ selector, phrase }) => {
    const root = document.querySelector(selector);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue.indexOf(phrase);
      if (start >= 0) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + phrase.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    throw new Error(`Phrase not found: ${phrase}`);
  }, { selector, phrase });
}

async function capture() {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    throw new Error(`No unpacked extension at ${EXT}. Run "npm run build:manifests" first or pass --ext.`);
  }
  const shots = {};
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    await context.route(`${HOST}/**`, (route) => {
      const entry = FIXTURE_ROUTES[new URL(route.request().url()).pathname];
      if (!entry) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ status: 200, contentType: entry[1], body: fs.readFileSync(path.join(FIXTURES, entry[0])) });
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const setSync = (values) => serviceWorker.evaluate((v) => browser.storage.sync.set(v), values);

    await serviceWorker.evaluate(() => browser.storage.local.remove(['marksnipHighlights', 'marksnipHighlightIndex']));
    await setSync({ popupTheme: 'light', includeTemplate: true, highlighterEnabled: true, alwaysShowHighlights: true, highlightClipBehavior: 'ignore' });

    const article = await context.newPage();
    await article.goto(ARTICLE_URL);
    await article.waitForLoadState('networkidle');
    shots.page = await article.screenshot();
    shots.clutter = await article.evaluate(() => ['.ad-strip', 'aside .ad', 'aside .newsletter', '.cookie'].map((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }));

    // Page region with the table, equation and code, for the "survives" slide.
    const tableTop = await article.evaluate(() => document.querySelector('article h2').getBoundingClientRect().top + window.scrollY - 24);
    await article.evaluate((y) => window.scrollTo(0, y), tableTop);
    await article.addStyleTag({ content: '.cookie{display:none}' });
    shots.pageDetail = await article.screenshot({ clip: { x: 80, y: 0, width: 760, height: 800 } });
    await article.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('style').forEach((s) => s.remove()); });

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 420, height: 700 });
    const openPopup = async () => {
      await article.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await popup.waitForFunction(() => {
        try { return typeof cm !== 'undefined' && cm.getValue().includes('plain text'); } catch { return false; }
      }, null, { timeout: 45000 });
      await popup.waitForTimeout(300);
    };
    const shootPopup = async () => {
      await popup.waitForTimeout(350);
      return popup.locator('#container').screenshot();
    };

    await openPopup();
    shots.markdown = await popup.evaluate(() => cm.getValue());
    shots.popupLight = await shootPopup();

    await setSync({ popupTheme: 'dark', compactMode: true });
    await openPopup();
    await popup.evaluate(() => {
      const line = cm.getValue().split('\n').findIndex((l) => l.startsWith('## The formats'));
      cm.scrollTo(null, cm.heightAtLine(line, 'local') - 8);
    });
    shots.popupDark = await shootPopup();
    await setSync({ popupTheme: 'light', compactMode: false });

    await openPopup();
    await popup.click('#batchProcess');
    await popup.waitForSelector('#batchContainer', { state: 'visible' });
    await popup.fill('#urlList', [
      'why-plain-text-outlives-every-app', 'the-case-for-boring-tools', 'notes-that-survive-a-migration',
      'a-field-guide-to-file-formats', 'markdown-for-researchers',
    ].map((slug) => `${HOST}/${slug}`).join('\n'));
    await popup.dispatchEvent('#urlList', 'input');
    await popup.evaluate(() => { document.querySelector('#urlList').scrollTop = 0; });
    shots.popupBatch = await shootPopup();

    // Real highlights on the article, then Reader View and the manager.
    const tabId = await serviceWorker.evaluate(async (url) => (await browser.tabs.query({})).find((t) => t.url === url)?.id, ARTICLE_URL);
    const tab = { id: tabId, url: ARTICLE_URL };
    await article.bringToFront();
    await serviceWorker.evaluate((t) => activateHighlighterForTab(t), tab);
    const highlights = [
      ['green', 'Plain text is the only format that has never let me down.'],
      ['yellow', 'diffs cleanly in version control'],
      ['green', "keeping what you write in a form you can read without anyone's permission"],
    ];
    for (const [color, phrase] of highlights) {
      await setSync({ highlightDefaultColor: color });
      await selectText(article, 'article', phrase);
      const result = await serviceWorker.evaluate(({ t }) => highlightSelectionFromContext({}, t), { t: tab });
      if (!result?.ok) throw new Error(`Highlight failed for "${phrase}"`);
    }
    await article.evaluate(() => window.getSelection().removeAllRanges());

    const [reader] = await Promise.all([
      context.waitForEvent('page'),
      serviceWorker.evaluate(async (id) => openReaderTabForTab(await browser.tabs.get(id)), tabId),
    ]);
    await reader.setViewportSize({ width: 1280, height: 800 });
    await reader.waitForLoadState('networkidle');
    await reader.bringToFront();
    await reader.waitForTimeout(2500);
    // Frame the highlighted paragraphs and the table; stop above the equation.
    await reader.evaluate(() => {
      const para = [...document.querySelectorAll('p')].find((p) => p.textContent.includes('Plain text is the only format'));
      window.scrollTo(0, para.getBoundingClientRect().top + window.scrollY - 260);
    });
    await reader.waitForTimeout(1500);
    shots.reader = await reader.screenshot();

    const manager = await context.newPage();
    await manager.setViewportSize({ width: 1100, height: 700 });
    await manager.goto(`chrome-extension://${extensionId}/highlights/highlights.html`);
    await manager.waitForTimeout(1000);
    shots.highlights = await manager.screenshot();
  } finally {
    await context.close();
  }

  if (RAW_DIR) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    for (const [name, value] of Object.entries(shots)) {
      if (Buffer.isBuffer(value)) fs.writeFileSync(path.join(RAW_DIR, `${name}.png`), value);
    }
    fs.writeFileSync(path.join(RAW_DIR, 'clip.md'), shots.markdown);
  }
  return shots;
}

/* ------------------------------------------------------------------ compose */

const dataUri = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;
const fontUri = (file) => dataUri(fs.readFileSync(path.join(SRC, 'shared/fonts', file)), 'font/woff2');

const MARK = `<svg class="mark" viewBox="-110 -71 220 142" aria-hidden="true">
  <rect x="-110" y="-71" width="220" height="142" rx="26" fill="#f4efe3"/>
  <g transform="translate(2 0)" fill="#141a12">
    <path d="M-80 40V-40h22l22 32 22-32h22v80h-22V-4l-22 30-22-30v44z"/>
    <path d="M38-40h22V2h16L49 40 22 2h16z"/>
  </g></svg>`;

const ICONS = {
  arrow: '<svg viewBox="0 0 24 24"><path d="M4 12h15m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><rect x="5.5" y="5" width="13" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.3"/><rect x="8.5" y="3" width="7" height="4.5" rx="1.5" fill="currentColor"/></svg>',
  gem: '<svg viewBox="0 0 24 24"><path d="M12 2.5 19 9l-3 12.5H8L5 9z M12 2.5 10.5 21.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  braces: '<svg viewBox="0 0 24 24"><path d="M9 4c-2.5 0-3 1.2-3 3v2.5C6 11 5 12 3.5 12 5 12 6 13 6 14.5V17c0 1.8.5 3 3 3m6-16c2.5 0 3 1.2 3 3v2.5c0 1.5 1 2.5 2.5 2.5-1.5 0-2.5 1-2.5 2.5V17c0 1.8-.5 3-3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><path d="m5 7 5 5-5 5m7 1h7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  books: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="4.5" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="10.5" y="4" width="4.5" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m17 5 3.5 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" fill="currentColor"/></svg>',
  zip: '<svg viewBox="0 0 24 24"><path d="M6 2.5h9l4 4v15H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M11 5h2m-2 3h2m-2 3h2m-2 3h2" stroke="currentColor" stroke-width="2"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M8 6.5h8l3 3v12H8z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M5 17.5v-15h8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M6 2.5h9l4 4v15H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 11h7m-7 3.5h7m-7 3.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

function baseCss(w, h) {
  return `
  @font-face { font-family: 'DMS'; src: url(${fontUri('dm-sans-latin.woff2')}) format('woff2'); font-weight: 100 1000; }
  @font-face { font-family: 'InterV'; src: url(${fontUri('inter-latin.woff2')}) format('woff2'); font-weight: 100 900; }
  :root { --cream: #f4efe3; --lime: #b9e46c; --sage: #6b8e6f; --muted: #aab3a2; --ink: #141a12; --mono: 'Cascadia Mono', Consolas, monospace; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #070c07; }
  .frame { position: relative; width: ${w}px; height: ${h}px; overflow: hidden; color: var(--cream); font-family: 'DMS', sans-serif;
    background:
      radial-gradient(900px 600px at 18% 8%, rgba(185,228,108,.10), transparent 60%),
      radial-gradient(900px 700px at 92% 100%, rgba(107,142,111,.20), transparent 60%),
      linear-gradient(135deg, #132313 0%, #0a130b 52%, #050805 100%); }
  .frame::before { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(-60deg, rgba(185,228,108,.032) 0 2px, transparent 2px 52px); }
  .frame::after { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,.45) 100%); }
  .brand { position: absolute; display: flex; align-items: center; gap: 12px; font-weight: 800; font-size: 24px; letter-spacing: -.3px; z-index: 5; }
  .brand .mark { width: 46px; height: 30px; }
  .kicker { font-family: var(--mono); font-size: 14px; font-weight: 700; letter-spacing: 4.5px; text-transform: uppercase; color: var(--lime); margin-bottom: 18px; }
  h1 { font-weight: 800; letter-spacing: -2.4px; line-height: 1.0; }
  h1 em { font-style: normal; color: var(--lime); }
  .sub { font-family: 'InterV', sans-serif; font-weight: 500; font-size: 21px; line-height: 1.45; color: var(--muted); }
  .sub b { color: var(--cream); font-weight: 600; }
  .shot { position: absolute; display: block; border-radius: 16px; z-index: 2;
    box-shadow: 0 50px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.09); }
  .browser { position: absolute; border-radius: 16px; overflow: hidden; background: #1a231a; z-index: 1;
    box-shadow: 0 50px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
  .browser .bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 14px; }
  .browser .bar i { width: 11px; height: 11px; border-radius: 50%; background: #ff5f57; }
  .browser .bar i:nth-child(2) { background: #febc2e; } .browser .bar i:nth-child(3) { background: #28c840; }
  .browser .url { margin-left: 14px; flex: 1; height: 24px; border-radius: 12px; background: #0e150e; color: #8f9a88;
    font: 500 12.5px 'InterV'; display: flex; align-items: center; gap: 7px; padding: 0 12px; }
  .browser .url svg { width: 11px; height: 11px; color: #8f9a88; }
  .browser .ext { width: 34px; height: 22px; display: grid; place-items: center; border-radius: 6px; background: rgba(185,228,108,.18); box-shadow: 0 0 0 1.5px var(--lime); }
  .browser .ext .mark { width: 26px; height: 17px; }
  .browser .view { position: relative; overflow: hidden; }
  .browser .view img { display: block; width: 100%; }
  .chip { display: inline-flex; align-items: center; gap: 9px; padding: 10px 16px; border-radius: 999px; font: 600 16px 'InterV';
    background: rgba(185,228,108,.1); box-shadow: inset 0 0 0 1.5px rgba(185,228,108,.35); color: var(--cream); }
  .chip svg { width: 18px; height: 18px; color: var(--lime); }
  .tag { position: absolute; border: 2.5px dashed #ff5a4f; background: rgba(255,90,79,.13); border-radius: 6px; z-index: 1; }
  .tag span { position: absolute; left: -2px; top: -24px; background: #ff5a4f; color: #fff; font: 800 11px 'InterV'; letter-spacing: 1px;
    padding: 4px 8px; border-radius: 5px; white-space: nowrap; }
  .label { font-family: var(--mono); font-size: 12.5px; font-weight: 700; letter-spacing: 3px; color: var(--muted); text-transform: uppercase; }
  `;
}

const brand = (x, y, extra = '') => `<div class="brand" style="left:${x}px;top:${y}px;${extra}">${MARK}<span>MarkSnip</span></div>`;

function browser({ x, y, w, img, imgW = 1280, url, clutter = [], ext = true, rot = 0 }) {
  const scale = w / imgW;
  const tags = clutter.map((c) => `<div class="tag" style="left:${c.x * scale}px;top:${c.y * scale}px;width:${c.w * scale}px;height:${c.h * scale}px"><span>✕ CLUTTER</span></div>`).join('');
  return `<div class="browser" style="left:${x}px;top:${y}px;width:${w}px;transform:rotate(${rot}deg)">
    <div class="bar"><i></i><i></i><i></i><div class="url">${ICONS.lock}${url}</div>${ext ? `<div class="ext">${MARK}</div>` : ''}</div>
    <div class="view"><img src="${img}">${tags}</div></div>`;
}

const page = (w, h, css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(w, h)}${css}</style></head>
<body><div class="frame">${body}</div></body></html>`;

function slides(shots) {
  const img = Object.fromEntries(Object.entries(shots).filter(([, v]) => Buffer.isBuffer(v)).map(([k, v]) => [k, dataUri(v)]));
  const S = {};

  // 1 — Hero
  S['01-clip-article'] = page(1280, 800, `
    .copy { position: absolute; left: 64px; top: 168px; width: 360px; z-index: 3; }
    h1 { font-size: 68px; margin-bottom: 24px; letter-spacing: -2px; }
    .sub { font-size: 20px; }
    .chips { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 30px; }
    .arrow { position: absolute; left: 872px; top: 396px; width: 70px; height: 70px; border-radius: 50%; background: var(--lime); z-index: 4;
      display: grid; place-items: center; box-shadow: 0 0 0 10px rgba(185,228,108,.18), 0 20px 40px rgba(0,0,0,.5); }
    .arrow svg { width: 34px; height: 34px; color: var(--ink); }`,
  `${brand(64, 56)}
    <div class="copy">
      <div class="kicker">Chrome &amp; Firefox</div>
      <h1>Any page.<br><em>Clean Markdown.</em></h1>
      <p class="sub">One click strips the ads, banners and pop-ups. You get <b>Markdown you can edit, keep and send anywhere.</b></p>
      <div class="chips"><span class="chip">${ICONS.check}Tables, code &amp; math</span><span class="chip">${ICONS.check}Front matter templates</span></div>
    </div>
    ${browser({ x: 432, y: 236, w: 560, img: img.page, url: 'thelonghand.example/why-plain-text-outlives-every-app', clutter: shots.clutter })}
    <div class="arrow">${ICONS.arrow}</div>
    <img class="shot" src="${img.popupLight}" style="left:914px;top:150px;width:326px">`);

  // 2 — Fidelity
  S['02-code-tables-math'] = page(1280, 800, `
    .copy { position: absolute; left: 64px; top: 150px; width: 500px; z-index: 3; }
    h1 { font-size: 64px; margin-bottom: 24px; }
    ul { list-style: none; padding: 0; margin-top: 34px; display: grid; gap: 16px; }
    li { display: flex; gap: 14px; align-items: flex-start; font: 500 19px/1.4 'InterV'; color: var(--muted); }
    li b { color: var(--cream); font-weight: 650; display: block; font-size: 20px; }
    li .ic { flex: none; width: 34px; height: 34px; border-radius: 10px; background: var(--lime); color: var(--ink); display: grid; place-items: center; }
    li .ic svg { width: 20px; height: 20px; }
    .card { position: absolute; left: 600px; top: 150px; width: 400px; border-radius: 14px; overflow: hidden; z-index: 1; transform: rotate(-3deg);
      box-shadow: 0 40px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.1); }
    .card img { display: block; width: 100%; }
    .l1 { position: absolute; left: 606px; top: 112px; } .l2 { position: absolute; left: 896px; top: 112px; }`,
  `${brand(64, 56)}
    <div class="copy">
      <div class="kicker">Conversion that holds up</div>
      <h1>Tables, code &amp; math come through <em>intact.</em></h1>
      <ul>
        <li><span class="ic">${ICONS.check}</span><span><b>GitHub-flavored tables</b>Rows and columns stay a real table.</span></li>
        <li><span class="ic">${ICONS.check}</span><span><b>MathML &amp; MathJax → LaTeX</b>Real <span style="font-family:var(--mono)">$$…$$</span>, not mangled symbols.</span></li>
        <li><span class="ic">${ICONS.check}</span><span><b>Code keeps its language</b>Line breaks and indentation preserved.</span></li>
      </ul>
    </div>
    <div class="label l1">On the page</div><div class="label l2">In MarkSnip · dark mode</div>
    <div class="card"><img src="${img.pageDetail}"></div>
    <img class="shot" src="${img.popupDark}" style="left:890px;top:146px;width:346px">`);

  // 3 — Reader View + Highlights
  S['03-reader-highlights'] = page(1280, 800, `
    .copy { position: absolute; left: 64px; top: 168px; width: 390px; z-index: 3; }
    h1 { font-size: 58px; margin-bottom: 24px; }
    .chips { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 30px; }
    .mgr { position: absolute; left: 500px; top: 492px; width: 540px; height: 268px; border-radius: 14px; overflow: hidden; z-index: 3;
      box-shadow: 0 40px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.12); background: #fff; }
    .mgr img { width: 760px; display: block; margin: -2px 0 0 -4px; }`,
  `${brand(64, 56)}
    <div class="copy">
      <div class="kicker">Reader View · Highlighter</div>
      <h1>Read it clean.<br>Keep what<br><em>matters.</em></h1>
      <p class="sub">A distraction-free reader with an outline and footnotes. Your highlights follow you into the clip.</p>
      <div class="chips"><span class="chip">${ICONS.check}Overlay or its own tab</span><span class="chip">${ICONS.check}Text size, width, theme &amp; font</span></div>
    </div>
    ${browser({ x: 470, y: 64, w: 770, img: img.reader, url: 'MarkSnip Reader · Why plain text outlives every app', ext: false })}
    <div class="mgr"><img src="${img.highlights}"></div>`);

  // 4 — Batch
  S['04-batch-processing'] = page(1280, 800, `
    .copy { position: absolute; left: 560px; top: 150px; width: 660px; z-index: 3; }
    h1 { font-size: 76px; margin-bottom: 24px; }
    .outs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 40px; }
    .out { border-radius: 16px; padding: 18px; background: rgba(244,239,227,.05); box-shadow: inset 0 0 0 1.5px rgba(185,228,108,.22); }
    .out .ic { width: 42px; height: 42px; border-radius: 12px; background: var(--lime); color: var(--ink); display: grid; place-items: center; margin-bottom: 14px; }
    .out .ic svg { width: 24px; height: 24px; }
    .out b { display: block; font-size: 20px; font-weight: 750; margin-bottom: 4px; }
    .out span { font: 500 15px/1.4 'InterV'; color: var(--muted); }
    .glow { position: absolute; left: 60px; top: 120px; width: 420px; height: 620px; border-radius: 50%; background: rgba(185,228,108,.14); filter: blur(70px); }`,
  `${brand(64, 56)}
    <div class="glow"></div>
    <img class="shot" src="${img.popupBatch}" style="left:100px;top:112px;width:370px">
    <div class="copy">
      <div class="kicker">Batch · Click &amp; Clip</div>
      <h1>Clip one page,<br>or <em>fifty.</em></h1>
      <p class="sub">Paste a list of URLs, pick links straight off the page, or let <b>Click &amp; Clip</b> step through tabs, accordions and load-more buttons for you.</p>
      <div class="outs">
        <div class="out"><div class="ic">${ICONS.zip}</div><b>One ZIP</b><span>Every page, one download</span></div>
        <div class="out"><div class="ic">${ICONS.files}</div><b>Separate files</b><span>One .md per page</span></div>
        <div class="out"><div class="ic">${ICONS.doc}</div><b>Combined doc</b><span>All pages in one file</span></div>
      </div>
    </div>`);

  // 5 — Destinations
  const dests = [
    ['download', 'Download .md', 'Or .txt, .html, PDF'], ['clipboard', 'Clipboard', 'Paste anywhere'], ['gem', 'Obsidian', 'Straight into your vault'],
    ['braces', 'Webhooks', 'POST to your own endpoint'], ['terminal', 'Agent Bridge CLI', '$ marksnip clip --json'], ['books', 'Library', 'Saved clips, in the browser'],
    ['spark', 'AI assistants', 'ChatGPT, Claude, Perplexity'],
  ];
  const cx = 640, cy = 478, rx = 440, ry = 212;
  const nodes = dests.map(([icon, title, sub], i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / dests.length);
    return { icon, title, sub, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const beams = nodes.map((n) => {
    const mx = (cx + n.x) / 2, my = (cy + n.y) / 2, dx = n.x - cx, dy = n.y - cy, L = Math.hypot(dx, dy);
    const c = [mx - dy / L * 60, my + dx / L * 60];
    return `<path d="M${cx} ${cy} Q${c[0]} ${c[1]} ${n.x} ${n.y}"/>`;
  }).join('');
  S['05-send-anywhere'] = page(1280, 800, `
    .head { position: absolute; top: 112px; left: 0; right: 0; text-align: center; z-index: 3; }
    h1 { font-size: 66px; }
    svg.beams { position: absolute; inset: 0; z-index: 1; }
    svg.beams path { fill: none; stroke: rgba(185,228,108,.5); stroke-width: 2.5; stroke-dasharray: 3 12; stroke-linecap: round; }
    .doc { position: absolute; left: ${cx - 105}px; top: ${cy - 118}px; width: 210px; height: 236px; border-radius: 22px; background: var(--cream); z-index: 2;
      box-shadow: 0 0 70px rgba(185,228,108,.28), 0 40px 80px rgba(0,0,0,.6); padding: 22px; color: var(--ink); }
    .doc .bar { width: 84px; height: 12px; border-radius: 6px; background: var(--lime); }
    .doc .hash { position: absolute; right: 18px; top: 16px; width: 34px; height: 34px; border-radius: 9px; background: var(--ink); color: var(--lime);
      font: 900 22px 'DMS'; display: grid; place-items: center; }
    .doc .md { font-weight: 900; font-size: 92px; letter-spacing: -4px; line-height: 1; margin-top: 20px; }
    .doc .ln { height: 9px; border-radius: 5px; background: rgba(20,26,18,.2); margin-top: 12px; }
    .node { position: absolute; transform: translate(-50%, -50%); z-index: 3; display: flex; align-items: center; gap: 12px; padding: 10px 18px 10px 10px;
      border-radius: 20px; background: #132414; box-shadow: 0 0 0 1.5px rgba(185,228,108,.35), 0 18px 36px rgba(0,0,0,.5); white-space: nowrap; }
    .node .ic { width: 44px; height: 44px; border-radius: 13px; background: var(--lime); color: var(--ink); display: grid; place-items: center; flex: none; }
    .node .ic svg { width: 24px; height: 24px; }
    .node b { display: block; font-size: 19px; font-weight: 750; }
    .node span { font: 500 13.5px 'InterV'; color: var(--muted); }
    .trust { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 12px;
      font: 500 17px 'InterV'; color: var(--muted); white-space: nowrap; }
    .trust svg { width: 20px; height: 20px; color: var(--lime); }
    .trust b { color: var(--cream); font-weight: 600; }`,
  `${brand(64, 56)}
    <div class="head"><h1>Clip once. <em>Send it anywhere.</em></h1></div>
    <svg class="beams" viewBox="0 0 1280 800">${beams}</svg>
    <div class="doc"><div class="bar"></div><div class="hash">#</div><div class="md">MD</div><div class="ln"></div><div class="ln" style="width:70%"></div></div>
    ${nodes.map((n) => `<div class="node" style="left:${n.x}px;top:${n.y}px"><div class="ic">${ICONS[n.icon]}</div><div><b>${n.title}</b><span>${n.sub}</span></div></div>`).join('')}
    <div class="trust">${ICONS.lock}<span><b>Converts inside your browser.</b> Nothing leaves your machine unless you send it.</span></div>`);

  // Marquee 1400x560
  S['promo-marquee'] = page(1400, 560, `
    .copy { position: absolute; left: 72px; top: 150px; width: 610px; z-index: 3; }
    h1 { font-size: 76px; margin-bottom: 22px; letter-spacing: -2.8px; }
    .sub { font-size: 21px; }
    .brand { font-size: 30px; } .brand .mark { width: 58px; height: 38px; }`,
  `${brand(72, 60)}
    <div class="copy">
      <h1>Any page.<br><em>Clean Markdown.</em></h1>
      <p class="sub">Clip articles, docs and threads into Markdown for your notes, Obsidian or AI workflows.</p>
    </div>
    ${browser({ x: 690, y: 132, w: 500, img: img.page, url: 'thelonghand.example/why-plain-text…', clutter: [shots.clutter[0], shots.clutter[3]] })}
    <img class="shot" src="${img.popupLight}" style="left:1064px;top:40px;width:288px">`);

  // Small tile 440x280
  S['promo-small-tile'] = page(440, 280, `
    .brand { font-size: 21px; gap: 10px; } .brand .mark { width: 40px; height: 26px; }
    h1 { position: absolute; left: 30px; top: 92px; font-size: 50px; letter-spacing: -1.8px; line-height: .98; z-index: 3; }
    .doc { position: absolute; right: -26px; top: 58px; width: 150px; height: 176px; border-radius: 18px; background: var(--cream); transform: rotate(8deg);
      box-shadow: 0 30px 50px rgba(0,0,0,.6); padding: 16px; color: var(--ink); z-index: 2; }
    .doc .bar { width: 60px; height: 9px; border-radius: 5px; background: var(--lime); }
    .doc .md { font-weight: 900; font-size: 64px; letter-spacing: -3px; line-height: 1; margin-top: 14px; }
    .doc .ln { height: 7px; border-radius: 4px; background: rgba(20,26,18,.2); margin-top: 9px; }
    .line { position: absolute; left: 30px; bottom: 30px; width: 150px; height: 5px; border-radius: 3px; background: var(--lime); z-index: 3; }`,
  `${brand(30, 28)}
    <h1>Web to<br><em>Markdown</em></h1>
    <div class="doc"><div class="bar"></div><div class="md">MD</div><div class="ln"></div><div class="ln" style="width:65%"></div></div>
    <div class="line"></div>`);

  return S;
}

async function compose(shots) {
  fs.mkdirSync(OUT, { recursive: true });
  const html = slides(shots);
  const browserInstance = await chromium.launch();
  try {
    for (const [name, markup] of Object.entries(html)) {
      const size = name === 'promo-marquee' ? [1400, 560] : name === 'promo-small-tile' ? [440, 280] : [1280, 800];
      const p = await browserInstance.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
      await p.setContent(markup, { waitUntil: 'load' });
      await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
      if (RAW_DIR) fs.writeFileSync(path.join(RAW_DIR, `${name}.html`), markup);
      await p.close();
      console.log(`wrote docs/store-screenshots/${name}.png`);
    }
  } finally {
    await browserInstance.close();
  }
}

(async () => {
  const shots = await capture();
  await compose(shots);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
