// End-to-end write-flow audit on an anvil fork of Monad mainnet (nothing touches mainnet).
//   anvil --fork-url https://rpc.monad.xyz --chain-id 143 --port 8547 --auto-impersonate
//   FORK=http://127.0.0.1:8547 AS=0xDeployer node scripts/write-audit.mjs
// The page's RPC traffic is routed to the fork; the mock EIP-6963 wallet sends from the impersonated AS address and,
// like the user's mobile wallet, forces 900,000 gas on any contract-creation transaction (WALLET_CREATE_GAS).
// Reports every send (to, gas, status), the UI result line, and console/page errors on every tab (desktop + mobile).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../out'); const BASE = process.env.NEXT_BASE_PATH ?? '/policypilot-monad';
const FORK = process.env.FORK || 'http://127.0.0.1:8547'; const AS = process.env.AS; const SHOTS = process.env.SHOTS || '';
const CREATE_GAS = process.env.WALLET_CREATE_GAS || '0xdbba0';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
if (!AS) throw new Error('AS=0x... required');
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core').catch(() => import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'));
const chromium = pw.chromium ?? pw.default.chromium;
const server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); } p = p.slice(BASE.length) || '/'; let f = path.join(OUT, p); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); if (!fs.existsSync(f) && /showcase-\d+\.json$/.test(p)) { fetch(`https://blockchains.github.io${BASE}${p}`).then(r => r.text()).then(t => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(t); }).catch(() => { res.writeHead(404); res.end(); }); return; } if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } const ty = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(f)] ?? 'application/octet-stream'; res.writeHead(200, { 'content-type': ty }); fs.createReadStream(f).pipe(res); });
await new Promise(r => server.listen(0, r)); const SITE = `http://127.0.0.1:${server.address().port}${BASE}`;
const rpc = async (method, params = []) => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), j.error); return j.result; };
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`); };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });

async function open(viewport, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' : undefined });
  const page = await ctx.newPage(); const sent = []; const errors = [];
  await ctx.route(/https:\/\/(rpc\d?\.monad\.xyz|rpc-mainnet\.monadinfra\.com)\/?$/, async route => {
    const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: await r.text() });
  });
  await ctx.routeWebSocket(/wss:\/\//, ws => ws.close());
  await page.exposeFunction('__fork', async (method, params) => {
    if (method === 'eth_sendTransaction') {
      const tx = { ...params[0], from: AS };
      if (!tx.to) tx.gas = CREATE_GAS; // what the user's wallet did
      const rec = { to: tx.to ?? 'CREATE', gas: BigInt(tx.gas ?? 0).toString(), value: BigInt(tx.value ?? 0).toString(), sel: (tx.data ?? '0x').slice(0, 10) };
      try { const h = await rpc('eth_sendTransaction', [tx]); let rc = null; for (let i = 0; i < 60 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await new Promise(r => setTimeout(r, 500)); } rec.hash = h; rec.status = rc?.status; rec.used = BigInt(rc?.gasUsed ?? 0).toString(); sent.push(rec); return { ok: h }; }
      catch (e) { rec.err = e.message; sent.push(rec); return { err: { message: e.message, code: e.code ?? -32000, data: e.data } }; }
    }
    try { return { ok: await rpc(method, params) }; } catch (e) { return { err: { message: e.message, code: e.code, data: e.data } }; }
  });
  await page.addInitScript(({ as }) => {
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [as];
      if (method === 'eth_chainId') return '0x8f';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_getCapabilities') { const e = new Error('Method not supported'); e.code = 4200; throw e; }
      if (/^(eth_sign|personal_|wallet_sendCalls)/.test(method)) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
      const r = await window.__fork(method, params ?? []); if (r.err) throw Object.assign(new Error(r.err.message), r.err); return r.ok; }, on() {}, removeListener() {} };
    const info = { uuid: 'audit-0001', name: 'Audit Fork Wallet', icon: '', rdns: 'test.audit.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); localStorage.setItem('pp.netkey', 'mainnet');
  }, { as: AS });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()} ${r.url().slice(0, 160)}`); });
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 240)}`); });
  return { ctx, page, sent, errors };
}
const connect = async page => { await page.getByTestId('connect').first().click(); await page.getByTestId('wallet-option').first().click(); await page.waitForTimeout(1500); };
const LABEL = { home: 'Home', launch: 'Launch', activity: 'Activity', agents: 'Agents', services: 'Services', policy: 'Policy' };
const goTab = async (page, t) => { await page.locator('nav:visible button', { hasText: new RegExp(`^\\s*${LABEL[t]}\\s*$`) }).first().click(); await page.waitForTimeout(2500); };
const text = async (page, id) => (await page.getByTestId(id).first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
const waitIdle = async (page, id, ms = 120000) => { await page.waitForFunction(i => { const t = document.querySelector(`[data-testid="${i}"]`)?.textContent ?? ''; return t.trim().length > 0; }, id, { timeout: ms }); };
const flow = async (name, fn) => { if (ONLY.length && !ONLY.includes(name)) return; const t = Date.now(); try { await fn(); } catch (e) { check(`${name}: ran`, false, e.message.split('\n')[0]); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `fail-${name}.png`), fullPage: true }).catch(() => {}); } console.log(`  (${name} ${((Date.now() - t) / 1000).toFixed(0)}s)`); };
const sendsOk = (s, from) => s.slice(from).every(x => x.status === '0x1');
const fmt = s => s.map(x => `${x.to === 'CREATE' ? 'CREATE' : x.to.slice(0, 8)} ${x.sel} gas ${x.gas} used ${x.used ?? '-'} ${x.status ?? x.err}`).join(' | ');

const { page, sent, errors } = await open({ width: 1280, height: 1000 });
await page.goto(`${SITE}/?net=mainnet#launch`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('connect').first().waitFor({ timeout: 30000 }); await connect(page);
const bal0 = BigInt(await rpc('eth_getBalance', [AS, 'latest']));

for (const [desk, label] of [['prime', 'Prime Alpha (open + 10 MON)'], ['clip', 'Clip (open + 1 MON)'], ['spread', 'Spread (open + 1 MON)']]) await flow(desk, async () => {
  const card = page.getByTestId(desk === 'prime' ? 'prime-terminal' : `${desk}-desk`); await card.scrollIntoViewIfNeeded(); await card.waitFor({ timeout: 60000 });
  if (desk === 'prime') await page.getByTestId('tranche-junior').click();
  await page.getByTestId(`${desk}-amount`).fill(desk === 'prime' ? '10' : '1');
  await page.waitForTimeout(2500);
  const n = sent.length; await page.getByTestId(`${desk}-go`).click();
  await page.getByTestId(`${desk}-receipt`).waitFor({ timeout: 180000 });
  await page.waitForFunction(i => !/…|ing$/.test(document.querySelector(`[data-testid="${i}"]`)?.textContent ?? ''), `${desk}-receipt`, { timeout: 120000 }).catch(() => {});
  const r = await text(page, `${desk}-receipt`);
  check(`${label}: every send succeeds, none at the wallet's 900k create limit`, sent.length > n && sendsOk(sent, n) && !sent.slice(n).some(x => x.to === 'CREATE'), `${fmt(sent.slice(n))} || ${r}`);
  await page.waitForTimeout(4000);
  const w = page.getByTestId(`${desk}-withdraw`); await w.waitFor({ timeout: 60000 });
  const m = sent.length; await w.click();
  await page.waitForFunction(k => window.__dummy || true, null); await page.waitForTimeout(15000);
  check(`${label}: withdraw succeeds`, sent.length > m && sendsOk(sent, m), `${fmt(sent.slice(m))} || ${await text(page, `${desk}-receipt`)}`);
});

await flow('prime-overcap', async () => {
  // A deposit the contract would refuse (over the 10 MON cap via direct input) must be blocked before signing.
  await page.getByTestId('prime-amount').fill('50'); await page.waitForTimeout(800);
  check('Prime over-cap: blocked in the UI with the remaining room', /EXCEEDS CAP|can still take/i.test(await text(page, 'prime-gate')), await text(page, 'prime-gate'));
  await page.getByTestId('prime-max').click(); await page.waitForTimeout(300);
  check('Prime Max respects cap and gas reserve', Number(await page.getByTestId('prime-amount').inputValue()) <= 10, await page.getByTestId('prime-amount').inputValue());
});

if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'audit-launch.png'), fullPage: true });

await flow('starter', async () => {
  await goTab(page, 'agents');
  if (!(await page.getByTestId('starter').count())) await connect(page);
  await page.getByTestId('starter-amt').fill('0.1'); const n = sent.length; await page.getByTestId('starter').click();
  await page.waitForTimeout(20000);
  check('One-click starter: create + deposit succeed', sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
});
for (const id of ['yield', 'trader', 'payments']) await flow(`super-${id}`, async () => {
  await page.getByTestId(`super-${id}`).click(); await page.getByTestId('super-sheet').waitFor();
  await page.getByTestId('super-amt').fill('0.1');
  if (id === 'payments' && await page.getByTestId('super-payees').count()) await page.getByTestId('super-payees').fill('0x000000000000000000000000000000000000dEaD');
  const n = sent.length; await page.getByTestId('super-create').click();
  await page.waitForFunction(() => !/Creating…/.test(document.querySelector('[data-testid="super-create"]')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2000);
  check(`Super vault ${id}: every send succeeds`, sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
  await page.keyboard.press('Escape').catch(() => {});
});
await flow('launch', async () => {
  await goTab(page, 'launch'); await page.getByTestId('jump-desk-rules').click(); await page.waitForTimeout(1000);
  await page.getByTestId('in-deposit').fill('0.1'); const n = sent.length; await page.getByTestId('launch').click();
  await page.waitForTimeout(25000);
  check('Launch: every send succeeds', sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
});
await flow('dispatch', async () => {
  await goTab(page, 'launch'); await page.getByTestId('jump-desk-dispatch').click(); await page.waitForTimeout(1500);
  await page.getByTestId('vault-new').click(); await page.getByTestId('dispatch-amount').fill('0.1'); await page.waitForTimeout(2500);
  let n = sent.length; await page.getByTestId('dispatch-go').click(); await page.waitForTimeout(25000);
  check('Dispatch (new vault): every send succeeds', sent.length > n && sendsOk(sent, n), `${fmt(sent.slice(n))} || ${await text(page, 'dispatch-receipt')}`);
  if (await page.getByTestId('vault-choice').count()) {
    await page.getByTestId('vault-choice').first().click(); await page.getByTestId('dispatch-amount').fill('0.05'); await page.waitForTimeout(2500);
    n = sent.length; await page.getByTestId('dispatch-go').click(); await page.waitForTimeout(20000);
    check('Dispatch (existing vault): every send succeeds', sent.length > n && sendsOk(sent, n), `${fmt(sent.slice(n))} || ${await text(page, 'dispatch-receipt')}`);
  }
});
await flow('monadefi', async () => {
  await goTab(page, 'home'); await page.waitForTimeout(1500);
  await page.getByTestId('md-deploy-open').first().click(); await page.waitForTimeout(1500);
  await page.getByTestId('md-amount').first().fill('0.2'); await page.getByTestId('md-review').first().click(); await page.waitForTimeout(800);
  let n = sent.length; await page.getByTestId('md-confirm').first().click(); await page.waitForTimeout(15000);
  check('MonaDefi deposit succeeds', sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
  await goTab(page, 'policy'); await goTab(page, 'home'); await page.waitForTimeout(3000);
  await page.getByTestId('md-withdraw-open').first().click(); await page.waitForTimeout(2000);
  await page.getByTestId('md-w-25').first().click(); await page.waitForTimeout(800); await page.getByTestId('md-w-review').first().click(); await page.waitForTimeout(800);
  n = sent.length; await page.getByTestId('md-w-confirm').first().click(); await page.waitForTimeout(15000);
  check('MonaDefi withdraw request succeeds', sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
});
await flow('removelimits', async () => {
  await goTab(page, 'agents'); await page.waitForTimeout(4000);
  const rows = page.getByTestId('own-vault'); const k = await rows.count(); let hit = false;
  for (let i = 0; i < k && !hit; i++) {
    await rows.nth(i).click(); await page.waitForTimeout(2500);
    const go = page.getByTestId('remove-limits-go');
    if (await go.count() && await go.isEnabled()) {
      hit = true; const n = sent.length; await go.click();
      await page.waitForFunction(() => !/Signing/.test(document.querySelector('[data-testid="remove-limits-go"]')?.textContent ?? ''), null, { timeout: 240000 }).catch(() => {});
      await page.waitForTimeout(3000);
      check('Remove limits (older vault): every send succeeds', sent.length > n && sendsOk(sent, n), fmt(sent.slice(n)));
    }
  }
  if (!hit) console.log(`  remove-limits: no older vault with limits among ${k} owned vaults`);
});
await flow('closeall', async () => {
  await goTab(page, 'policy'); await page.getByTestId('positions-view').waitFor({ timeout: 60000 });
  await page.getByTestId('vault-card').first().waitFor({ timeout: 120000 });
  const ca = page.getByTestId('close-all'); if (!(await ca.isEnabled())) { check('Close-all: enabled', false, await text(page, 'close-all-why')); return; }
  await ca.click(); await page.getByTestId('close-steps').waitFor({ timeout: 120000 });
  const n = sent.length; await page.getByTestId('close-confirm').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="close-result"], [data-testid="close-error"]'), null, { timeout: 600000 }).catch(() => {});
  const steps = await page.$$eval('[data-testid=close-step]', es => es.map(e => e.getAttribute('data-status')));
  check('Positions close-all: every step done, no error', steps.length > 0 && steps.every(x => x === 'done') && !(await page.getByTestId('close-error').count()), steps.join(','));
  check('Positions close-all: every send succeeds', sent.length > n && sendsOk(sent, n), `${sent.length - n} sends; ${fmt(sent.slice(n).filter(x => x.status !== '0x1')).slice(0, 400)} || ${(await text(page, 'close-modal')).slice(-200)}`);
});

const balEnd = BigInt(await rpc('eth_getBalance', [AS, 'latest']));
console.log(`fork balance ${Number(bal0) / 1e18} -> ${Number(balEnd) / 1e18} MON; ${sent.length} sends`);
check('desktop: no page errors', !errors.some(e => e.startsWith('pageerror')), errors.slice(0, 8).join(' || '));

// Console tour, desktop + mobile, every tab.
if (!process.env.NOTOUR) for (const [vp, mob, tag] of [[{ width: 1280, height: 1000 }, false, 'desktop'], [{ width: 390, height: 844 }, true, 'mobile']]) {
  const o = await open(vp, mob); await o.page.goto(`${SITE}/?net=mainnet#home`); await o.page.getByTestId('connect').first().waitFor({ timeout: 30000 }); await connect(o.page);
  for (const t of ['home', 'launch', 'activity', 'agents', 'services', 'policy']) {
    const before = o.errors.length; await goTab(o.page, t); await o.page.waitForTimeout(7000);
    const errs = o.errors.slice(before).filter(e => !/WebSocket|wss:\/\//i.test(e));
    check(`${tag} ${t}: no console errors`, errs.length === 0, errs.slice(0, 4).join(' || '));
    if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, `tour-${tag}-${t}.png`) });
  }
  await o.ctx.close();
}
fs.writeFileSync(process.env.AUDIT_OUT || '/tmp/write-audit.json', JSON.stringify({ results, sent }, null, 1));
await browser.close(); server.close();
const bad = results.filter(r => !r.ok); console.log(`${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
