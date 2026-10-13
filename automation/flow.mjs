import fs from 'node:fs/promises';
import path from 'node:path';

export class ManualPause extends Error {
  constructor(code) { super(code); this.code = code; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function substitute(text, account) {
  return text.replaceAll('{email}', account.email).replaceAll('{loginLabel}', account.loginLabel || account.email);
}
function locate(surface, spec, account) {
  if (spec.css) return surface.locator(spec.css);
  if (spec.role) return surface.getByRole(spec.role, {
    ...(spec.namePattern ? { name: new RegExp(spec.namePattern, 'i') } : spec.name !== undefined ? { name: substitute(spec.name, account), exact: true } : {}),
    ...(spec.level ? { level: spec.level } : {})
  });
  if (spec.text) return surface.getByText(substitute(spec.text, account), { exact: spec.exact !== false });
  if (spec.textPattern) return surface.getByText(new RegExp(spec.textPattern, 'i'));
  if (spec.labelPattern) return surface.getByLabel(new RegExp(spec.labelPattern, 'i'));
  throw new ManualPause('selector-configuration-invalid');
}
async function uniqueVisible(surface, spec, account) {
  if (!spec) return null;
  const matches = [];
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const item of specs) {
    const locator = locate(surface, item, account);
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible()) matches.push(candidate);
    }
  }
  if (matches.length > 1) throw new ManualPause('ambiguous-controls');
  return matches[0] || null;
}
async function orderedVisible(surface, spec, account) {
  for (const alternative of Array.isArray(spec) ? spec : [spec]) {
    const field = await uniqueVisible(surface, alternative, account);
    if (field) return field;
  }
  return null;
}
function surfaceKey(surface) {
  try { const url = new URL(surface.url()); return url.origin + url.pathname; } catch { return surface.url(); }
}
async function findLoginField(context, spec, account, origins, storeOrigins, initialSurface, passwordSpec) {
  // Examine provider frames first; never fill a storefront newsletter field while
  // a popup login page is loading. Store-hosted login fixtures/forms must either
  // have a password field or be a new destination after the login entry click.
  for (const providerOnly of [true, false]) {
    for (const alternative of Array.isArray(spec) ? spec : [spec]) {
      const matches = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        for (const frame of candidate.frames()) {
          if (!originAllowed(frame, origins)) continue;
          const provider = !originAllowed(frame, storeOrigins);
          if (provider !== providerOnly) continue;
          if (!provider && initialSurface && surfaceKey(frame) === initialSurface && !await orderedVisible(frame, passwordSpec, account)) continue;
          const field = await uniqueVisible(frame, alternative, account);
          if (field) matches.push({ frame, field });
        }
      }
      if (matches.length > 1) throw new ManualPause('ambiguous-login-fields');
      if (matches.length) return matches[0];
    }
  }
  return null;
}
async function reportLoginFields(context, origins, report) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      try {
        const origin = new URL(frame.url()).origin;
        const inputs = await frame.locator('input').evaluateAll(elements => elements.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').slice(0, 12).map(el => ({
          type: el.type, id: el.id.slice(0, 100), name: el.name.slice(0, 100), autocomplete: el.autocomplete
        })));
        if (inputs.length || !origins.has(origin)) report('login-field-diagnostic', JSON.stringify({ origin, allowed: origins.has(origin), inputs }));
      } catch { /* Provider frame may be navigating. */ }
    }
  }
}
// Cart controls can be nested in a frame and have icons/split text. Try selector
// alternatives in order so role and text matches for the same control do not clash.
async function findCartEntry(context, spec, account, origins) {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const alternative of specs) {
    const matches = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        if (!originAllowed(frame, origins)) continue;
        const locator = await uniqueVisible(frame, alternative, account);
        if (locator) matches.push({ page, frame, locator });
      }
    }
    if (matches.length > 1) throw new ManualPause('ambiguous-controls');
    if (matches.length) return matches[0];
  }
  return null;
}
async function reportCartFrames(context, report) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      try {
        const origin = new URL(frame.url()).origin;
        const labels = await frame.locator('a,button,[role=button],[role=link]').evaluateAll(elements => elements
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .map(el => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(text => /log\s*in|sign\s*in|sign\s*up|proceed to cart|continue as guest/i.test(text))
          .map(text => text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)).slice(0, 8));
        if (labels.length) report('cart-login-diagnostic', JSON.stringify({ origin, labels }));
      } catch { /* A frame may detach while the cart transitions. */ }
    }
  }
}
function originAllowed(surface, origins) {
  try { return origins.has(new URL(surface.url()).origin); } catch { return false; }
}
function assertOrigin(surface, origins) {
  if (!originAllowed(surface, origins)) throw new ManualPause('unrecognized-login-origin');
}
async function waitFor(find, timeoutMs, signal) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    const value = await find();
    if (value) return value;
    await sleep(200);
  }
  throw new ManualPause('controls-or-login-not-confirmed');
}
export function validateAutomation(config) {
  if (!['login-first', 'cart-first'].includes(config.loginOrder ?? 'login-first')) throw new Error('loginOrder must be login-first or cart-first.');
  if (config.loginOrder === 'cart-first' && config.postCartAction !== 'view-cart') throw new Error('cart-first requires the view-cart action.');
  if (!['stop', 'view-cart'].includes(config.postCartAction ?? 'stop')) throw new Error('postCartAction must be stop or view-cart.');
  if (config.postCartAction === 'view-cart' && !config.selectors?.viewCart) throw new Error('A viewCart selector is required.');
  if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 5 || config.timeoutSeconds > 180) throw new Error('timeoutSeconds must be 5–180.');
  if (!Array.isArray(config.loginOrigins) || !config.loginOrigins.length) throw new Error('loginOrigins is required.');
  for (const value of config.loginOrigins) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw new Error('loginOrigins must contain exact HTTPS origins.');
  }
  const allowedRoles = new Set(['button', 'link', 'heading', 'textbox', 'combobox']);
  for (const key of ['signedInIdentity', 'loginEntry', 'email', 'password', 'emailNext', 'loginSubmit', 'productTitle', 'addToCart']) {
    if (!config.selectors?.[key]) throw new Error(`Missing selector ${key}.`);
  }
  for (const descriptor of Object.values(config.selectors)) {
    if (!descriptor) continue;
    for (const spec of Array.isArray(descriptor) ? descriptor : [descriptor]) {
      if (typeof spec !== 'object' || [spec.css, spec.role, spec.text, spec.textPattern, spec.labelPattern].filter(Boolean).length !== 1) throw new Error('Each selector must use exactly one of css, role, text, textPattern, or labelPattern.');
      if (spec.role && !allowedRoles.has(spec.role)) throw new Error('Unsupported selector role.');
      if (spec.namePattern) new RegExp(spec.namePattern, 'i');
      if (spec.textPattern) new RegExp(spec.textPattern, 'i');
      if (spec.labelPattern) new RegExp(spec.labelPattern, 'i');
    }
  }
}
export function validateProduct(purchase) {
  const url = new URL(purchase.productUrl);
  const match = url.pathname.match(/^\/us\/(?:en\/)?product\/(\d+)\/[^/]+\/?$/);
  if (url.origin !== 'https://secretlair.wizards.com' || !match || match[1] !== String(purchase.expectedProductId)) throw new Error('Product URL/ID mismatch.');
  if (!purchase.expectedTitle || !['Foil', 'Non-foil'].includes(purchase.expectedVariant)) throw new Error('Set an exact expectedTitle and Foil or Non-foil variant.');
  if (!Number.isInteger(purchase.quantityPerAccount) || purchase.quantityPerAccount < 1) throw new Error('Invalid quantity.');
}

// Policy can be injected by local tests. Production always uses the real store origin.
export async function loginAndCart({ context, page, account, password, purchase, config, attemptDir, loginOnly = false, report = () => {}, signal, policy, skipStoreNavigation = false, resumeCart = false }) {
  const storeOrigin = policy?.storeOrigin || 'https://secretlair.wizards.com';
  const origins = new Set([storeOrigin, ...(policy?.loginOrigins || config.loginOrigins)]);
  const storeOrigins = new Set([storeOrigin]);
  const timeout = config.timeoutSeconds * 1000;
  const selectors = config.selectors;
  let stage = 'opening-store';
  let attempted = false;
  let cartClickCompleted = false;
  const cartFirst = config.loginOrder === 'cart-first' && !loginOnly;
  try {
    signal?.throwIfAborted();
    if (!loginOnly && !resumeCart) {
      const previous = path.join(attemptDir, `${account.id}-${purchase.expectedProductId}.json`);
      try {
        await fs.access(previous);
        throw new ManualPause('previous-cart-attempt-needs-review');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!cartFirst) {
    report(stage);
    if (!skipStoreNavigation) await page.goto(`${storeOrigin}/us`, { waitUntil: 'domcontentloaded', timeout });
    const identity = async () => {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        for (const frame of candidate.frames()) {
          if (originAllowed(frame, storeOrigins) && await uniqueVisible(frame, selectors.signedInIdentity, account)) return candidate;
        }
      }
      return null;
    };
    stage = 'checking-account'; report(stage);
    const state = await waitFor(async () => {
      const signedIn = await identity();
      if (signedIn) return { signedIn };
      assertOrigin(page, origins);
      if (!originAllowed(page, storeOrigins)) {
        const field = await orderedVisible(page, selectors.email, account);
        return field ? { directLogin: true } : null;
      }
      if (await orderedVisible(page, selectors.password, account) && await orderedVisible(page, selectors.email, account)) return { directLogin: true };
      if (skipStoreNavigation) {
        const cartEntry = await findCartEntry(context, selectors.cartLoginEntry, account, origins);
        if (cartEntry) return { entry: cartEntry.locator, entryFrame: cartEntry.frame };
      }
      const entry = await uniqueVisible(page, selectors.loginEntry, account);
      return entry ? { entry } : null;
    }, timeout, signal);
    if (!state.signedIn) {
      signal?.throwIfAborted();
      const initialSurface = state.entry ? surfaceKey(state.entryFrame || page) : null;
      if (state.entry) {
        assertOrigin(state.entryFrame || page, origins);
        stage = 'clicking-login-entry'; report(stage);
        await state.entry.click({ timeout: 10000, noWaitAfter: true });
      }
      stage = 'waiting-for-email-field'; report(stage);
      const findField = spec => findLoginField(context, spec, account, origins, storeOrigins, initialSurface, selectors.password);
      const email = await waitFor(() => findField(selectors.email), timeout, signal);
      assertOrigin(email.frame, origins);
      signal?.throwIfAborted();
      stage = 'entering-email'; report(stage);
      await email.field.fill(account.email, { timeout: 10000 });
      let secret = await findField(selectors.password);
      if (!secret) {
        const next = await uniqueVisible(email.frame, selectors.emailNext, account);
        if (!next) throw new ManualPause('password-step-unrecognized');
        assertOrigin(email.frame, origins);
        signal?.throwIfAborted();
        await next.click({ timeout: 10000, noWaitAfter: true });
        secret = await waitFor(() => findField(selectors.password), timeout, signal);
      }
      stage = 'entering-password'; report(stage);
      assertOrigin(secret.frame, origins);
      signal?.throwIfAborted();
      await secret.field.fill(password, { timeout: 10000 });
      const submit = await uniqueVisible(secret.frame, selectors.loginSubmit, account);
      if (!submit) throw new ManualPause('login-submit-unrecognized');
      assertOrigin(secret.frame, origins);
      signal?.throwIfAborted();
      stage = 'submitting-login'; report(stage);
      await submit.click({ timeout: 10000, noWaitAfter: true });
      stage = 'verifying-account'; report(stage);
      page = await waitFor(identity, timeout, signal);
    } else { page = state.signedIn; }
    password = undefined;
    if (loginOnly) { report('logged-in-manual'); return { status: 'logged-in-manual' }; }
    }
    stage = 'verifying-product'; report(stage);
    signal?.throwIfAborted();
    await page.goto(purchase.productUrl, { waitUntil: 'domcontentloaded', timeout });
    assertOrigin(page, storeOrigins);
    const actualId = new URL(page.url()).pathname.match(/\/product\/(\d+)\//)?.[1];
    if (actualId !== String(purchase.expectedProductId)) throw new ManualPause('product-id-mismatch');
    const title = await waitFor(() => uniqueVisible(page, selectors.productTitle, account), timeout, signal);
    const titleText = (await title.innerText()).replace(/\s+/g, ' ').trim();
    const normalizeTitle = value => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
    if (normalizeTitle(titleText) !== normalizeTitle(purchase.expectedTitle)) {
      const printable = value => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240);
      report('product-title-check', `Expected "${printable(purchase.expectedTitle)}"; found "${printable(titleText)}"`);
      throw new ManualPause('product-title-mismatch');
    }
    const isFoil = /\bfoil edition\b/i.test(titleText) && !/\bnon[- ]foil\b/i.test(titleText);
    if (isFoil !== (purchase.expectedVariant === 'Foil')) throw new ManualPause('variant-mismatch');
    const productPath = new URL(page.url()).pathname;
    if (!resumeCart) {
    const scope = selectors.productScope ? await waitFor(() => uniqueVisible(page, selectors.productScope, account), timeout, signal) : page;
    const quantity = await uniqueVisible(scope, selectors.quantity, account);
    if (quantity) {
      signal?.throwIfAborted();
      const tag = await quantity.evaluate(el => el.tagName);
      if (tag === 'SELECT') await quantity.selectOption(String(purchase.quantityPerAccount));
      else await quantity.fill(String(purchase.quantityPerAccount));
      if (await quantity.inputValue() !== String(purchase.quantityPerAccount)) throw new ManualPause('quantity-not-confirmed');
    } else if (purchase.quantityPerAccount !== 1) throw new ManualPause('quantity-control-required');
    const add = await waitFor(() => uniqueVisible(scope, selectors.addToCart, account), timeout, signal);
    if (!await add.isEnabled()) throw new ManualPause('product-unavailable');
    signal?.throwIfAborted();
    assertOrigin(page, storeOrigins);
    // Reserve an attempt BEFORE sending the click. A timeout or crash must not cause a second click.
    await fs.mkdir(attemptDir, { recursive: true });
    const marker = path.join(attemptDir, `${account.id}-${purchase.expectedProductId}.json`);
    try {
      await fs.writeFile(marker, JSON.stringify({ accountId: account.id, productId: purchase.expectedProductId, attemptedAtUtc: new Date().toISOString() }), { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new ManualPause('previous-cart-attempt-needs-review');
      throw error;
    }
    stage = 'cart-attempt'; report(stage);
    attempted = true;
    await add.click({ timeout: 10000, noWaitAfter: true });
    cartClickCompleted = true;
    } else {
      stage = 'opening-existing-cart'; report(stage);
      const openCart = await waitFor(() => uniqueVisible(page, selectors.openCart, account), timeout, signal);
      signal?.throwIfAborted();
      assertOrigin(page, storeOrigins);
      await openCart.click({ timeout: 10000, noWaitAfter: true });
      cartClickCompleted = true;
    }
    if (config.postCartAction === 'view-cart') {
      stage = 'finding-view-cart'; report(stage);
      const next = await waitFor(async () => {
        // If Add to Cart already redirected (including to a queue), leave that page alone.
        if (!originAllowed(page, storeOrigins) || new URL(page.url()).pathname !== productPath) return { redirected: true };
        const control = await uniqueVisible(page, selectors.viewCart, account);
        return control ? { control } : null;
      }, timeout, signal);
      if (!next.redirected) {
        signal?.throwIfAborted();
        if (originAllowed(page, storeOrigins) && new URL(page.url()).pathname === productPath) {
          stage = 'view-cart-attempt'; report(stage);
          await next.control.click({ timeout: 10000, noWaitAfter: true });
          if (cartFirst) {
            stage = 'waiting-for-cart-login'; report(stage);
            const destination = async () => {
              for (const candidate of context.pages()) {
                if (candidate.isClosed()) continue;
                if (originAllowed(candidate, origins) && !originAllowed(candidate, storeOrigins) && await orderedVisible(candidate, selectors.email, account)) return { page: candidate };
              }
              if (!originAllowed(page, storeOrigins) || new URL(page.url()).pathname !== productPath) return { page };
              const prompt = await findCartEntry(context, selectors.cartLoginEntry, account, origins);
              if (prompt) return { page: prompt.page };
              const proceed = await uniqueVisible(page, selectors.proceedToCart, account);
              return proceed ? { proceed } : null;
            };
            let arrived = await waitFor(destination, timeout, signal);
            if (arrived.proceed) {
              signal?.throwIfAborted();
              assertOrigin(page, storeOrigins);
              await arrived.proceed.click({ timeout: 10000, noWaitAfter: true });
              arrived = await waitFor(async () => { const next = await destination(); return next?.page ? next : null; }, timeout, signal);
            }
            const result = await loginAndCart({ context, page: arrived.page, account, password, purchase, config, attemptDir, loginOnly: true, skipStoreNavigation: true, report, signal, policy });
            const status = result.status === 'logged-in-manual' ? 'cart-login-completed-manual' : 'cart-followup-needed-manual';
            report(status, result.reason);
            return { status, ...(result.reason ? { reason: result.reason } : {}) };
          }
          report('view-cart-attempted-manual');
          return { status: 'view-cart-attempted-manual' };
        }
      }
    }
    // Stop after the requested cart action. Never refresh, retry Add to Cart, or continue checkout.
    report('cart-attempted-manual');
    return { status: 'cart-attempted-manual' };
  } catch (error) {
    if (['waiting-for-email-field', 'entering-email', 'entering-password', 'submitting-login'].includes(stage)) await reportLoginFields(context, origins, report);
    if (['waiting-for-cart-login', 'checking-account', 'clicking-login-entry', 'entering-email'].includes(stage)) await reportCartFrames(context, report);
    // Playwright errors can contain typed values and page details: never log raw errors.
    const status = cartClickCompleted ? 'cart-followup-needed-manual' : attempted ? 'cart-outcome-unknown-manual' : 'manual-intervention';
    const reason = error instanceof ManualPause ? error.code : `${stage}-not-completed`;
    report(status, reason);
    return { status, reason };
  } finally { password = undefined; }
}
