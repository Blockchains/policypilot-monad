// RPC budget check for the dashboard with a wallet that owns many vaults connected (default: the team deployer, a public address).
// Serves web/out, connects a mock EIP-6963 wallet that rejects every signature, opens each tab fresh and counts HTTP POSTs to
// Monad RPC hosts (and 429 answers) in the first WINDOW_MS after navigation, page load included.
// Usage: npm run build && node scripts/rpc-budget.mjs   (BUDGET_WATCH=0x.. BUDGET_TABS=launch,agents BUDGET_MAX=40 WINDOW_MS=20000)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../out');
const BASE = process.env.NEXT_BASE_PATH ?? '/policypilot-monad';
const WATCH = process.env.BUDGET_WATCH || '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
const TABS = (process.env.BUDGET_TABS || 'launch,agents,activity,policy,home').split(',');
const MAX = Number(process.env.BUDGET_MAX || 40);
const WINDOW = Number(process.env.WINDOW_MS || 20000);
const SITE = process.env.BUDGET_SITE || '';
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core').catch(() => import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'));
const chromium = pw.chromium ?? pw.default.chromium;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
let ORIGIN = SITE, server;
if (!SITE) {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); }
    p = p.slice(BASE.length) || '/';
    let f = path.join(OUT, p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  ORIGIN = `http://127.0.0.1:${server.address().port}${BASE}`;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
const rows = []; let fail = false;
for (const tab of TABS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript(({ watch }) => {
    const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch];
        if (method === 'eth_chainId') return '0x8f';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction' || method === 'wallet_sendCalls' || method.startsWith('eth_sign') || method.startsWith('personal_')) { const e = new Error('User rejected the request (budget test wallet never signs).'); e.code = 4001; throw e; }
        return rpc(method, params ?? []);
      },
      on() {}, removeListener() {},
    };
    const info = { uuid: 'budget-0001', name: 'Budget Test Wallet', icon: '', rdns: 'test.budget.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
    localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.budget.wallet');
  }, { watch: WATCH });
  const hits = []; let n429 = 0; const methods = {}; const dbg = {}; const sizes = [];
  page.on('request', r => { if (/monad\.xyz|monadinfra\.com/.test(r.url()) && r.method() === 'POST') { hits.push(r); let m = '?'; try { m = JSON.parse(r.postData() ?? '{}').method; if (m === 'eth_call') { const d = JSON.parse(r.postData()).params?.[0]?.data ?? ''; m = d.startsWith('0x82ad56cb') ? 'eth_call(multicall)' : 'eth_call'; if (process.env.BUDGET_DEBUG && m === 'eth_call') { const p0 = JSON.parse(r.postData()).params?.[0] ?? {}; const k = `${p0.to}:${d.slice(0, 10)}:${p0.from ? 'from' : ''}`; dbg[k] = (dbg[k] ?? 0) + 1; } if (process.env.BUDGET_DEBUG && m === 'eth_call(multicall)') sizes.push(d.length); } } catch { /* */ } methods[m] = (methods[m] ?? 0) + 1; } });
  page.on('response', r => { if (/monad\.xyz|monadinfra\.com/.test(r.url()) && r.status() === 429) n429++; });
  await page.goto(`${ORIGIN}/#${tab === 'home' ? '/' : tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(WINDOW);
  const conn = await page.getByTestId('connect').innerText().catch(() => '');
  const extra = {};
  if (tab === 'agents') extra.ownVaults = await page.locator('[data-testid="own-vault"]').count();
  if (tab === 'launch') extra.vaultChoices = await page.locator('[data-testid="vault-choice"]').count();
  if (tab === 'policy') extra.positionCards = await page.locator('[data-testid="vault-card"]').count();
  const ok = hits.length < MAX && n429 === 0;
  if (!ok) fail = true;
  rows.push({ tab, requests: hits.length, n429, connected: /0x/i.test(conn), methods, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} #${tab}: ${hits.length} RPC requests in ${WINDOW / 1000} s, ${n429} × 429, connected=${/0x/i.test(conn)} ${JSON.stringify(extra)} ${JSON.stringify(methods)}`);
  if (process.env.BUDGET_DEBUG) console.log('  eth_call targets', JSON.stringify(Object.entries(dbg).sort((a, b) => b[1] - a[1]).slice(0, 15)), 'multicall calldata sizes', sizes.join(','));
  await ctx.close();
}
await browser.close(); server?.close();
if (process.env.BUDGET_OUT) fs.writeFileSync(process.env.BUDGET_OUT, JSON.stringify({ watch: WATCH, windowMs: WINDOW, max: MAX, origin: SITE || 'local build', at: new Date().toISOString(), rows }, null, 2));
process.exit(fail ? 1 : 0);
