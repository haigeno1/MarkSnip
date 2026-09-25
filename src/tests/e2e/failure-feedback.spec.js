/**
 * Real-browser checks for failures the user must see or recover from:
 * a conversion error reaching the popup, notification cards not blocking each
 * other, and page highlights landing on the right text in Reader View.
 */

const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const extensionPath = path.join(__dirname, '../..');
const fixtureHost = 'https://fixtures.marksnip.test';
const sentence = (text, count) => Array.from({ length: count }, () => text).join(' ');
const articlePage = `<!doctype html><html><head><title>Fixture article</title></head><body>
<article><h1>Fixture article</h1>
<p>${sentence('An opening paragraph with enough ordinary words for Readability to keep it.', 6)}</p>
<p>${sentence('A second paragraph continues the article with more ordinary prose.', 6)}</p>
<p id="p3">Near the end sits the unique marker phrase that was highlighted on the page. ${sentence('Trailing words keep this paragraph long.', 3)}</p>
</article></body></html>`;

test.describe('Failure feedback', () => {
  let context;
  let serviceWorker;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${fixtureHost}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: articlePage
    }));

    [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    }
    extensionId = new URL(serviceWorker.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const tabIdFor = (url) => serviceWorker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);

  test('a conversion error replaces the popup spinner with the error', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForTimeout(1500);
    await popup.evaluate(async () => {
      setEditorValue('');
      document.getElementById('spinner').style.display = 'block';
      await browser.runtime.sendMessage({ type: 'clip', dom: null, selection: '', clipSelection: false, pageUrl: 'https://fixtures.marksnip.test/a' });
    });

    await expect(popup.locator('#spinner')).toBeHidden({ timeout: 8000 });
    await expect.poll(() => popup.evaluate(() => getEditorValue())).toContain('Invalid DOM string provided');
    await popup.close();
  });

  test('following a notification card\'s link dismisses it, and an ignored card does not block new ones', async () => {
    const card = (id, type, title, showCount) => ({
      id, type, title, message: `${title} body`, createdAt: Date.now(), showCount,
      primaryAction: { label: 'Open', url: `${fixtureHost}/linked` }
    });

    const page = await context.newPage();
    await page.goto(`${fixtureHost}/notify`);
    const tabId = await tabIdFor(`${fixtureHost}/notify`);
    await serviceWorker.evaluate(async (pending) => {
      await chrome.storage.local.set({ pendingNotifications: pending });
    }, [card('version-update:9.9.9', 'version-update', 'Ignored update card', 1), card('support-milestone:50', 'support-milestone', 'Fresh milestone card', 0)]);

    await serviceWorker.evaluate((id) => recordNotificationMetrics({ copies: 1, exports: 0 }, { tabId: id }), tabId);
    const action = page.locator('a.action-primary');
    await expect(page.getByText('Fresh milestone card', { exact: true })).toBeVisible({ timeout: 8000 });

    await action.click();
    await expect.poll(() => serviceWorker.evaluate(async () =>
      (await chrome.storage.local.get('pendingNotifications')).pendingNotifications.map(n => n.id)
    )).toEqual(['version-update:9.9.9']);
    await page.close();
  });

  test('a page highlight appears on the matching text in the Reader View tab', async () => {
    const url = `${fixtureHost}/reader`;
    await serviceWorker.evaluate(async (pageUrl) => {
      await globalThis.markSnipHighlightState.savePageRecord({
        url: pageUrl,
        highlights: [{ type: 'text', xpath: '/html[1]/body[1]/article[1]/p[3]', startOffset: 22, endOffset: 42, text: 'unique marker phrase', color: 'green' }]
      }, chrome.storage.local);
    }, url);
    const page = await context.newPage();
    await page.goto(url);
    const tabId = await tabIdFor(url);

    const readerOpened = context.waitForEvent('page', (p) => p.url().includes('/reader/reader.html'));
    await serviceWorker.evaluate(async (id) => openReaderTabForTab(await chrome.tabs.get(id)), tabId);
    const reader = await readerOpened;
    await reader.waitForLoadState();

    await expect.poll(() => reader.evaluate(() => {
      const texts = [];
      for (const [, highlight] of (CSS.highlights || new Map())) for (const range of highlight) texts.push(range.toString());
      return texts;
    }), { timeout: 8000 }).toEqual(['unique marker phrase']);
    await reader.close();
    await page.close();
  });
});
