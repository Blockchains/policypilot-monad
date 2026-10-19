// REAL mainnet end-to-end test of MonaDefi Momentum through the live UI (the reviewed flow), mobile viewport.
// A test EIP-6963 wallet in the page forwards eth_sendTransaction to this Node process, which signs with the key from
// OWNER_ENV (never printed, never sent to the page). Everything else is the site's own code: setup wizard, entry review
// with its gates, Sell 50%, Close, Withdraw available MON, Add funds, Close positions and withdraw.
//   OWNER_ENV=~/.policypilot/mainnet-wallet.env SITE=https://blockchains.github.io/policypilot-monad OUT=/tmp/m-e2e node scripts/momentum-e2e.mjs
//   ALLOC=1.2 ENTRY=0.5 ENTRY2=0.3 ADD=0.6 RESERVE=5
//   ASSET=WBTC ALLOC=10.6 ENTRY=10      the same reviewed flow on another enabled asset (WBTC/cbBTC need >= 10 MON)
//   AUTO=1 ALLOC=1 HOLD=0.25            setup in "Automatic within limits": 2 signatures (create + keeper opt-in), then stop
//   VAULT=0x.. SWEEP_ON=1               on an opted-in vault: edit the keeper settings to turn auto-sweep on (1 signature)
//   VAULT=0x.. WITHDRAW=1               on an existing vault: withdraw all free MON (1 signature); combine with REVOKE=1
//   VAULT=0x.. REVOKE=1                 on an opted-in vault: revoke the keeper (1 signature)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const E = process.env;
const SITE = E.SITE || 'https://blockchains.github.io/policypilot-monad';
const OUT = E.OUT || '/tmp/m-e2e'; fs.mkdirSync(OUT, { recursive: true });
const envFile = (E.OWNER_ENV || '~/.policypilot/mainnet-wallet.env').replace(/^~/, os.homedir());
// FORK=http://127.0.0.1:8547 rehearses against an anvil fork (anvil's well-known test key 0, its RPC replaces Monad's in the page).
const FORK = E.FORK || '';
const KEY = FORK ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' : fs.readFileSync(envFile, 'utf8').match(/^MONAD_MAINNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)?.[1];
if (!KEY) throw new Error('no key in OWNER_ENV');
const account = privateKeyToAccount(KEY);
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } };
const RPC = FORK || 'https://rpc.monad.xyz';
const pub = createPublicClient({ chain, transport: http(RPC) });
const wal = createWalletClient({ chain, account, transport: http(RPC) });
const RESERVE = parseEther(E.RESERVE || '5');
const ASSET = E.ASSET || 'WETH'; const ALLOC = E.ALLOC || '1.2', ENTRY = E.ENTRY || '0.5', ENTRY2 = E.ENTRY2 || '0.3', ADD = E.ADD || '0.6';
const startBal = await pub.getBalance({ address: account.address });
if (startBal - parseEther(ALLOC) - parseEther(ADD) - parseEther('1.5') < RESERVE) throw new Error(`would break the ${formatEther(RESERVE)} MON reserve`);
const txs = []; const errors = []; const steps = [];
const pw = await import(E.PLAYWRIGHT_CORE || '/home/box/.local/lib/node_modules/playwright-core/index.mjs'); const chromium = pw.chromium ?? pw.default.chromium;
const browser = await chromium.launch({ headless: true, executablePath: E.CHROME || '/usr/bin/google-chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
if (FORK) await ctx.route(/https:\/\/(rpc\d?\.monad\.xyz|rpc-mainnet\.monadinfra\.com)\/?$/, async route => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() }); route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() }); });
if (E.LOCAL_OUT) {
  const http2 = await import('node:http'); const BASE = '/policypilot-monad'; const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const srv = http2.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); } p = p.slice(BASE.length) || '/'; let f = path.join(E.LOCAL_OUT, p); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
  await new Promise(r => srv.listen(0, r)); globalThis.__SITE = `http://127.0.0.1:${srv.address().port}${BASE}`;
}
page.on('response', r => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url().slice(0, 160)}`));
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`)); page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
let label = 'setup';
await page.exposeFunction('__ppSend', async (tx) => {
  const big = x => (x == null ? undefined : BigInt(x));
  const req = { to: tx.to, data: tx.data, value: big(tx.value) ?? 0n, gas: big(tx.gas) };
  if (tx.maxFeePerGas) { req.maxFeePerGas = big(tx.maxFeePerGas); req.maxPriorityFeePerGas = big(tx.maxPriorityFeePerGas); } else if (tx.gasPrice) req.gasPrice = big(tx.gasPrice);
  const bal = await pub.getBalance({ address: account.address });
  if (bal - (req.value ?? 0n) < RESERVE) throw new Error('reserve guard: refusing to sign');
  const hash = await wal.sendTransaction(req);
  const step = E.AUTO && label === 'create-vault' && txs.some(t => t.step === 'create-vault') ? 'keeper-opt-in' : label;
  txs.push({ step, hash, to: tx.to, value: formatEther(req.value ?? 0n) }); console.log(`tx ${step}: ${hash}`);
  return hash;
});
await page.addInitScript(({ addr, vault, block }) => {
  const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
    if (method === 'eth_chainId') return '0x8f'; if (method === 'net_version') return '143';
    if (method.startsWith('wallet_')) return null;
    if (method === 'eth_sendTransaction') return window.__ppSend(params[0]);
    if (/^eth_sign|^personal_/.test(method)) { const e = new Error('not supported'); e.code = 4200; throw e; }
    return rpc(method, params ?? []);
  }, on() {}, removeListener() {} };
  const info = { uuid: 'm-e2e-1', name: 'Momentum E2E Wallet', icon: '', rdns: 'test.momentum.e2e' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
  localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.momentum.e2e');
  if (vault) localStorage.setItem(`pp.momentum.143.${addr.toLowerCase()}.vault`, JSON.stringify({ vault, block }));
}, { addr: account.address, vault: E.VAULT || null, block: Number(E.VAULT_BLOCK || 0) });
let n = 0; const shot = async (name) => { await page.waitForTimeout(500); const f = path.join(OUT, `mobile-${String(++n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f, fullPage: true }); steps.push({ name, shot: f }); };
const T = (id) => page.getByTestId(id);
const visible = async (id, ms = 60000) => { await T(id).first().waitFor({ state: 'visible', timeout: ms }); };
try {
  await page.goto(`${globalThis.__SITE || SITE}/#momentum`, { waitUntil: 'domcontentloaded' }); await visible('momentum');
  await page.waitForFunction(() => /0x/.test(document.querySelector('[data-testid=connect]')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000); await shot('momentum-page');
  if (E.VAULT) {
    // keeper management on an existing opted-in vault (dashboard → Automatic card)
    await visible('m-dashboard', 90000); await visible('m-auto', 90000); await page.waitForTimeout(6000); await shot('auto-card');
    if (E.SWEEP_ON) {
      await T('m-auto-edit').click(); await visible('m-auto-sheet'); if (!(await T('m-auto-sweep').isChecked())) await T('m-auto-sweep').check(); await shot('auto-edit-sweep');
      label = 'settings-sweep-on'; await T('m-auto-confirm').click(); await page.waitForFunction(() => /0x[0-9a-f]{64}/i.test(document.querySelector('[data-testid=m-auto-tx]')?.textContent ?? document.querySelector('[data-testid=m-auto-msg]')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => {});
      await page.waitForTimeout(3000); steps.push({ name: 'sweep-on-result', text: (await T('m-auto-msg').allTextContents()).join(' | ') }); await shot('auto-sweep-on');
    }
    if (E.WITHDRAW) {
      // owner withdraws all free MON through the site's Withdraw sheet (positions must already be closed)
      await T('m-withdraw').click(); await visible('m-withdraw-sheet'); await T('m-w-max').click(); await shot('withdraw-available');
      label = 'withdraw-available'; await T('m-w-go').click(); await page.waitForFunction(() => /Withdrew/.test(document.querySelector('[data-testid=m-w-log]')?.textContent ?? ''), null, { timeout: 180000 });
      steps.push({ name: 'withdraw-available-result', text: await T('m-w-log').first().textContent() }); await shot('withdraw-available-done');
      await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(2000);
    }
    if (E.REVOKE) {
      label = 'revoke'; await T('m-auto-revoke').first().click(); await page.waitForTimeout(20000); await page.waitForFunction(() => !/Momentum keeper/.test(document.querySelector('[data-testid=m-dashboard]')?.textContent ?? ''), null, { timeout: 180000 }).catch(() => {});
      await shot('auto-revoked'); steps.push({ name: 'revoke-result', text: (await T('m-auto-state').allTextContents()).join(' | ') });
    }
    throw 'done';
  }
  // Setup wizard (Start → Momentum)
  if (await T('m-setup').count()) { await T('m-setup').click(); } else { await page.goto(`${globalThis.__SITE || SITE}/`); await T('goal-momentum').click(); }
  await visible('m-alloc'); await T('m-alloc').fill(ALLOC); await shot('setup-allocate'); await T('m-next').click();
  await visible('m-a-WETH'); if (ASSET !== 'WETH') { await T(`m-a-${ASSET}`).check(); await T('m-a-WETH').uncheck(); } await page.waitForTimeout(1500); await shot('setup-assets'); await T('m-next').click();
  await visible('m-mode-review'); if (E.AUTO) await T('m-mode-auto').click(); await shot('setup-execution'); await T('m-next').click();
  await visible('m-rules');
  if (E.AUTO) { await T('m-auto-share').fill(E.SHARE || '100'); await T('m-auto-hold').fill(E.HOLD || '0.25'); await T('m-auto-ack').check(); if (E.SWEEP) await T('m-auto-sweep').check(); if (E.TWAP) await T('m-auto-twap').fill(E.TWAP); if (E.V2) await T('m-auto-v2').check(); if (E.ATR) await T('m-auto-atr').check(); }
  if (ASSET !== 'WETH' || E.MAXPOS) await T('r-maxpos').fill(E.MAXPOS || ENTRY);
  if (ASSET !== 'WETH' || E.MAXTOT) await T('r-maxtot').fill(E.MAXTOT || ALLOC);
  await shot('setup-limits'); await T('m-next').click();
  await visible('m-review'); await shot('setup-review');
  label = 'create-vault'; await T('m-confirm').click(); await visible('m-setup-done', 180000); await shot('setup-done');
  if (E.AUTO) { steps.push({ name: 'setup-done', text: await T('m-setup-done').textContent() }); await T('m-go-dashboard').click(); await visible('m-dashboard'); await visible('m-auto', 90000); await page.waitForTimeout(8000); await shot('dashboard-auto'); steps.push({ name: 'auto-card', text: await T('m-auto').textContent() }); throw 'done'; }
  await T('m-go-dashboard').click(); await visible('m-dashboard'); await page.waitForTimeout(8000); await shot('dashboard-empty');
  // Entry via the review sheet
  await T(`m-review-${ASSET}`).click(); await visible('m-entry'); await T('m-amount').fill(ENTRY); await visible('m-gates', 60000); await page.waitForTimeout(1000);
  if (await T('m-ack').count()) await T('m-ack').check(); if (await T('m-ack-manual').count()) await T('m-ack-manual').check();
  await shot('entry-review');
  label = 'entry'; await T('m-approve').click(); await visible('m-entry-done', 180000); await shot('entry-confirmed');
  steps.push({ name: 'entry-result', text: await T('m-entry-done').textContent() });
  await page.getByText('Done', { exact: true }).click();
  await visible(`m-pos-${ASSET}-1`, 120000); await shot('dashboard-open-position');
  await T(`m-pos-${ASSET}-1`).click(); await visible('m-posdetail'); await shot('position-detail');
  label = 'sell-50'; await T('m-sell-50').click(); await page.waitForFunction(() => /Sold/.test(document.querySelector('[data-testid=m-sell-msg]')?.textContent ?? ''), null, { timeout: 180000 });
  steps.push({ name: 'sell-50-result', text: await T('m-sell-msg').textContent() });
  await page.getByText('Partial history').waitFor({ timeout: 120000 }); await shot('after-sell-50');
  if (E.CLOSE_MODE) {
    // Run B: Withdraw available while the rest of the position is open, then "Close positions and withdraw".
    await page.keyboard.press('Escape'); await page.waitForTimeout(6000);
    await T('m-withdraw').click(); await visible('m-withdraw-sheet'); await T('m-w-max').click(); await shot('withdraw-available-open-position');
    label = 'withdraw-available'; await T('m-w-go').click(); await page.waitForFunction(() => /Withdrew/.test(document.querySelector('[data-testid=m-w-log]')?.textContent ?? ''), null, { timeout: 180000 });
    steps.push({ name: 'withdraw-available-result', text: await T('m-w-log').first().textContent() }); await shot('withdraw-available-done');
    await page.keyboard.press('Escape'); await page.waitForTimeout(8000);
    await T('m-withdraw').click(); await visible('m-withdraw-sheet'); await T('m-w-close').click(); await page.waitForTimeout(1500); await shot('close-and-withdraw-preview');
    label = 'close-and-withdraw'; await T('m-w-go').click();
    await page.waitForFunction(() => /Complete:|Not complete/.test([...document.querySelectorAll('[data-testid=m-w-log]')].map(x => x.textContent).join(' ')), null, { timeout: 300000 });
    steps.push({ name: 'close-and-withdraw-result', text: (await T('m-w-log').allTextContents()).join(' | ') }); await shot('close-and-withdraw-done');
    throw 'done';
  }
  label = 'close'; await T('m-sell-100').click(); await page.waitForFunction(() => /Sold/.test(document.querySelector('[data-testid=m-sell-msg]')?.textContent ?? '') && document.querySelectorAll('[data-testid=m-sell-msg]').length, null, { timeout: 180000 });
  await page.waitForTimeout(6000); steps.push({ name: 'close-result', text: await T('m-sell-msg').textContent() }); await shot('after-close');
  await page.keyboard.press('Escape'); await page.waitForTimeout(8000); await shot('dashboard-closed');
  // Withdraw available MON (Max)
  await T('m-withdraw').click(); await visible('m-withdraw-sheet'); await T('m-w-max').click(); await shot('withdraw-available');
  label = 'withdraw-available'; await T('m-w-go').click(); await page.waitForFunction(() => /Withdrew/.test(document.querySelector('[data-testid=m-w-log]')?.textContent ?? ''), null, { timeout: 180000 });
  steps.push({ name: 'withdraw-available-result', text: await T('m-w-log').first().textContent() }); await shot('withdraw-available-done');
  await page.keyboard.press('Escape'); await page.waitForTimeout(3000);
} catch (e) { if (e !== 'done') { errors.push(`FAILED at ${label}: ${e.message.split('\n')[0]}`); await shot('failure').catch(() => {}); } }
const endBal = await pub.getBalance({ address: account.address });
const res = { site: SITE, wallet: account.address, startMon: formatEther(startBal), endMon: formatEther(endBal), spentMon: formatEther(startBal - endBal), txs, steps, errors };
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify({ ...res, steps: steps.map(s => s.name + (s.text ? `: ${s.text.slice(0, 160)}` : '')) }, null, 2));
await browser.close(); process.exit(errors.some(e => e.startsWith('FAILED')) ? 1 : 0);
