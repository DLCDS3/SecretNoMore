import { loadPlaywright } from './runtime.mjs';

// Inspect a public product in a fresh session. Never log in or modify a cart.
const url = new URL(process.argv[2]);
if (url.origin !== 'https://secretlair.wizards.com' || !/\/product\/\d+\//.test(url.pathname)) throw new Error('Supply a Secret Lair product URL.');
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('h1').first().waitFor({ timeout: 5000 }).catch(() => {});
  const details = await page.evaluate(() => {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim();
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    return {
      title: document.title,
      headings: [...document.querySelectorAll('h1')].map(el => clean(el.innerText)),
      controls: [...document.querySelectorAll('a,button,[role=button],input,select')].map(el => ({
        tag: el.tagName, text: clean(el.innerText || el.getAttribute('aria-label')),
        id: el.id, name: el.getAttribute('name'), type: el.getAttribute('type'),
        visible: visible(el), html: el.outerHTML.slice(0, 500)
      })).filter(el => /cart|sign in|log in|foil/i.test(el.text) || el.tag === 'SELECT').slice(0, 30)
    };
  });
  // Omit query strings because authentication/queue URLs can contain session state.
  const current = new URL(page.url());
  console.log(JSON.stringify({ status: response?.status(), origin: current.origin, path: current.pathname, ...details }, null, 2));
} finally { await browser.close(); }
