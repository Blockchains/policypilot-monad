// Playwright check of the Positions view (Policy tab) against real Monad mainnet reads.
// Mock EIP-6963 wallet: answers account/chain calls, forwards reads to the public RPC, REJECTS every send/sign.
//   SITE=https://blockchains.github.io/policypilot-monad (default: serve ./out locally)
//   WATCH=0xOwner  NONOWNER=0xAgentOnly  SHOTS=/dir  EXPECT_VAULTS=0xA,0xB (optional: must be listed)  EXPECT_EMPTY=1 (first expected vault must read empty + paused)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../out'); const BASE = process.env.NEXT_BASE_PATH ?? '/policypilot-monad';
const SHOTS = process.env.SHOTS || ''; const WATCH = process.env.WATCH; const NONOWNER = process.env.NONOWNER || '';
const EXPECT = (process.env.EXPECT_VAULTS || '').split(',').filter(Boolean).map(s => s.toLowerCase());
if (!WATCH) throw new Error('WATCH=0x... required');
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core').catch(() => import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'));
const chromium = pw.chromium ?? pw.default.chromium;
let SITE = process.env.SITE; let server;
if (!SITE) {
  server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); } p = p.slice(BASE.length) || '/'; let f = path.join(OUT, p); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } const ty = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(f)] ?? 'application/octet-stream'; res.writeHead(200, { 'content-type': ty }); fs.createReadStream(f).pipe(res); });
  await new Promise(r => server.listen(0, r)); SITE = `http://127.0.0.1:${server.address().port}${BASE}`;
}
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`); };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
const errors = [];
async function open(watch) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage(); const sent = [];
  await page.exposeFunction('__sent', m => sent.push(m));
  await page.addInitScript(({ watch }) => {
    const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch];
      if (method === 'eth_chainId') return '0x8f';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_getCapabilities') { const e = new Error('Method not supported'); e.code = 4200; throw e; }
      if (/^(eth_send|eth_sign|personal_|wallet_sendCalls)/.test(method)) { window.__sent?.(method); const e = new Error('User rejected the request (test wallet never signs).'); e.code = 4001; throw e; }
      return rpc(method, params ?? []); }, on() {}, removeListener() {} };
    const info = { uuid: 'pos-0001', name: 'Positions Test Wallet', icon: '', rdns: 'test.positions.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); localStorage.setItem('pp.netkey', 'mainnet');
  }, { watch });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${SITE}/?net=mainnet#policy`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('positions-view').waitFor({ timeout: 30000 });
  await page.getByTestId('connect').click(); await page.getByTestId('wallet-option').first().click();
  return { page, sent, ctx };
}
try {
  const { page, sent } = await open(WATCH);
  check('alpha warning exact', (await page.getByTestId('positions-alpha').innerText()) === "Alpha · unaudited contract · only deposit what you're happy to lose.");
  check('global alpha banner kept', (await page.getByTestId('alpha').innerText()).includes("Alpha · unaudited contract · only deposit what you're happy to lose."));
  await page.getByTestId('vault-card').first().waitFor({ timeout: 90000 });
  await page.waitForFunction(() => !/…/.test(document.querySelector('[data-testid="sum-Total (MON)"]')?.textContent ?? '…'), null, { timeout: 60000 });
  const cards = await page.getByTestId('vault-card').count();
  check('owner vaults listed', cards > 0, `${cards} vault cards`);
  const listed = await page.$$eval('[data-testid=vault-card]', els => els.map(e => (e.getAttribute('data-vault') || '').toLowerCase()));
  for (const v of EXPECT) check(`expected vault listed ${v.slice(0, 10)}`, listed.includes(v));
  const sum = await page.getByTestId('positions-summary').innerText();
  check('summary shows MON + USDC totals and unknown count', /Total \(MON\)/.test(sum) && /Total \(USDC\)/.test(sum) && /Unknown value/.test(sum), sum.replace(/\n/g, ' | ').slice(0, 260));
  check('valuation note honest (no guarantee)', /Nothing here is a promised amount/.test(sum) && !/guarantee/i.test(await page.locator('body').innerText()));
  const first = page.locator('[data-testid=vault-card]').first(); const ft = await first.innerText();
  check('vault card shows owner, agent, paused/active, native MON', /Owner/.test(ft) && /Agent/.test(ft) && /(Paused|Active)/.test(ft) && /MON \(native\)/.test(ft));
  if (EXPECT[0]) { const c = page.locator(`[data-vault="${EXPECT[0]}" i]`); if (await c.count()) { const t = await c.first().innerText(); if (process.env.EXPECT_EMPTY === '1') check('expected vault reads empty and paused after close', /Nothing in this vault/.test(t) && /Paused/.test(t) && /Empty: nothing to withdraw/.test(t), t.replace(/\n/g, ' | ').slice(0, 300)); else check('expected vault shows WMON and aprMON (convertToAssets)', /WMON/.test(t) && /aprMON/.test(t) && /convertToAssets/.test(t), t.replace(/\n/g, ' | ').slice(0, 300)); } }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'positions-owner.png'), fullPage: true });
  await page.getByTestId('showcase-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=showcase-vault]').length >= 13, null, { timeout: 90000 }).catch(() => {});
  const sc = await page.getByTestId('showcase-vault').count();
  check('13 team showcase vaults, read-only, labelled', sc === 13 && (await page.getByTestId('showcase-section').innerText()).includes('PolicyPilot showcase agents (operated by the team)') && (await page.locator('[data-testid=showcase-vault] [data-testid=close-vault]').count()) === 0, `${sc}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'positions-showcase.png'), fullPage: true });
  const closeAll = page.getByTestId('close-all');
  if (await closeAll.isEnabled()) {
    await closeAll.click(); await page.getByTestId('close-steps').waitFor({ timeout: 120000 }).catch(async e => { console.log('MODAL:', await page.getByTestId('sheet').innerText().catch(() => '?')); throw e; });
    const m = await page.getByTestId('close-modal').innerText();
    check('confirm modal lists what moves and to which wallet', m.includes(WATCH) && /What will move/i.test(m) && /emergencyWithdrawAll/.test(m), m.replace(/\n/g, ' | ').slice(0, 400));
    check('modal: staked tokens are not instant MON', !/aprMON/.test(m) || /not instant MON/.test(m));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'positions-close-modal.png'), fullPage: true });
    await page.getByTestId('close-confirm').click();
    await page.getByTestId('close-error').waitFor({ timeout: 120000 });
    check('confirm asks the wallet; a rejection stops with retry/resume and nothing is signed', sent.includes('eth_sendTransaction') && /Retry/.test(await page.getByTestId('close-modal').innerText()));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'positions-close-rejected.png'), fullPage: true });
  } else check('close-all disabled has a reason', (await page.getByTestId('close-all-why').innerText()).length > 10, await page.getByTestId('close-all-why').innerText());
  if (NONOWNER) {
    const o = await open(NONOWNER);
    await o.page.getByTestId('vault-card').first().waitFor({ timeout: 120000 });
    const btn = o.page.locator('[data-testid=vault-card]').first().getByTestId('close-vault');
    const why = await o.page.locator('[data-testid=vault-card]').first().getByTestId('close-why').innerText();
    check('agent (not owner): close disabled and says why', await btn.isDisabled() && /Only the owner/.test(why), why);
    if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'positions-agent-not-owner.png'), fullPage: true });
  }
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) { check('run', false, String(e?.message ?? e).slice(0, 300)); }
await browser.close(); server?.close();
const failed = results.filter(r => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'positions-e2e.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
