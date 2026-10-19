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
  // The showcase ledger is published with the Pages deploy, not built into web/out: serve the live copy so loads match production.
  if (!fs.existsSync(f) && p === '/showcase-143.json') { fetch('https://blockchains.github.io/policypilot-monad/showcase-143.json').then(r => r.ok ? r.text() : Promise.reject(r.status)).then(t => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(t); }, () => { res.writeHead(404); res.end('nf'); }); return; }
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
      if (method === 'wallet_getCapabilities') return {}; // like a real wallet; never forwarded to the public RPC
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
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('response', async r => { if (r.status() >= 400 && r.status() !== 429) consoleErrors.push(`(${r.status()} ${r.request().method()} ${r.url().slice(0, 80)} ${(r.request().postData() ?? '').slice(0, 160)} => ${(await r.text().catch(() => '')).slice(0, 160)})`); });

// Start wizard: every offered goal/risk reaches review and a confirm; the smoke wallet rejects the first signature,
// so nothing is sent, and the page shows a plain error with Resume. Not-offered cells are greyed with a reason.
const COMBOS = [['earn', 'low'], ['earn', 'balanced'], ['fast', 'balanced'], ['fast', 'high'], ['arb', 'low'], ['arb', 'balanced'], ['pay', null]];
const NOT_OFFERED = [['earn', 'high'], ['fast', 'low'], ['arb', 'high']];
async function startWizardChecks() {
  await page.goto(`${ORIGIN}${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('start').waitFor({ timeout: 20000 });
  check('start is the default screen', await page.getByTestId('goal-earn').isVisible());
  { const nav = (await page.getByTestId('tabbar').innerText()).replace(/\s+/g, ' ').trim(); check('nav is Start, My money, Activity, More', nav.replace(/ /g, '') === 'StartMymoneyActivityMore', nav); }
  check('start: alpha warning kept', (await page.getByTestId('alpha').innerText()).includes("Alpha · unaudited contract · only deposit what you're happy to lose"));
  // Connect once (the smoke wallet answers eth_requestAccounts).
  await page.getByTestId('connect').click(); await page.getByTestId('wallet-option').first().click();
  await page.waitForFunction(() => !/Connect/.test(document.querySelector('[data-testid=connect]')?.textContent ?? 'Connect'), null, { timeout: 20000 });
  for (const [g, r] of NOT_OFFERED) {
    await page.goto(`${ORIGIN}${BASE}/`, { waitUntil: 'domcontentloaded' }); await page.getByTestId(`goal-${g}`).click();
    const cell = page.getByTestId(`risk-${r}`);
    check(`not offered: ${g}/${r} greyed with a reason`, (await cell.getAttribute('data-offered')) === '0' && (await cell.innerText()).length > 40);
  }
  for (const [g, r] of COMBOS) {
    const id = `${g}/${r ?? '-'}`;
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pp.journey.run.')) localStorage.removeItem(k); });
    await page.goto(`${ORIGIN}${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId(`goal-${g}`).click();
    if (r) await page.getByTestId(`risk-${r}`).click();
    const ex = await page.getByTestId('explain').innerText();
    check(`wizard ${id}: plain fees, risks, withdraw, permissions`, /Fees/i.test(ex) && /What can go wrong/i.test(ex) && /Withdrawing/i.test(ex) && /Permissions/i.test(ex) && !/guarantee/i.test(ex));
    if (g === 'pay') await page.getByTestId('payees').fill('0x000000000000000000000000000000000000dEaD 0.01');
    await page.waitForFunction(() => !document.querySelector('[data-testid=max]')?.hasAttribute('disabled'), null, { timeout: 20000 }).catch(() => {});
    await page.getByTestId('amount').fill(g === 'pay' ? '0.05' : '0.3');
    const blocked = await page.getByTestId('blocker').count();
    if (blocked) { check(`wizard ${id}: amount accepted`, false, await page.getByTestId('blocker').first().innerText()); continue; }
    await page.getByTestId('to-review').click();
    const rv = await page.getByTestId('review').innerText();
    check(`wizard ${id}: review shows amount, gas and total`, /Total from your wallet/.test(rv) && /Network gas/.test(rv) && (r === 'low' && g === 'earn' ? true : /Agent gas/.test(rv)), rv.replace(/\n/g, ' ').slice(0, 160));
    const n0 = sent.length;
    await page.getByTestId('confirm').click();
    await page.getByTestId('start-error').waitFor({ timeout: 45000 });
    const er = await page.getByTestId('start-error').innerText();
    check(`wizard ${id}: wallet asked once, rejection shown plainly, Resume offered`, sent.length === n0 + 1 && /reject|declin|cancel/i.test(er) && await page.getByTestId('resume').isVisible(), `${er.slice(0, 80)} · asked ${sent.slice(n0).join(",")} · resume ${await page.getByTestId('resume').count()}`);
    await page.getByTestId('abandon').click();
  }
  // Max leaves gas: Max on Arbitrage/Low fills an amount the review accepts.
  await page.goto(`${ORIGIN}${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('goal-arb').click(); await page.getByTestId('risk-low').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=max]')?.hasAttribute('disabled'), null, { timeout: 20000 }).catch(() => {});
  if (await page.getByTestId('max').isEnabled()) { await page.getByTestId('max').click(); check('Max fills an amount that passes review (gas left)', (await page.getByTestId('blocker').count()) === 0 && Number(await page.getByTestId('amount').inputValue()) > 0, await page.getByTestId('amount').inputValue()); }
  // Too much: insufficient-MON detection before review.
  await page.getByTestId('amount').fill('9.99'); 
  const bal = await page.evaluate(async (w) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [w, 'latest'] }) }); return Number(BigInt((await r.json()).result)) / 1e18; }, WATCH);
  if (bal < 11) check('insufficient MON caught before review', (await page.getByTestId('blocker').innerText()).includes('You need') && await page.getByTestId('to-review').isDisabled());
  // My money: positions, withdraw slider and Withdraw everything (smoke wallet rejects every send).
  await page.locator('[data-testid=tab-money]:visible, [data-testid=nav-money]:visible').first().click();
  await page.getByTestId('money').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=money]')?.getAttribute('data-discovery') === 'done', null, { timeout: 60000 }).catch(() => {});
  const cards = await page.getByTestId('money-pos').count();
  const held = await page.locator('[data-testid=hold-vault], [data-testid=hold-pool], [data-testid=hold-aprmon], [data-testid=hold-token], [data-testid=hold-other]').count();
  check('my money opens (cards, on-chain holdings or empty state)', cards > 0 || held > 0 || (await page.getByTestId('money-none').count()) === 1, `${cards} position(s), ${held} on-chain row(s)`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'smoke-money.png'), fullPage: true });
  if (cards) {
    const box = page.getByTestId('withdraw-box').first();
    if (await box.count()) {
      for (const x of [25, 50, 100]) { await box.getByTestId(`pct-${x}`).click(); check(`my money: ${x}% selected`, (await box.getByTestId('pct').innerText()) === `${x}%`); }
      await box.getByTestId('pct-25').click();
      const n0 = sent.length; await box.getByTestId('withdraw').click();
      await page.getByTestId('withdraw-error').first().waitFor({ timeout: 45000 }).catch(() => {});
      const agentOnly = (await box.getByTestId('withdraw-note').innerText()).includes('agent-key steps') && !/[1-9] wallet signature/.test(await box.getByTestId('withdraw-note').innerText());
      check('my money: partial withdraw asks the wallet (rejected, error shown)', agentOnly || (sent.length > n0 && (await page.getByTestId('withdraw-error').count()) > 0));
    }
  }
  await page.getByTestId('close-all').click();
  await page.getByTestId('close-modal').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=close-confirm]') || document.querySelector('[data-testid=close-steps]'), null, { timeout: 60000 });
  check('my money: Withdraw everything opens the close-all plan', (await page.getByTestId('close-steps').count()) === 1);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid=tab-more]:visible, [data-testid=nav-more]:visible').first().click();
  const more = await page.getByTestId('more').innerText();
  check('more: Launch, Agents, Policy, Services, MonaDefi reachable', ['Launch', 'Agents', 'Policy', 'Services', 'MonaDefi'].every(x => more.includes(x)));
  check('live indicator', ['live', 'connecting', 'reconnecting'].includes(await page.getByTestId('live').getAttribute('data-state')));
}

try {
  await page.goto(`${ORIGIN}${BASE}/#home`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
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

  // No-limits copy (v4 UnlimitedAgentVault): honest, no stale caps/allowlists, alpha warning and team label kept.
  {
    await page.goto(`${ORIGIN}${BASE}/#launch`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('tabbar').waitFor({ state: 'attached' });
    const alpha = await page.getByTestId('alpha').innerText();
    check('alpha says no spending limits', alpha.includes("Alpha · unaudited contract · only deposit what you're happy to lose") && /no spending limits or allowlists/i.test(alpha) && /move all of a vault/i.test(alpha), alpha.slice(0, 200));
    await page.getByTestId('custom-rules').waitFor({ state: 'attached', timeout: 45000 });
    await page.getByTestId('custom-rules').evaluate(d => { d.open = true; });
    const noLim = await page.getByTestId('no-limits').innerText();
    check('launch: no caps, budget or allowlists', /No per-action cap, no budget, no vault cap, no token caps, no payee allowlist and no service allowlist/.test(noLim));
    check('launch: no cap/budget sliders', (await page.getByTestId('sl-cap').count()) === 0 && (await page.getByTestId('sl-budget').count()) === 0 && (await page.getByTestId('in-deposit').count()) === 1);
    check('dispatch presets: no caps', (await page.getByTestId('fast-dispatch').innerText()).includes('No spending limits'));
    await page.goto(`${ORIGIN}${BASE}/#agents`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('super-vaults').waitFor({ timeout: 20000 });
    await page.getByTestId('super-payments').click();
    const sheet = await page.getByTestId('super-sheet').innerText();
    check('payments super vault: no allowlist / per-payment cap', /no payee allowlist and no per-payment cap/.test(sheet) && !/with a per-payment cap/.test(sheet) && /can move all of the vault/.test(sheet), sheet.slice(0, 200));
    check('super vault: deposit any amount', (await page.getByTestId('super-amt').count()) === 1);
    const body = await page.locator('body').innerText();
    for (const stale of ['1000 MON vault cap', 'Cap and budget sit at', 'with a per-payment cap', '8,000,000', 'Only addresses you approve can ever be paid']) check(`stale copy gone: ${stale}`, !body.includes(stale));
    check('team label kept', body.toLowerCase().includes('PolicyPilot showcase agents (operated by the team)'.toLowerCase()));
    check('no guaranteed-return wording', !/guaranteed (return|yield|profit)/i.test(body));
  }

  // Activity: full indexed history, newest first, live tail, sane RPC budget (counts HTTP requests to Monad RPC hosts).
  {
    const rpcHits = []; const onReq = r => { const u = r.url(); if (/monad\.xyz|monadinfra\.com/.test(u) && r.method() === 'POST') rpcHits.push({ t: Date.now(), body: (r.postData() ?? '').slice(0, 80) }); };
    await page.goto(`${ORIGIN}${BASE}/#activity`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('activity-feed').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="act-row"]').first().waitFor({ timeout: 30000 });
    const total = Number(await page.getByTestId('activity-total').getAttribute('data-total'));
    check('activity: whole history indexed', total > 5000, `${total} transactions`);
    const blocks = await page.locator('[data-testid="act-row"]').evaluateAll(els => els.map(e => Number(e.getAttribute('data-b'))));
    check('activity: newest on top', blocks.length >= 20 && blocks.every((b, i) => i === 0 || blocks[i - 1] >= b), `${blocks.length} rows, top block ${blocks[0]}`);
    await page.waitForFunction(() => document.querySelector('[data-testid="activity-live"]')?.getAttribute('data-live') === '1', null, { timeout: 60000 }).then(() => check('activity: Live indicator turns on after catching up', true), e => check('activity: Live indicator turns on after catching up', false, String(e).slice(0, 120)));
    page.on('request', onReq); const t0 = Date.now(); await page.waitForTimeout(20000); page.off('request', onReq);
    const logsCalls = rpcHits.filter(x => x.body.includes('eth_getLogs')).length;
    check('activity: RPC budget (<= 15 requests / 20 s, ~1 getLogs per tick)', rpcHits.length <= 15 && logsCalls <= 7, `${rpcHits.length} RPC requests in ${Math.round((Date.now() - t0) / 1000)} s, ${logsCalls} eth_getLogs`);
    const fb = await page.getByTestId('act-f-reverted').click().then(() => page.waitForFunction(() => document.querySelectorAll('[data-testid="act-row"][data-s="reverted"]').length >= 10, null, { timeout: 30000 }).catch(() => {})).then(() => page.locator('[data-testid="act-row"]').evaluateAll(els => els.slice(0, 20).map(e => e.getAttribute('data-s'))));
    check('activity: reverted filter shows reverted showcase txs', fb.length >= 10 && fb.every(x => x === 'reverted'), `${fb.length} rows`);
    await page.getByTestId('act-f-all').click();
    const n0 = await page.locator('[data-testid="act-row"]').count();
    await page.getByTestId('act-more').scrollIntoViewIfNeeded(); await page.waitForTimeout(2500);
    check('activity: infinite scroll loads more', (await page.locator('[data-testid="act-row"]').count()) > n0);
    check('activity: explorer link per tx', (await page.locator('[data-testid="act-row"] a[href*="/tx/0x"]').count()) >= n0);
    const body = await page.locator('body').innerText();
    check('activity: alpha warning + team label', body.includes("Alpha · unaudited contract · only deposit what you're happy to lose") && body.toLowerCase().includes('policypilot showcase agents (operated by the team)'));
    check('activity: no guaranteed wording', !/guarantee/i.test(body));
  }

  await startWizardChecks();
  for (const t of ['launch', 'activity', 'agents', 'services', 'policy']) {
    await page.goto(`${ORIGIN}${BASE}/#${t}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('tabbar').waitFor({ state: 'attached' });
    const home = await page.getByTestId('md-hero').count();
    check(`existing tab #${t} still opens`, home === 0);
  }
  {
    await page.goto(`${ORIGIN}${BASE}/#policy`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('positions-view').waitFor({ timeout: 20000 });
    check('policy tab opens Positions', (await page.getByTestId('positions-alpha').innerText()) === "Alpha · unaudited contract · only deposit what you're happy to lose.");
    await page.getByTestId('policy-sub-reference').click();
    await page.getByTestId('block').waitFor({ timeout: 20000 });
    check('reference policy dashboard still reachable', true);
  }
  await page.goto(`${ORIGIN}${BASE}/app/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('md-hero').waitFor({ timeout: 20000 });
  check('/app/ opens the dashboard', true);
  const tape = await page.goto(`${ORIGIN}${BASE}/research/`); check('research tape route', tape?.status() === 200);
  const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8'); check('service worker cache bumped', sw.includes("'pp-v32'"));

  // Passkey flag ON (runtime opt-in), with a Chrome virtual authenticator that supports PRF. Uses localhost
  // because WebAuthn rejects IP-address RP IDs. No funds, no transactions: the new account is empty.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pk = await ctx.newPage();
    pk.on('pageerror', e => errors.push(`passkey: ${e.message}`));
    const LH = ORIGIN.replace('127.0.0.1', 'localhost');
    const cdp = await ctx.newCDPSession(pk);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await pk.goto(`${LH}${BASE}/#home`, { waitUntil: 'domcontentloaded' });
    await pk.getByTestId('md-hero').waitFor({ timeout: 20000 });
    check('passkey flag off by default', !(await pk.getByTestId('md-passkey-panel').count()) && await pk.getByTestId('md-passkey').isDisabled());
    await pk.goto(`${LH}${BASE}/?passkey=1#home`, { waitUntil: 'domcontentloaded' });
    await pk.getByTestId('md-passkey-panel').waitFor({ timeout: 20000 });
    const explain = await pk.getByTestId('md-passkey-explain').innerText();
    check('passkey flag on: explains key in browser, access, recovery, not permission', /private key inside this browser/i.test(explain) && /not permission to move funds/i.test(explain) && /Recovery/i.test(explain) && /Access/i.test(explain));
    check('passkey create needs acknowledgement', await pk.getByTestId('md-passkey').isDisabled());
    await pk.getByTestId('md-passkey-ack').check();
    await pk.getByTestId('md-passkey').click();
    await pk.getByTestId('md-passkey-active').waitFor({ timeout: 30000 });
    const stored = await pk.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('md.passkey.cred.')).map(([, v]) => JSON.parse(v)));
    const addr = stored[0]?.address;
    check('passkey account created via Mera and connected', /^0x[0-9a-fA-F]{40}$/.test(addr ?? '') && (await pk.getByTestId('md-balance').count()) > 0);
    check('only credential metadata stored (no key material)', stored.length === 1 && ['address,createdAt,credentialId,host', 'address,createdAt,credentialId,host,transports'].includes(Object.keys(stored[0]).sort().join()));
    check('passkey: no auto-reconnect saved', await pk.evaluate(() => !localStorage.getItem('pp.wallet')));
    check('passkey: alpha warning kept', (await pk.getByTestId('alpha').innerText()).includes("Alpha · unaudited contract"));
    await pk.getByTestId('md-passkey-lock').click();
    await pk.getByTestId('md-passkey-panel').waitFor({ timeout: 20000 });
    check('passkey lock returns to sign-in (no silent reconnect)', (await pk.getByTestId('md-passkey-active').count()) === 0);
    await pk.getByTestId('md-passkey-ack').check();
    await pk.getByTestId('md-passkey-signin').click();
    await pk.getByTestId('md-passkey-active').waitFor({ timeout: 30000 });
    const again = await pk.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('md.passkey.cred.')).map(([, v]) => JSON.parse(v).address)[0]);
    check('passkey sign-in reproduces the same address', again === addr);
    if (SHOTS) await pk.screenshot({ path: path.join(SHOTS, 'passkey-on.png'), fullPage: false });
    await pk.goto(`${LH}${BASE}/?passkey=0#home`, { waitUntil: 'domcontentloaded' });
    await pk.getByTestId('md-hero').waitFor({ timeout: 20000 });
    await pk.waitForTimeout(500);
    check('?passkey=0 turns it back off', !(await pk.getByTestId('md-passkey-panel').count()) && (await pk.getByTestId('md-passkey').innerText()).includes('coming soon'));
    await ctx.close();
  }
  // My money on a device that never started a position: a wallet with on-chain vaults/aprMON (default: the team deployer,
  // a public address) in a fresh browser profile. Discovery must list them from the chain, show a skeleton (never 0) while
  // it runs, and only show "Nothing here yet" when there is truly nothing.
  {
    const HOLDER = process.env.SMOKE_HOLDER || '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const hp = await ctx.newPage(); const hsent = [];
    await hp.exposeFunction('__smokeSent', (m) => { hsent.push(m); });
    hp.on('pageerror', e => errors.push(`holder: ${e.message}`));
    hp.on('console', m => { if (m.type() === 'error') consoleErrors.push(`holder: ${m.text().slice(0, 160)}`); });
    hp.on('response', r => { if (r.status() >= 400 && r.status() !== 429) consoleErrors.push(`holder: (${r.status()} ${r.request().method()} ${r.url().slice(0, 120)})`); });
    await hp.addInitScript(({ watch }) => {
      const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
      const provider = { request: async ({ method, params }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch];
        if (method === 'eth_chainId') return '0x8f';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'wallet_getCapabilities') return {};
        if (/^eth_send|^eth_sign|^personal_|^wallet_sendCalls/.test(method)) { window.__smokeSent?.(method); const e = new Error('User rejected the request (smoke test wallet never signs).'); e.code = 4001; throw e; }
        return rpc(method, params ?? []);
      }, on() {}, removeListener() {} };
      const info = { uuid: 'smoke-0002', name: 'Smoke Holder Wallet', icon: '', rdns: 'test.smoke.holder' };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce); announce();
      localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.smoke.holder');
    }, { watch: HOLDER });
    await hp.goto(`${ORIGIN}${BASE}/#money`, { waitUntil: 'domcontentloaded' });
    let zeroEarly = false, skeleton = false; const t0 = Date.now();
    for (;;) {
      const st = await hp.evaluate(() => ({ d: document.querySelector('[data-testid=money]')?.getAttribute('data-discovery'), total: document.querySelector('[data-testid=money-total]')?.textContent ?? '', sk: !!document.querySelector('[data-testid=money-total-skeleton]'), none: !!document.querySelector('[data-testid=money-none]') }));
      if (st.sk) skeleton = true;
      if (st.d === 'running' && (/^0 MON/.test(st.total) || st.none)) zeroEarly = true;
      if (st.d === 'done' || Date.now() - t0 > 60_000) break;
      await hp.waitForTimeout(200);
    }
    const done = (await hp.getByTestId('money').getAttribute('data-discovery')) === 'done';
    check('my money (not started on this device): discovery finishes from the chain', done, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check('my money (not started on this device): skeleton while discovering, never 0 or "Nothing here yet" early', skeleton && !zeroEarly);
    const total = Number((await hp.getByTestId('money-total').innerText()).replace(/[^0-9.]/g, ''));
    const rows = await hp.locator('[data-testid=hold-vault], [data-testid=hold-pool], [data-testid=hold-aprmon], [data-testid=hold-token]').count();
    check('my money (not started on this device): lists on-chain holdings with a total > 0', rows > 0 && total > 0 && !(await hp.getByTestId('money-none').count()), `${rows} row(s), total ${total} MON`);
    if (SHOTS) await hp.screenshot({ path: path.join(SHOTS, 'smoke-money-holder.png'), fullPage: true });
    const row = hp.locator('[data-testid=hold-vault], [data-testid=hold-pool], [data-testid=hold-aprmon]').first();
    if (await row.count()) {
      await row.locator('button').first().click();
      const kind = await row.getAttribute('data-testid');
      await hp.getByTestId(`${kind}-pct-25`).first().click();
      check('my money (not started on this device): per-position 25/50/100 withdraw plan', /25%/.test(await hp.getByTestId(`${kind}-note`).first().innerText()) || (await hp.getByTestId(`${kind}-go`).first().innerText()).includes('25%'));
      const n0 = hsent.length; await hp.getByTestId(`${kind}-go`).first().click();
      await hp.getByTestId('withdraw-error').first().waitFor({ timeout: 45000 }).catch(() => {});
      check('my money (not started on this device): withdraw asks the wallet (rejected, error shown)', hsent.length > n0 && (await hp.getByTestId('withdraw-error').count()) > 0);
    }
    await ctx.close();
  }
  // Dashboard RPC budget with a wallet that owns many vaults (default: the team deployer, a public address): every tab,
  // fresh load, < 40 RPC requests in the first 20 s and no 429. Runs scripts/rpc-budget.mjs against this server.
  if (process.env.SMOKE_BUDGET !== '0') {
    const { execFile } = await import('node:child_process'); // async: this process keeps serving web/out meanwhile
    const out = await new Promise(res => execFile(process.execPath, [path.join(HERE, 'rpc-budget.mjs')], { env: { ...process.env, BUDGET_SITE: `${ORIGIN}${BASE}`, BUDGET_WATCH: process.env.SMOKE_BUDGET_WATCH || '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113' }, encoding: 'utf8', timeout: 300_000 }, (_e, stdout) => res(String(stdout ?? ''))));
    for (const l of out.split('\n').filter(x => /^(PASS|FAIL) #/.test(x))) check(`dashboard RPC budget ${l.slice(5, l.indexOf(':'))} (< 40 requests / 20 s, no 429, many-vault wallet)`, l.startsWith('PASS'), l.slice(l.indexOf(':') + 2, l.indexOf(' {')));
    const ag = out.match(/#agents:.*"ownVaults":(\d+)/); check('agents tab lists the many-vault wallet\'s vaults', !!ag && Number(ag[1]) >= 10, ag ? `${ag[1]} own vaults` : 'no agents row');
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  check('no console errors', consoleErrors.filter(x => !/ERR_|net::|429|CORS/i.test(x)).length === 0, consoleErrors.join(' | ').slice(0, 1200));
  check('no transaction was ever signed', !sent.some(m => m !== 'eth_sendTransaction'));
} catch (e) {
  check('smoke run', false, e.message.split('\n')[0]);
} finally {
  await browser.close(); server.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
