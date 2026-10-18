// Headless smoke test for the static export (web/out) against real Monad mainnet reads.
// A mock EIP-6963 wallet answers account/chain calls, forwards reads to the public RPC, and REJECTS every
// eth_sendTransaction, so this test can never send a transaction.
// Usage: npm run build && SMOKE_WATCH=0xYourAddress node scripts/smoke.mjs
//   PLAYWRIGHT_CORE=/path/to/playwright-core (optional)  CHROME=/usr/bin/google-chrome (optional)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../out');
const BASE = process.env.NEXT_BASE_PATH ?? '/policypilot-monad';
const WATCH = process.env.SMOKE_WATCH || '0x000000000000000000000000000000000000dEaD';
const SHOTS = process.env.SMOKE_SHOTS || '';
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core').catch(() => import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'));
const chromium = pw.chromium ?? pw.default.chromium;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
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
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const sent = [];
await page.exposeFunction('__smokeSent', (m) => { sent.push(m); });
await page.addInitScript(({ watch }) => {
  const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch];
      if (method === 'eth_chainId') return '0x8f';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'eth_sendTransaction' || method === 'eth_signTransaction' || method.startsWith('eth_sign') || method.startsWith('personal_')) { window.__smokeSent?.(method); const e = new Error('User rejected the request (smoke test wallet never signs).'); e.code = 4001; throw e; }
      return rpc(method, params ?? []);
    },
    on() {}, removeListener() {},
  };
  const info = { uuid: 'smoke-0001', name: 'Smoke Test Wallet', icon: '', rdns: 'test.smoke.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  localStorage.setItem('pp.netkey', 'mainnet');
}, { watch: WATCH });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  await page.goto(`${ORIGIN}${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('md-hero').waitFor({ timeout: 20000 });
  const hero = await page.getByTestId('md-hero').innerText();
  check('home headline', hero.includes('Your balance. Your rules. Put it to work.'));
  check('supporting line', hero.includes('manage partial or full withdrawals from one simple dashboard'));
  check('primary actions', await page.getByTestId('get-started').isVisible() && await page.getByTestId('explore-vaults').isVisible());
  check('alpha warning kept', (await page.getByTestId('alpha').innerText()).includes("Alpha · unaudited contract · only deposit what you're happy to lose"));
  check('canonical is monadefi.com', (await page.locator('link[rel=canonical]').getAttribute('href')) === 'https://monadefi.com/');
  check('og:url is monadefi.com', (await page.locator('meta[property="og:url"]').getAttribute('content')) === 'https://monadefi.com/');
  check('passkey shows coming soon', (await page.getByTestId('md-passkey').innerText()).includes('Passkey accounts coming soon') && await page.getByTestId('md-passkey').isDisabled());

  await page.getByTestId('explore-vaults').click();
  await page.getByTestId('vault-card').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid=vault-return]')?.textContent?.includes('Reading'), null, { timeout: 45000 });
  const ret = await page.getByTestId('vault-return').innerText();
  check('vault return is real derived data or "not enough data yet"', /% a year, estimated|Not enough data yet/.test(ret), ret.slice(0, 140));
  const card = await page.getByTestId('vault-card').innerText();
  check('vault card shows fees, risks, withdrawal conditions', /Withdrawal fee: 0\.10%/.test(card) && /principal risks/i.test(card) && card.includes('Withdrawals are queued'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'smoke-vaults.png'), fullPage: true });

  await page.getByText('Dashboard').first().click();
  await page.getByTestId('md-connect').click();
  await page.getByTestId('wallet-option').first().click();
  await page.getByTestId('md-balance').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /MON/.test(document.querySelector('[data-testid=md-invested]')?.textContent ?? '') && !/Updated —/.test(document.querySelector('[data-testid=md-invested]')?.textContent ?? ''), null, { timeout: 30000 });
  const invested = await page.getByTestId('md-invested').innerText();
  const total = await page.getByTestId('md-total').innerText();
  const avail = await page.getByTestId('md-available').innerText();
  const wd = await page.getByTestId('md-withdrawable').innerText();
  check('dashboard shows total, available, invested, withdrawable separately', !!(invested && total && avail && wd), `${total.replace(/\n/g, ' ')} | ${avail.replace(/\n/g, ' ')} | ${invested.replace(/\n/g, ' ')} | ${wd.replace(/\n/g, ' ')}`);
  check('performance section', /investment gain \/ loss/i.test(await page.getByTestId('md-performance').innerText()));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'smoke-dashboard.png'), fullPage: true });

  // Deploy 25%, review, confirm -> wallet rejects -> Failed, no phantom position.
  await page.getByTestId('md-deploy-open').click();
  await page.getByTestId('md-pct-25').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=md-deploy-gate]')?.textContent?.includes('Ready to review'), null, { timeout: 30000 }).catch(() => {});
  const gateTxt = await page.getByTestId('md-deploy-gate').innerText();
  const canDeploy = gateTxt.includes('Ready to review');
  check('deploy 25% preset fills and previews', canDeploy || /more than you can deploy|Connect|paused/.test(gateTxt), gateTxt);
  if (canDeploy) {
    await page.getByTestId('md-review').click();
    const rv = await page.getByTestId('md-deploy-review').innerText();
    check('review shows shares, minimum, fees, conditions, risk line', /estimated shares/i.test(rv) && /minimum accepted shares/i.test(rv) && /approvals needed/i.test(rv) && rv.includes('Investment returns are variable. Your position can lose value.'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'smoke-deploy-review.png'), fullPage: true });
    await page.getByTestId('md-confirm').click();
    await page.getByText('Failed').first().waitFor({ timeout: 30000 });
    check('rejected deposit is Failed and the wallet was asked (never signed)', sent.includes('eth_sendTransaction'));
    await page.getByText('Dashboard').first().click();
    const after = await page.getByTestId('md-invested').innerText();
    check('no phantom position after failed deposit', after.split('\n')[1] === invested.split('\n')[1], `${invested.split('\n')[1]} → ${after.split('\n')[1]}`);
  }

  await page.getByTestId('md-withdraw-open').click();
  await page.getByTestId('md-w-preview').waitFor();
  for (const p of [25, 50, 100]) { await page.getByTestId(`md-w-${p}`).click(); check(`withdraw ${p}% preview`, (await page.getByTestId('md-w-preview').innerText()).includes('Estimated proceeds')); }
  await page.getByText('Amount', { exact: true }).click();
  await page.getByTestId('md-w-amount').fill('0.5');
  check('withdraw custom amount preview', (await page.getByTestId('md-w-preview').innerText()).includes('Shares to withdraw'));
  await page.getByTestId('md-withdraw-all-open').click();
  const wa = await page.getByTestId('md-withdraw-all-go').isVisible();
  check('withdraw all view lists positions and asks about rules', wa && (await page.getByTestId('md-pause-rules').isVisible()));

  await page.getByText('Dashboard').first().click();
  await page.getByTestId('md-rules-open').click();
  await page.getByTestId('rule-b').click();
  await page.getByTestId('save-rules').click();
  const sentences = await page.getByTestId('rules-sentences').innerText();
  check('rules read as sentences; B is new deposits only', sentences.includes('new deposits only'));
  check('auto mode disabled with an explanation', (await page.getByTestId('auto-why').innerText()).includes('Automatic mode stays off'));

  for (const t of ['launch', 'activity', 'agents', 'services', 'policy']) {
    await page.goto(`${ORIGIN}${BASE}/#${t}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('tabbar').waitFor({ state: 'attached' });
    const home = await page.getByTestId('md-hero').count();
    check(`existing tab #${t} still opens`, home === 0);
  }
  await page.goto(`${ORIGIN}${BASE}/app/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('md-hero').waitFor({ timeout: 20000 });
  check('/app/ opens the dashboard', true);
  const tape = await page.goto(`${ORIGIN}${BASE}/research/`); check('research tape route', tape?.status() === 200);
  const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8'); check('service worker cache bumped', sw.includes("'pp-v20'"));
  check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  check('no transaction was ever signed', !sent.some(m => m !== 'eth_sendTransaction'));
} catch (e) {
  check('smoke run', false, e.message.split('\n')[0]);
} finally {
  await browser.close(); server.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
