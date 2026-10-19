// Read-only Playwright pass over the live Momentum screens, mobile and desktop. The test wallet only exposes an address
// (no key, sends are refused). Records console errors, failed requests and RPC requests per screen (20 s windows).
//   SITE=https://blockchains.github.io/policypilot-monad OUT=/tmp/m-shots WATCH=0x.. node scripts/momentum-shots.mjs
import fs from 'node:fs'; import path from 'node:path';
const E = process.env; const SITE = E.SITE || 'https://blockchains.github.io/policypilot-monad'; const OUT = E.OUT || '/tmp/m-shots'; fs.mkdirSync(OUT, { recursive: true });
const WATCH = E.WATCH || '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
const pw = await import(E.PLAYWRIGHT_CORE || '/home/box/.local/lib/node_modules/playwright-core/index.mjs'); const chromium = pw.chromium ?? pw.default.chromium;
const browser = await chromium.launch({ headless: true, executablePath: E.CHROME || '/usr/bin/google-chrome' });
const report = {};
for (const [kind, opt] of [['mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }], ['desktop', { viewport: { width: 1366, height: 900 } }]]) {
  const ctx = await browser.newContext({ ...opt, serviceWorkers: 'block' }); const page = await ctx.newPage();
  const errors = []; let rpc = 0;
  page.on('request', r => { if (/rpc\d?\.monad\.xyz|monadinfra/.test(r.url())) rpc++; });
  page.on('response', r => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url().slice(0, 160)}`));
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`)); page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
  await page.addInitScript(({ addr }) => {
    const rpcf = async (method, params) => { const r = await fetch('https://rpc.monad.xyz/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
      if (method === 'eth_chainId') return '0x8f'; if (method === 'net_version') return '143'; if (method.startsWith('wallet_')) return null;
      if (method === 'eth_sendTransaction' || /^eth_sign|^personal_/.test(method)) { const e = new Error('read-only test wallet'); e.code = 4001; throw e; }
      return rpcf(method, params ?? []);
    }, on() {}, removeListener() {} };
    const info = { uuid: 'm-shots', name: 'Read-only', icon: '', rdns: 'test.momentum.ro' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.momentum.ro');
  }, { addr: WATCH });
  const shots = []; const budget = {};
  const shot = async (name, full = true) => { const f = path.join(OUT, `${kind}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f, fullPage: full }); shots.push(f); };
  const T = id => page.getByTestId(id);
  const win = async (name) => { const r0 = rpc; await page.waitForTimeout(20000); budget[name] = rpc - r0; };
  await page.goto(`${SITE}/#momentum`, { waitUntil: 'domcontentloaded' }); await T('momentum').waitFor({ timeout: 60000 });
  await win('momentum'); await shot('momentum', false); await shot('momentum-full');
  if (await T('m-dashboard').count()) { await T('m-dashboard').scrollIntoViewIfNeeded(); await shot('dashboard', false); }
  if (await T('m-explore-more').count()) { await T('m-explore-more').click(); await page.waitForTimeout(1500); }
  for (const id of ['m-watchlist', 'm-decisions', 'm-research', 'm-roadmap']) if (await T(id).count()) { await T(id).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(400); await shot(id.slice(2), false); }
  await page.goto(`${SITE}/`, { waitUntil: "domcontentloaded" }); await T('goal-momentum').waitFor({ timeout: 60000 }); await T('goal-momentum').scrollIntoViewIfNeeded(); await shot('start-goal', false);
  await T('goal-momentum').click(); await T('m-alloc').waitFor(); await T('m-alloc').fill('1'); await win('setup'); await shot('setup-1-allocate', false);
  for (const s of ['2-assets', '3-execution', '4-limits', '5-review']) { await T('m-next').click(); await page.waitForTimeout(800); await shot(`setup-${s}`); }
  report[kind] = { shots, budget, errors: [...new Set(errors)] }; await ctx.close();
}
await browser.close(); fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 1));
