/**
 * Saved highlights are rendered on every visit, even while the highlighter is
 * off. A highlight that covers a link must not swallow the page's own click,
 * while a highlight on plain text should still open the highlight menu.
 */

const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const extensionPath = path.join(__dirname, '../..');
const fixtureHost = 'https://fixtures.marksnip.test';
const fixturePage = `<!doctype html><html><head><title>Fixture</title></head><body>
<h1>Highlight fixture</h1>
<p>See <a id="lnk" href="${fixtureHost}/target.html">the docs</a> here.</p>
<p>Plain paragraph for control.</p>
</body></html>`;

test.describe('Saved highlights with the highlighter off', () => {
  let context;
  let serviceWorker;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${fixtureHost}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: pathname === '/target.html' ? '<h1>Target page</h1>' : fixturePage
      });
    });

    [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }

    await serviceWorker.evaluate(async (url) => {
      await chrome.storage.local.clear();
      await globalThis.markSnipHighlightState.savePageRecord({
        url,
        highlights: [
          { type: 'text', xpath: '/html[1]/body[1]/p[1]', startOffset: 4, endOffset: 12, text: 'the docs', color: 'yellow' },
          { type: 'text', xpath: '/html[1]/body[1]/p[2]', startOffset: 0, endOffset: 5, text: 'Plain', color: 'green' }
        ]
      }, chrome.storage.local);
    }, `${fixtureHost}/page.html`);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  async function openHighlightedPage() {
    const page = await context.newPage();
    await page.goto(`${fixtureHost}/page.html`);
    await page.waitForFunction(() => (globalThis.CSS?.highlights?.size || 0) > 0, null, { timeout: 8000 });
    return page;
  }

  test('clicking a highlighted link follows the link', async () => {
    const page = await openHighlightedPage();
    const box = await page.locator('#lnk').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page).toHaveURL(`${fixtureHost}/target.html`);
    await page.close();
  });

  test('clicking highlighted plain text still opens the highlight menu', async () => {
    const page = await openHighlightedPage();
    const point = await page.evaluate(() => {
      const textNode = document.querySelectorAll('p')[1].firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);

    await expect(page.locator('[data-marksnip-highlighter-ui]').first()).toBeAttached();
    await expect(page).toHaveURL(`${fixtureHost}/page.html`);
    await page.close();
  });
});
