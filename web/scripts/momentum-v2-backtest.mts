// v1 vs v2 backtest on the committed real hourly candles (no network). Usage: node --experimental-strip-types scripts/momentum-v2-backtest.mts
import fs from 'node:fs'; import path from 'node:path';
import { ASSETS, EXITS_V1, RULES_V1, backtest, completed, metrics, type Candle } from '../src/lib/momentumCore.ts';
import { compareV1V2 } from '../src/lib/momentumV2.ts';
const D = path.join(path.dirname(new URL(import.meta.url).pathname), '../public/momentum/143');
const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const idx = rd('candles/index.json'); const bt = rd('backtest.json'); const now = Math.floor(Date.now() / 1000);
const out: any = {};
for (const a of ASSETS) {
  const cs: Candle[] = completed((idx.series[`${a.symbol}-MON`]?.months ?? []).flatMap((m: string) => rd(`candles/${a.symbol}-MON/${m}.json`)), now);
  const costs = bt.assets[a.symbol]?.costs ?? { roundTripPct: 1, gasRoundTripMon: 0.03, sizeMon: 10 };
  const t0 = Date.now();
  const r = compareV1V2(cs, EXITS_V1, costs, (f, t) => backtest(cs, RULES_V1, EXITS_V1, costs, f, t), x => metrics(x, costs, null));
  out[a.symbol] = { candles: cs.length, days: +(cs.length / 24).toFixed(1), costs, ...r };
  console.log(a.symbol, cs.length, 'candles', `${((Date.now() - t0) / 1000).toFixed(1)}s`, 'rt', costs.roundTripPct);
  for (const [k, v] of Object.entries<any>(r)) console.log('  ', k.padEnd(12), 'v1', JSON.stringify(v.v1), '\n   ', ''.padEnd(12), 'v2', JSON.stringify(v.v2));
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
