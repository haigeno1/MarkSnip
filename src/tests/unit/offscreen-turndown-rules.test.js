/**
 * @jest-environment node
 *
 * Runs HTML through the REAL offscreen conversion pipeline (the same scripts,
 * in the same order, as offscreen.html) rather than a test-only Turndown copy.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const srcRoot = path.join(__dirname, '../..');

function loadOffscreenWindow() {
  const html = fs.readFileSync(path.join(srcRoot, 'offscreen/offscreen.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), m => m[1]);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'chrome-extension://test/offscreen/offscreen.html'
  });
  const win = dom.window;
  win.console = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
  win.eval(`window.browser = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}), getURL: p => p },
    storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}) } },
    i18n: { getMessage: () => '' }
  };`);
  for (const rel of scripts) {
    if (rel.includes('browser-polyfill')) continue;
    win.eval(fs.readFileSync(path.join(srcRoot, 'offscreen', rel), 'utf8'));
  }
  win.eval('initOffscreen()');
  return win;
}

describe('offscreen Turndown rules (real pipeline)', () => {
  let win;

  beforeAll(() => {
    win = loadOffscreenWindow();
  });

  afterAll(() => {
    win.close();
  });

  async function toMarkdown(bodyHtml, overrides = {}) {
    const options = Object.assign({}, win.eval('defaultOptions'), { downloadImages: false }, overrides);
    const article = {
      content: bodyHtml,
      baseURI: 'https://example.com/post/',
      pageURL: 'https://example.com/post/',
      title: 'T'
    };
    win.__article = article;
    win.__options = options;
    const result = await win.eval('convertArticleToMarkdown(window.__article, false, window.__options)');
    return result.markdown;
  }

  describe('fenced code blocks', () => {
    test('uses a longer fence when the code contains a ``` fence', async () => {
      const md = await toMarkdown('<pre><code class="language-md">Example:\n```js\nconsole.log(1)\n```\nDone.</code></pre>');
      expect(md).toBe('````md\nExample:\n```js\nconsole.log(1)\n```\nDone.\n````');
    });

    test('counts fences indented by up to three spaces', async () => {
      const md = await toMarkdown('<pre><code class="language-md">- item\n  ```\n  nested\n  ```\nafter</code></pre>');
      expect(md.startsWith('````md\n')).toBe(true);
      expect(md.endsWith('\n````')).toBe(true);
    });

    test('applies the same rule to the ~~~ fence option', async () => {
      const md = await toMarkdown('<pre><code class="language-md">~~~\nx\n~~~</code></pre>', { fence: '~~~' });
      expect(md).toBe('~~~~md\n~~~\nx\n~~~\n~~~~');
    });

    test('keeps a three-character fence for ordinary code', async () => {
      const md = await toMarkdown('<pre><code class="language-js">const a = 1;</code></pre>');
      expect(md).toBe('```js\nconst a = 1;\n```');
    });
  });

  describe('tables', () => {
    const rowsOf = md => md.split('\n').filter(line => line.startsWith('|'));
    const columnsIn = line => line.replace(/\\\|/g, '').split('|').length - 2;

    test('escapes pipes inside cells so they do not add columns', async () => {
      const md = await toMarkdown('<table><thead><tr><th>Op</th><th>Meaning</th></tr></thead><tbody><tr><td><code>a || b</code></td><td>x | y</td></tr></tbody></table>');
      const rows = rowsOf(md);
      expect(rows[2]).toContain('`a \\|\\| b`');
      expect(rows[2]).toContain('x \\| y');
      rows.forEach(row => expect(columnsIn(row)).toBe(2));
    });

    test('places a rowspan cell in its own column on the following row', async () => {
      const md = await toMarkdown('<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>a1</td><td rowspan="2">B-span</td><td>c1</td></tr><tr><td>a2</td><td>c2</td></tr></tbody></table>');
      const cells = rowsOf(md)[3].split('|').map(cell => cell.trim()).filter(Boolean);
      expect(cells).toEqual(['a2', 'B-span', 'c2']);
    });

    test('keeps multi-paragraph cells on one row', async () => {
      const md = await toMarkdown('<table><thead><tr><th>K</th><th>V</th></tr></thead><tbody><tr><td>k</td><td><p>one</p><p>two</p></td></tr></tbody></table>');
      const rows = rowsOf(md);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toContain('one<br>two');
    });

    test('pads the header when body rows have more cells', async () => {
      const md = await toMarkdown('<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
      rowsOf(md).forEach(row => expect(columnsIn(row)).toBe(2));
    });

    test('includes every tbody and the tfoot', async () => {
      const md = await toMarkdown('<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Apples</td><td>1</td></tr></tbody><tbody><tr><td>Pears</td><td>2</td></tr></tbody><tfoot><tr><td>Total</td><td>3</td></tr></tfoot></table>');
      expect(md).toContain('Apples');
      expect(md).toContain('Pears');
      expect(md).toContain('Total');
    });

    test('leaves an ordinary table unchanged', async () => {
      const md = await toMarkdown('<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td><b>Bold</b></td><td>2</td></tr></tbody></table>');
      expect(md).toBe('| Name | Qty |\n|------|-----|\n| **Bold** |  2  |');
    });
  });

  test('separates TeX control words from following letters in MathML', async () => {
    const md = await toMarkdown('<p>Eq: <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>α</mi><mi>x</mi></math></p>');
    expect(md).toBe('Eq: $\\alpha x$');
  });
});
