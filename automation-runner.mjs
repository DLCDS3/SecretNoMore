import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadPlaywright } from './automation/runtime.mjs';
import { loginAndCart, validateAutomation, validateProduct } from './automation/flow.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try { payload = JSON.parse(input); } catch { console.error('Invalid automation input.'); process.exit(1); }
input = undefined;
const { root, browser, accounts, purchase, config, action, scheduledAt } = payload;
payload = undefined;
try {
  validateAutomation(config); validateProduct(purchase);
  if (!accounts.length || accounts.some(a => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a.id) || !a.password)) throw new Error('Missing account passwords.');
} catch { console.error('Automation configuration is invalid. Check selectors, purchase title, and saved passwords.'); process.exit(1); }
const target = scheduledAt ? Date.parse(scheduledAt) : null;
if (target !== null && (!Number.isFinite(target) || target <= Date.now())) { console.error('Scheduled start has passed.'); process.exit(1); }
if (target !== null && (!Number.isInteger(config.maxLatenessSeconds) || config.maxLatenessSeconds < 0 || config.maxLatenessSeconds > 300)) { console.error('Invalid lateness limit.'); process.exit(1); }
const local = path.join(root, '.local');
await fs.mkdir(local, { recursive: true });
const lockPath = path.join(local, 'automation.lock');
let lock;
try { lock = await fs.open(lockPath, 'wx'); } catch { console.error('Another automation run is active, or its lock remains. Close that run before trying again.'); process.exit(1); }
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAtUtc: new Date().toISOString() }));
const contexts = [];
const cancelled = new AbortController();
let dispatched = false;
const onInterrupt = () => {
  cancelled.abort();
  if (!dispatched) {
    console.log('Schedule cancelled before dispatch.');
    for (const context of contexts) context.close().catch(() => {});
  } else console.log('Automation stopped. Browser windows remain for manual use; close them to end the run.');
};
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const manifest = {
  runId: randomUUID(), action, scheduledAt, productUrl: purchase.productUrl,
  startedAtUtc: new Date().toISOString(),
  accounts: accounts.map(a => ({ id: a.id, status: 'starting-browser', reason: null, dispatchAtUtc: null, confirmedAtUtc: null }))
};
const runPath = path.join(local, 'last-run.json');
let writes = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(manifest, null, 2);
  writes = writes.then(async () => {
    await fs.writeFile(`${runPath}.tmp`, snapshot);
    await fs.rename(`${runPath}.tmp`, runPath);
  });
  return writes;
}
await save();
try {
  const { chromium } = loadPlaywright();
  const ready = await Promise.all(accounts.map(async (account, index) => {
    const entry = manifest.accounts[index];
    try {
      const profile = path.join(local, 'profiles', browser, account.id);
      const context = await chromium.launchPersistentContext(profile, {
        channel: browser === 'edge' ? 'msedge' : 'chrome', headless: false, viewport: null, chromiumSandbox: true,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false
      });
      contexts.push(context);
      const closed = new Promise(resolve => context.once('close', resolve));
      const page = context.pages()[0] || await context.newPage();
      entry.status = 'browser-ready';
      return { account, context, page, entry, closed };
    } catch {
      account.password = undefined;
      entry.status = 'launch-failed'; entry.reason = 'close-existing-profile-windows-and-check-browser-installation';
      process.exitCode = 1;
      console.log(`${account.id}: launch-failed`);
      return null;
    }
  }));
  await save();
  if (!ready.some(Boolean)) throw new Error('No browser profiles could be opened.');
  if (target !== null) {
    let nextReport = 0;
    while (Date.now() < target && !cancelled.signal.aborted) {
      if (!ready.some(worker => worker && worker.context.pages().length)) throw new Error('All browser windows were closed before dispatch.');
      if (Date.now() >= nextReport) { console.log(`Waiting: ${Math.ceil((target - Date.now()) / 1000)} seconds until login/cart dispatch.`); nextReport = Date.now() + 30000; }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(250, target - Date.now()))));
    }
    if (Date.now() - target > payloadMaxLateness()) throw new Error('Missed scheduled start beyond maxLatenessSeconds.');
  }
  if (cancelled.signal.aborted) throw new Error('Cancelled before dispatch.');
  dispatched = true;
  await Promise.all(ready.filter(Boolean).map(async worker => {
    worker.entry.dispatchAtUtc = new Date().toISOString();
    const result = await loginAndCart({
      ...worker, password: worker.account.password, purchase, config,
      attemptDir: path.join(local, 'cart-attempts'), loginOnly: action === 'Prepare', resumeCart: action === 'ResumeCart', signal: cancelled.signal,
      report: (status, reason = null) => {
        worker.entry.status = status; worker.entry.reason = reason;
        console.log(`${worker.account.id}: ${status}${reason ? ` (${reason})` : ''}`);
        save().catch(() => console.error('Unable to update the local status record.'));
      }
    });
    if (!['cart-attempted-manual', 'view-cart-attempted-manual', 'cart-login-completed-manual', 'logged-in-manual'].includes(result.status)) process.exitCode = 1;
    worker.account.password = undefined;
    await save();
  }));
  console.log('Automation paused. Check each window manually. Adding to cart does not confirm queue entry. Close all automation browser windows when finished.');
  await Promise.all(ready.filter(Boolean).map(worker => worker.closed));
} catch (error) {
  // Outer errors are from our configuration/runtime checks, not typed browser actions.
  console.error(error.message === 'Missed scheduled start beyond maxLatenessSeconds.' ? error.message : 'Run stopped; check configuration and browser installation.');
  if (!dispatched) await Promise.all(contexts.map(c => c.close().catch(() => {})));
  else await Promise.all(contexts.map(c => c.pages().length ? new Promise(resolve => c.once('close', resolve)) : Promise.resolve()));
  process.exitCode = 1;
} finally {
  accounts.forEach(a => { a.password = undefined; });
  await writes;
  await lock.close();
  await fs.unlink(lockPath);
}
function payloadMaxLateness() { return config.maxLatenessSeconds * 1000; }
