// Screenshots of the Start wizard, My money and More at mobile (390px) first, then desktop.
// Usage: npm run build && node scripts/journey-shots.mjs OUT_DIR [SITE_URL]   (no SITE_URL = serve web/out)
// The mock wallet rejects every signature, so nothing can be sent.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const OUT = path.resolve(HERE, '../out'); const BASE = '/policypilot-monad';
const DIR = process.argv[2] || '/tmp/shots'; fs.mkdirSync(DIR, { recursive: true });
const WATCH = process.env.SHOTS_WATCH || '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
const pw = await import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'); const chromium = pw.chromium ?? pw.default.chromium;
let SITE = process.argv[3];
if (!SITE) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); } p = p.slice(BASE.length) || '/'; let f = path.join(OUT, p); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
  await new Promise(r => server.listen(0, r)); SITE = `http://127.0.0.1:${server.address().port}${BASE}`;
}
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
const errors = [];
for (const [name, vp] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1, isMobile: name === 'mobile', hasTouch: name === 'mobile', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`)); page.on('console', m => m.type() === 'error' && errors.push(`${name} console: ${m.text().slice(0, 140)}`));
  await page.addInitScript(({ watch }) => {
    const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
    const provider = { request: async ({ method, params }) => { if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch]; if (method === 'eth_chainId') return '0x8f'; if (method.startsWith('wallet_')) return null; if (/^eth_send|^eth_sign|^personal_/.test(method)) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; } return rpc(method, params ?? []); }, on() {}, removeListener() {} };
    const info = { uuid: 'shots-1', name: 'Screenshot Wallet', icon: '', rdns: 'test.shots.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.shots.wallet');
  }, { watch: WATCH });
  const shot = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(DIR, `${name}-${n}.png`), fullPage: true }); };
  await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' }); await page.getByTestId('start').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /0x/.test(document.querySelector('[data-testid=connect]')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  await shot('1-start-goal');
  await page.getByTestId('goal-arb').click(); await shot('2-risk-arb');
  await page.getByTestId('risk-low').click(); await page.getByTestId('amount').fill('0.5'); await shot('3-amount-arb-low');
  await page.getByTestId('to-review').click(); await shot('4-review-arb-low');
  await page.getByTestId('confirm').click(); await page.getByTestId('start-error').waitFor({ timeout: 40000 }).catch(() => {}); await shot('5-run-rejected');
  await page.getByTestId('abandon').click().catch(() => {});
  await page.locator('[data-testid=tab-money]:visible, [data-testid=nav-money]:visible').first().click(); await page.getByTestId('money').waitFor({ timeout: 20000 }).catch(() => {}); await page.waitForTimeout(4000); await shot('6-my-money');
  await page.locator('[data-testid=tab-more]:visible, [data-testid=nav-more]:visible').first().click(); await page.getByTestId('more').waitFor({ timeout: 20000 }); await shot('7-more');
  await ctx.close();
}
console.log(JSON.stringify({ dir: DIR, errors }));
await browser.close(); process.exit(0);
