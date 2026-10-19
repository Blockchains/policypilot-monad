// Mobile layout check: every route, tab and sub-view at phone widths must not scroll sideways, and no amount
// input may start with a real '0' value. The html/body `overflow-x: clip` backstop is switched OFF while measuring,
// so a pass means the content itself fits (the backstop is not hiding anything).
// Read-only: a mock EIP-6963 wallet answers account/chain calls, forwards reads to the public RPC, and rejects every
// signature. Usable from smoke.mjs (export) or standalone:
//   npm run build && node scripts/mobile-check.mjs        (MOBILE_WIDTHS=320,375,414 MOBILE_SHOTS=/dir MOBILE_WATCH=0x..)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every screen a phone user can reach: [name, hash or path, optional steps run after load]. */
export const SCREENS = [
  ['start', '#/'],
  ['start-earn', '#/', async p => { await p.getByTestId('goal-earn').click(); await p.getByTestId('risk-low').click().catch(() => {}); }],
  ['start-arb', '#/', async p => { await p.getByTestId('goal-arb').click(); await p.getByTestId('risk-balanced').click().catch(() => {}); }],
  ['start-pay', '#/', async p => { await p.getByTestId('goal-pay').click(); }],
  ['momentum-setup-alloc', '#/', async p => { await p.getByTestId('goal-momentum').click(); await p.getByTestId('m-alloc').waitFor({ timeout: 10000 }); }],
  ['momentum-setup-steps', '#/', async (p, see) => {
    await p.getByTestId('goal-momentum').click(); await p.getByTestId('m-alloc').fill('1');
    for (const step of ['assets', 'exec', 'risk', 'review']) {
      if (await p.getByTestId('m-next').isDisabled()) break;
      await p.getByTestId('m-next').click(); await p.waitForTimeout(250); await see(`momentum-setup-${step}`);
    }
  }],
  ['money', '#money'],
  ['activity', '#activity', async p => { await p.locator('[data-testid="act-row"]').first().waitFor({ timeout: 30000 }).catch(() => {}); }],
  ['more', '#more'],
  ['home', '#home'],
  ['home-deploy', '#/deploy'],
  ['home-withdraw', '#/withdraw', async p => { await p.getByText('Amount', { exact: true }).first().click({ timeout: 5000 }).catch(() => {}); }],
  ['home-withdraw-all', '#/withdraw-all'],
  ['home-rules', '#/rules'],
  ['home-vaults', '#/vaults'],
  ['launch', '#launch', async p => { await p.getByTestId('custom-rules').waitFor({ state: 'attached', timeout: 30000 }).catch(() => {}); await p.getByTestId('custom-rules').evaluate(d => { d.open = true; }).catch(() => {}); }],
  ['agents', '#agents', async (p, see) => { await p.getByTestId('super-vaults').waitFor({ timeout: 20000 }).catch(() => {}); await see('agents'); if (await p.getByTestId('super-payments').count()) { await p.getByTestId('super-payments').click(); await see('agents-super-sheet'); } }],
  ['services', '#services'],
  ['policy-positions', '#policy', async p => { await p.getByTestId('positions-view').waitFor({ timeout: 20000 }).catch(() => {}); }],
  ['policy-reference', '#policy', async p => { await p.getByTestId('policy-sub-reference').click(); await p.getByTestId('block').waitFor({ timeout: 20000 }).catch(() => {}); }],
  ['momentum', '#momentum', async (p, see) => { await p.getByTestId('momentum').waitFor({ timeout: 20000 }); await p.getByTestId('m-research').waitFor({ timeout: 20000 }).catch(() => {}); await see('momentum'); if (await p.getByTestId('m-explore').count()) { await p.getByTestId('m-explore').click(); await p.waitForTimeout(400); } }],
  ['research', 'research/'],
];

/** Runs in the page: overflow with the backstop off, the elements that cause it, and amount inputs. */
export async function measure() {
  const st = document.createElement('style'); // Backstops off (html/body and the app shell) so the measurement sees real overflow.
  st.textContent = 'html,body,.overflow-x-clip{overflow-x:visible!important}'; document.head.appendChild(st);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Mobile Chrome widens the layout viewport (and innerWidth) to fit wide content, so measure against the
  // device width (documentElement.clientWidth), which stays at the real screen width.
  const vw = document.documentElement.clientWidth; const se = document.scrollingElement;
  const sw = se.scrollWidth;
  const off = []; const clipped = [];
  const clipsX = el => { const o = getComputedStyle(el).overflowX; return o !== 'visible'; };
  const desc = el => { const id = el.getAttribute('data-testid'); const c = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join('.') : ''; return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ''}${c ? `.${c}` : ''} "${(el.textContent || '').trim().slice(0, 40)}"`; };
  {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect(); if (!r.width || r.right <= vw + 0.5) continue;
      // inside a scroll/clip container that itself fits? then it does not widen the page
      let a = el.parentElement, contained = null, by = null; while (a && a !== document.body) { if (clipsX(a) && a.getBoundingClientRect().right <= vw + 0.5) { contained = getComputedStyle(a).overflowX; by = a; break; } a = a.parentElement; }
      if (contained === 'auto' || contained === 'scroll') continue; // its own deliberate scroll container
      if (contained) { // cut off by an overflow:hidden box: only a problem when it is real content (text or a control)
        if (!(el.textContent || '').trim() && !el.matches('button,a,input,select,img,svg')) continue;
        if (el.closest('[aria-hidden=true]') || r.left >= vw) continue;
        if (el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 0.5 && !clipsX(el.parentElement)) continue;
        clipped.push(`${desc(el)} right=${Math.round(r.right)} (cut by ${by.tagName.toLowerCase()}.${String(by.className).split(/\s+/).slice(0, 3).join('.')} overflow-x:${contained})`); continue;
      }
      const pr = el.parentElement?.getBoundingClientRect(); if (pr && pr.right > vw + 0.5 && el.parentElement !== document.body) continue; // report the outermost offender only
      if (getComputedStyle(el).position === 'fixed' && (r.left >= vw || (r.left <= 0 && r.width >= window.innerWidth - 1))) continue; // follows the (widened) viewport: a symptom, not a cause
      off.push(`${desc(el)} right=${Math.round(r.right)}`);
      if (off.length + clipped.length > 12) break;
    }
  }
  st.remove();
  const amountInputs = [...document.querySelectorAll('input')].filter(i => !['range', 'checkbox', 'radio', 'hidden'].includes(i.type) && (i.inputMode === 'decimal' || i.type === 'number'));
  const zeros = amountInputs.filter(i => i.value.trim() !== '' && Number(i.value) === 0).map(i => i.getAttribute('data-testid') || i.getAttribute('aria-label') || i.id || 'input');
  const small = amountInputs.filter(i => parseFloat(getComputedStyle(i).fontSize) < 16).map(i => i.getAttribute('data-testid') || i.getAttribute('aria-label') || 'input');
  const spinners = amountInputs.filter(i => i.type === 'number').map(i => i.getAttribute('data-testid') || i.getAttribute('aria-label') || 'input');
  // Tap targets: buttons, inputs, selects, summaries and standalone links smaller than 44 px on either side.
  // Links inside running text are exempt (WCAG 2.5.8 inline exception); hidden elements are skipped.
  const taps = [];
  for (const el of document.querySelectorAll('button, [role=button], [role=tab], input:not([type=hidden]), select, summary, a[href]')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (el.closest('[aria-hidden=true]')) continue;
    if (el.matches('a') && el.parentElement && /^(P|LI|SPAN|TD|DD)$/.test(el.parentElement.tagName) && (el.parentElement.textContent || '').trim().length > (el.textContent || '').trim().length + 8) continue;
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') && el.closest('label').getBoundingClientRect().height >= 43.5) continue; // the label is the target
    if (r.height < 43.5 || r.width < 43.5) taps.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const iw = window.innerWidth;
  return { vw, iw, sw: Math.max(sw, iw), off, clipped, taps, inputs: amountInputs.length, zeros, small, spinners };
}

export function walletInit({ watch }) {
  const rpc = async (method, params) => { const r = await fetch('https://rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw j.error; return j.result; };
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [watch];
    if (method === 'eth_chainId') return '0x8f';
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
    if (method === 'wallet_getCapabilities') return {};
    if (/^eth_send|^eth_sign|^personal_|^wallet_sendCalls/.test(method)) { const e = new Error('User rejected the request (mobile check wallet never signs).'); e.code = 4001; throw e; }
    return rpc(method, params ?? []);
  }, on() {}, removeListener() {} };
  const info = { uuid: 'mobile-0001', name: 'Mobile Check Wallet', icon: '', rdns: 'test.mobile.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
  localStorage.setItem('pp.netkey', 'mainnet'); localStorage.setItem('pp.wallet', 'test.mobile.wallet');
}

/** Returns [{ width, screen, ok, sw, off, zeros, ... }] and console/page errors. */
export async function mobileCheck({ browser, site, widths = [320, 375, 414], watch = '0x000000000000000000000000000000000000dEaD', shots = '', screens = SCREENS, settle = 1200 }) {
  const rows = []; const errors = [];
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await ctx.addInitScript(walletInit, { watch });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${width}: ${e.message.slice(0, 160)}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_|net::|429|CORS/i.test(m.text())) errors.push(`${width}: ${m.text().slice(0, 160)}`); });
    for (const [name, where, steps] of screens) {
      const see = async label => {
        await page.waitForTimeout(settle);
        const r = await page.evaluate(measure);
        if (shots) await page.screenshot({ path: path.join(shots, `${width}-${label}.png`), fullPage: false });
        // A cleared amount field must stay empty: no '0' that snaps back and has to be deleted again.
        r.sticky = [];
        const amt = page.locator('input[inputmode=decimal]:visible, input[type=number]:visible');
        for (let i = 0, n = await amt.count(); i < n && i < 16; i++) {
          const el = amt.nth(i);
          try { if (await el.isDisabled()) continue; await el.fill('', { timeout: 2000 }); const v = await el.inputValue({ timeout: 2000 }); if (v !== '') r.sticky.push(`${await el.getAttribute('data-testid') || await el.getAttribute('aria-label') || i}=${JSON.stringify(v)}`); } catch { /* re-rendered away */ }
        }
        rows.push({ width, screen: label, ok: r.sw <= r.vw && !r.clipped.length && !r.zeros.length && !r.sticky.length, ...r });
      };
      try {
        await page.goto(`${site}/${where}`, { waitUntil: 'domcontentloaded' });
        if (where.startsWith('#')) await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);
        if (steps) await steps(page, see);
        if (!steps || !rows.some(r => r.width === width && r.screen === name)) await see(name);
      } catch (e) { rows.push({ width, screen: name, ok: false, sw: -1, vw: width, off: [`step failed: ${String(e.message).split('\n')[0]}`], zeros: [], sticky: [], clipped: [], inputs: 0, small: [], spinners: [] }); }
    }
    await ctx.close();
  }
  return { rows, errors };
}

// Standalone: serve web/out and print a table.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const OUT = path.resolve(HERE, '../out'); const BASE = process.env.NEXT_BASE_PATH ?? '/policypilot-monad';
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.mp4': 'video/mp4' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); }
    p = p.slice(BASE.length) || '/'; let f = path.join(OUT, p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f) && p === '/showcase-143.json') { fetch('https://blockchains.github.io/policypilot-monad/showcase-143.json').then(r => r.ok ? r.text() : Promise.reject(r.status)).then(t => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(t); }, () => { res.writeHead(404); res.end('nf'); }); return; }
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  const SITE = process.env.MOBILE_SITE || (await new Promise(r => server.listen(0, r)), `http://127.0.0.1:${server.address().port}${BASE}`);
  const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core').catch(() => import('/home/box/.local/lib/node_modules/playwright-core/index.mjs'));
  const chromium = pw.chromium ?? pw.default.chromium;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
  const widths = (process.env.MOBILE_WIDTHS || '320,360,375,390,414,768').split(',').map(Number);
  const only = process.env.MOBILE_SCREENS ? process.env.MOBILE_SCREENS.split(',') : null;
  if (process.env.MOBILE_SHOTS) fs.mkdirSync(process.env.MOBILE_SHOTS, { recursive: true });
  const { rows, errors } = await mobileCheck({ browser, site: SITE, widths, watch: process.env.MOBILE_WATCH, shots: process.env.MOBILE_SHOTS || '', screens: only ? SCREENS.filter(s => only.includes(s[0])) : SCREENS });
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.width} ${r.screen}: scrollWidth ${r.sw}/${r.vw}, ${r.inputs} amount input(s)${r.zeros.length ? `, starts at 0: ${r.zeros.join(',')}` : ''}${r.sticky?.length ? `, cleared but not empty: ${r.sticky.join(',')}` : ''}${r.small.length ? `, font<16: ${r.small.join(',')}` : ''}${r.spinners.length ? `, type=number: ${r.spinners.join(',')}` : ''}${r.off.length ? `\n    ${r.off.join('\n    ')}` : ''}${r.clipped?.length ? `\n    clipped: ${r.clipped.join('\n    clipped: ')}` : ''}`);
  console.log(`errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  if (process.env.MOBILE_OUT) fs.writeFileSync(process.env.MOBILE_OUT, JSON.stringify({ rows, errors }, null, 2));
  await browser.close(); server.close();
  process.exit(rows.every(r => r.ok) && !errors.length ? 0 : 1);
}
