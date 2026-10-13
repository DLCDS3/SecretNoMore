import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../automation/runtime.mjs';
import { loginAndCart, validateAutomation, validateProduct } from '../automation/flow.mjs';

const config = JSON.parse(await fs.readFile(new URL('../automation.example.json', import.meta.url), 'utf8'));
const realPurchase = JSON.parse(await fs.readFile(new URL('../purchase.example.json', import.meta.url), 'utf8'));
let browser, server, origin, temp;
const counters = { logins: 0, adds: 0, checkouts: 0 };
const events = [];
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const title = 'Secret Lair x Marvel: True Believers in Love Foil Edition';
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-lair-flow-'));
  server = http.createServer(async (req, res) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1))]; }));
    const html = content => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); };
    const redirect = (url, cookie) => { res.writeHead(302, { Location: url, ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(); };
    const readForm = async () => { let body = ''; for await (const chunk of req) body += chunk; return new URLSearchParams(body); };
    if (req.url === '/us') {
      if (!cookies.session && cookies.scenario === 'trusted-auth') return redirect(`${origin.replace('127.0.0.1', 'localhost')}/login`);
      if (!cookies.session && cookies.scenario === 'provider-newsletter') return html(`<input id="newsletter" type="email" name="email"><a href="${origin.replace('127.0.0.1', 'localhost')}/login" target="_blank">Log In</a>`);
      return html(cookies.session ? `<span>${escape(cookies.session)}</span>` : cookies.scenario === 'span-login' ? '<span onclick="location.href=\'/login\'">SIGN IN</span>' : '<a href="/login">Log In</a>');
    }
    if (req.url === '/login') {
      if (cookies.scenario === 'foreign') return redirect(`${origin.replace('127.0.0.1', 'localhost')}/foreign`);
      if (cookies.scenario === 'two-step') return html('<form method="post" action="/email"><input type="email" name="email"><button>Continue</button></form>');
      if (cookies.scenario === 'label-form') return html('<form method="post" action="/session"><label for="contact-field">Email address *</label><input id="contact-field" name="identifier"><label for="access-field">Password *</label><input id="access-field" name="access-code"><button>Sign In</button></form>');
      return html('<form method="post" action="/session"><input type="email" name="email"><input type="password" name="password"><button>Sign In</button></form>');
    }
    if (req.url === '/modal-login') { events.push('modal-login'); return redirect('/login'); }
    if (req.url === '/embedded-cart-login') return html('<h2>You\'re Almost There!</h2><a href="/modal-login"><span aria-hidden="true">\u263a</span><span>LOG IN</span> / <span>SIGN UP</span></a><a href="/checkout">CONTINUE AS GUEST</a>');
    if (req.url === '/header-login') { events.push('header-login'); return html('Wrong login control'); }
    if (req.url === '/foreign') return html('<form action="/session"><input type="email"><input type="password"><button>Sign In</button></form>');
    if (req.url === '/email') {
      const form = await readForm();
      res.setHeader('Set-Cookie', `email=${encodeURIComponent(form.get('email'))}; Path=/`);
      return html('<form method="post" action="/session"><input type="password" name="password"><button>Sign In</button></form>');
    }
    if (req.url === '/session') {
      counters.logins++;
      events.push('login');
      const form = await readForm();
      if ((form.get('password') || form.get('access-code')) !== 'synthetic-test-password') return html('<p>Invalid password</p>');
      const email = form.get('email') || form.get('identifier') || cookies.email;
      if (req.headers.host.startsWith('localhost:')) return redirect(`${origin}/auth-return?email=${encodeURIComponent(email)}`);
      return redirect(cookies.returnCart ? '/cart' : '/us', `session=${encodeURIComponent(email)}; Path=/`);
    }
    if (req.url.startsWith('/auth-return?')) return redirect('/us', `session=${encodeURIComponent(new URL(req.url, origin).searchParams.get('email'))}; Path=/`);
    if (req.url.startsWith('/us/product/1252788/')) {
      const heading = cookies.scenario === 'wrong-product' ? 'Wrong Product' : cookies.scenario === 'uppercase-title' ? title.toUpperCase() : title;
      const button = '<button type="submit">Add to cart</button>';
      const modalScenario = ['cart-modal', 'cart-modal-popup', 'cart-modal-frame', 'cart-modal-untrusted-frame'].includes(cookies.scenario);
      const viewScenario = modalScenario || ['view-cart', 'missing-view-cart', 'ambiguous-view-cart', 'cart-first'].includes(cookies.scenario);
      const viewLink = modalScenario ? '<a href="#" id="modal-cart">PROCEED TO CART</a>' : `<a href="/cart">${cookies.scenario === 'cart-first' ? 'PROCEED TO CART' : 'View Cart'}</a>`;
      const followup = cookies.scenario === 'missing-view-cart' ? '<p>Added</p>' : viewLink + (cookies.scenario === 'ambiguous-view-cart' ? viewLink : '');
      const modalHtml = cookies.scenario === 'cart-modal-frame' ? '<iframe title="Cart login" src="/embedded-cart-login"></iframe>' : cookies.scenario === 'cart-modal-untrusted-frame' ? `<iframe title="Cart login" src="${origin.replace('127.0.0.1', 'localhost')}/embedded-cart-login"></iframe>` : `<h2>You're Almost There!</h2><a href="/modal-login" ${cookies.scenario === 'cart-modal-popup' ? 'target="_blank"' : ''}>LOG IN / SIGN UP</a><a href="/checkout">CONTINUE AS GUEST</a>`;
      const modalScript = modalScenario ? `document.addEventListener('click', event => { if (event.target.closest('#modal-cart')) { event.preventDefault(); document.cookie='returnCart=1; Path=/'; document.getElementById('followup').innerHTML=${JSON.stringify(modalHtml)}; } if (event.target.closest('#existing-cart')) { event.preventDefault(); document.getElementById('followup').innerHTML=${JSON.stringify(followup)}; } });` : '';
      const script = viewScenario ? `<div id="followup"></div><script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); fetch('/add', {method:'POST'}).then(() => document.getElementById('followup').innerHTML = ${JSON.stringify(followup)}); });${modalScript}</script>` : '';
      const header = modalScenario ? '<a href="/header-login">SIGN IN</a><a href="#" id="existing-cart">YOUR CART (1)</a>' : '';
      return html(`${header}<h1>${heading}</h1><form action="/add" method="post"><input name="quantity" value="1">${button}${cookies.scenario === 'ambiguous' ? button : ''}</form>${script}`);
    }
    if (req.url === '/add') {
      counters.adds++;
      events.push('add');
      if (['view-cart', 'missing-view-cart', 'ambiguous-view-cart', 'cart-first', 'cart-modal', 'cart-modal-popup', 'cart-modal-frame', 'cart-modal-untrusted-frame'].includes(cookies.scenario)) return html('Added');
      return redirect('/queue');
    }
    if (req.url === '/queue') return html('<h1>Queue: wait here</h1><a href="/checkout">Continue</a>');
    if (req.url === '/cart') {
      if (!cookies.session && cookies.scenario === 'cart-first') return redirect('/login', 'returnCart=1; Path=/');
      return html(`<h1>Your Cart</h1>${cookies.session ? `<span>${escape(cookies.session)}</span>` : ''}<a href="/checkout">Checkout</a>`);
    }
    if (req.url === '/checkout') { counters.checkouts++; return html('Checkout'); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});
async function fixture(id, scenario, session) {
  const context = await browser.newContext();
  if (scenario) await context.addCookies([{ name: 'scenario', value: scenario, url: origin }]);
  if (session) await context.addCookies([{ name: 'session', value: session, url: origin }]);
  const page = await context.newPage();
  const account = { id, email: `${id}@example.com` };
  const options = {
    context, page, account, password: 'synthetic-test-password',
    purchase: { ...realPurchase, expectedTitle: title, productUrl: `${origin}/us/product/1252788/test-foil-edition` },
    config: { ...config, loginOrder: 'login-first', timeoutSeconds: 1 },
    attemptDir: path.join(temp, 'attempts'), policy: { storeOrigin: origin, loginOrigins: [origin] }
  };
  return { context, page, options };
}
test('production configuration rejects mismatched product IDs and unsafe login origins', () => {
  validateAutomation(config); validateProduct(realPurchase);
  assert.throws(() => validateProduct({ ...realPurchase, expectedProductId: '1252789' }));
  assert.throws(() => validateAutomation({ ...config, loginOrigins: ['http://myaccounts.wizards.com'] }));
});
test('logs in, adds once, leaves queue untouched, and blocks repeat before navigation', async () => {
  const f = await fixture('success');
  try {
    const before = { ...counters };
    const result = await loginAndCart(f.options);
    assert.equal(result.status, 'cart-attempted-manual');
    await f.page.waitForURL(`${origin}/queue`);
    assert.equal(counters.logins - before.logins, 1);
    assert.equal(counters.adds - before.adds, 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(counters.checkouts - before.checkouts, 0);
    const repeat = await loginAndCart(f.options);
    assert.equal(repeat.reason, 'previous-cart-attempt-needs-review');
    assert.equal(f.page.url(), `${origin}/queue`);
    assert.equal(counters.adds - before.adds, 1);
  } finally { await f.context.close(); }
});
test('handles an email-first password-second login', async () => {
  const f = await fixture('two-step', 'two-step');
  try { assert.equal((await loginAndCart({ ...f.options, loginOnly: true })).status, 'logged-in-manual'); }
  finally { await f.context.close(); }
});
test('handles a visible SIGN IN control without button or link semantics', async () => {
  const f = await fixture('span', 'span-login');
  try { assert.equal((await loginAndCart({ ...f.options, loginOnly: true })).status, 'logged-in-manual'); }
  finally { await f.context.close(); }
});
test('login fields can be matched by Email address and Password labels without standard attributes', async () => {
  const f = await fixture('labels', 'label-form');
  try { assert.equal((await loginAndCart({ ...f.options, loginOnly: true })).status, 'logged-in-manual'); }
  finally { await f.context.close(); }
});
test('provider login popup is preferred over the storefront newsletter email input', async () => {
  const f = await fixture('newsletter', 'provider-newsletter');
  f.options.policy.loginOrigins.push(origin.replace('127.0.0.1', 'localhost'));
  try {
    assert.equal((await loginAndCart({ ...f.options, loginOnly: true })).status, 'logged-in-manual');
    assert.equal(await f.page.locator('#newsletter').inputValue(), '');
  } finally { await f.context.close(); }
});
test('missing login field diagnostics exclude input values and passwords', async () => {
  const f = await fixture('field-diagnostic');
  const reports = [];
  f.options.config.selectors = { ...config.selectors, email: { css: 'input.no-such-email-field' } };
  try {
    const result = await loginAndCart({ ...f.options, loginOnly: true, report: (status, reason) => reports.push({ status, reason }) });
    assert.equal(result.status, 'manual-intervention');
    assert.ok(reports.some(r => r.status === 'login-field-diagnostic' && r.reason.includes('email')));
    assert.ok(!JSON.stringify(reports).includes(f.options.password));
    assert.ok(!JSON.stringify(reports).includes(f.options.account.email));
  } finally { await f.context.close(); }
});
test('handles a direct redirect to a separately allowed login origin', async () => {
  const f = await fixture('trusted', 'trusted-auth');
  f.options.policy.loginOrigins.push(origin.replace('127.0.0.1', 'localhost'));
  try { assert.equal((await loginAndCart({ ...f.options, loginOnly: true })).status, 'logged-in-manual'); }
  finally { await f.context.close(); }
});
test('adds once, clicks View Cart, and stops without checkout', async () => {
  const f = await fixture('viewcart', 'view-cart');
  try {
    const before = { ...counters };
    const result = await loginAndCart(f.options);
    assert.equal(result.status, 'view-cart-attempted-manual');
    await f.page.waitForURL(`${origin}/cart`);
    assert.equal(counters.adds - before.adds, 1);
    assert.equal(counters.checkouts - before.checkouts, 0);
  } finally { await f.context.close(); }
});
test('cart-first adds before logging in, handles PROCEED TO CART, and never submits checkout', async () => {
  const f = await fixture('cartfirst', 'cart-first');
  f.options.config.loginOrder = 'cart-first';
  try {
    const start = events.length;
    const before = { ...counters };
    assert.equal((await loginAndCart(f.options)).status, 'cart-login-completed-manual');
    assert.deepEqual(events.slice(start), ['add', 'login']);
    assert.equal(f.page.url(), `${origin}/cart`);
    assert.equal(counters.adds - before.adds, 1);
    assert.equal(counters.checkouts - before.checkouts, 0);
  } finally { await f.context.close(); }
});
test('product title capitalization does not block the matching product', async () => {
  const f = await fixture('uppercase', 'uppercase-title');
  try { assert.equal((await loginAndCart(f.options)).status, 'cart-attempted-manual'); }
  finally { await f.context.close(); }
});
test('same-URL cart prompt completes login in-page, in a popup, or in a frame with icon/split labels', async () => {
  for (const scenario of ['cart-modal', 'cart-modal-popup', 'cart-modal-frame']) {
    const f = await fixture(scenario, scenario);
    f.options.config.loginOrder = 'cart-first';
    try {
      const start = events.length;
      const checkoutBefore = counters.checkouts;
      assert.equal((await loginAndCart(f.options)).status, 'cart-login-completed-manual');
      assert.deepEqual(events.slice(start), ['add', 'modal-login', 'login']);
      assert.equal(counters.checkouts, checkoutBefore);
    } finally { await f.context.close(); }
  }
});
test('unknown cart frame origin is diagnosed without clicking login or entering credentials', async () => {
  const f = await fixture('unknown-frame', 'cart-modal-untrusted-frame');
  f.options.config.loginOrder = 'cart-first';
  const reports = [];
  try {
    const before = counters.logins;
    const result = await loginAndCart({ ...f.options, report: (status, reason) => reports.push({ status, reason }) });
    assert.equal(result.status, 'cart-followup-needed-manual');
    assert.equal(counters.logins, before);
    assert.ok(reports.some(r => r.status === 'cart-login-diagnostic' && r.reason.includes('localhost') && r.reason.includes('LOG IN')));
  } finally { await f.context.close(); }
});
test('ResumeCart finishes cart-prompt login without adding again or resetting the attempt marker', async () => {
  const f = await fixture('resume-modal', 'cart-modal');
  f.options.config.loginOrder = 'cart-first';
  await fs.mkdir(f.options.attemptDir, { recursive: true });
  const marker = path.join(f.options.attemptDir, `${f.options.account.id}-${f.options.purchase.expectedProductId}.json`);
  await fs.writeFile(marker, 'existing-attempt');
  try {
    const before = { ...counters };
    assert.equal((await loginAndCart({ ...f.options, resumeCart: true })).status, 'cart-login-completed-manual');
    assert.equal(counters.adds, before.adds);
    assert.equal(counters.checkouts, before.checkouts);
    assert.equal(await fs.readFile(marker, 'utf8'), 'existing-attempt');
  } finally { await f.context.close(); }
});
test('missing or ambiguous View Cart pauses without re-adding or checking out', async () => {
  for (const scenario of ['missing-view-cart', 'ambiguous-view-cart']) {
    const f = await fixture(scenario, scenario);
    try {
      const before = { ...counters };
      const result = await loginAndCart(f.options);
      assert.equal(result.status, 'cart-followup-needed-manual');
      assert.equal(counters.adds - before.adds, 1);
      assert.equal(counters.checkouts - before.checkouts, 0);
    } finally { await f.context.close(); }
  }
});
test('does not use a session signed into a different account', async () => {
  const f = await fixture('expected', null, 'different@example.com');
  try {
    const before = { ...counters };
    assert.equal((await loginAndCart(f.options)).status, 'manual-intervention');
    assert.deepEqual(counters, before);
  } finally { await f.context.close(); }
});
test('does not fill credentials on an unrecognized redirect origin', async () => {
  const f = await fixture('foreign', 'foreign');
  try {
    const before = { ...counters };
    assert.equal((await loginAndCart(f.options)).status, 'manual-intervention');
    assert.equal(await f.page.locator('input[type=password]').inputValue(), '');
    assert.deepEqual(counters, before);
  } finally { await f.context.close(); }
});
test('wrong product title and multiple cart controls pause without a cart click', async () => {
  for (const scenario of ['wrong-product', 'ambiguous']) {
    const f = await fixture(scenario, scenario);
    try {
      const addsBefore = counters.adds;
      const result = await loginAndCart(f.options);
      assert.equal(result.status, 'manual-intervention');
      assert.equal(result.reason, scenario === 'ambiguous' ? 'ambiguous-controls' : 'product-title-mismatch');
      assert.equal(counters.adds, addsBefore);
    } finally { await f.context.close(); }
  }
});
test('two accounts operate concurrently with isolated sessions', async () => {
  const fixtures = await Promise.all(['parallel01', 'parallel02'].map(id => fixture(id)));
  try {
    const results = await Promise.all(fixtures.map(f => loginAndCart({ ...f.options, loginOnly: true })));
    assert.ok(results.every(result => result.status === 'logged-in-manual'));
    for (const f of fixtures) assert.equal(await f.page.getByText(f.options.account.email, { exact: true }).count(), 1);
  } finally { await Promise.all(fixtures.map(f => f.context.close())); }
});
