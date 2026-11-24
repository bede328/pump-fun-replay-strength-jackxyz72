// Research scratch: per-coin runup distribution on the dev window (all 3 parts).
// Not part of the bot. Usage: node tools/analyze.ts --kit <kit>
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const kit = get('--kit') ?? '.';
const events: any[] = [];
for (const p of ['part-00000.ndjson.gz', 'part-00001.ndjson.gz', 'part-00002.ndjson.gz']) {
  const raw = gunzipSync(readFileSync(`${kit}/dataset/events/${p}`)).toString('utf8');
  for (const l of raw.split('\n')) if (l.length > 0) events.push(JSON.parse(l));
}
interface C {
  createSlot: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  peak: number;
  peakSlot: number;
  last: number;
  lastSlot: number;
  trades: number;
  buyers: Set<string>;
  devSold: boolean;
  complete: boolean;
  completeSlot: number;
  buys: bigint;
  sells: bigint;
  firstBuySlot: number;
}
const coins = new Map<string, C>();
for (const e of events) {
  if (e.event === 'CreateEvent') {
    coins.set(e.mint, {
      createSlot: e.slot, creator: e.creator, vq0: BigInt(e.virtual_quote_reserves), vt0: BigInt(e.virtual_token_reserves),
      peak: 10000, peakSlot: e.slot, last: 10000, lastSlot: e.slot, trades: 0, buyers: new Set(), devSold: false,
      complete: false, completeSlot: 0, buys: 0n, sells: 0n, firstBuySlot: -1,
    });
  } else if (e.event === 'TradeEvent') {
    const c = coins.get(e.mint);
    if (!c) continue;
    c.trades++;
    const r = Number((BigInt(e.virtual_quote_reserves) * c.vt0 * 10000n) / (BigInt(e.virtual_token_reserves) * c.vq0));
    if (r > c.peak) { c.peak = r; c.peakSlot = e.slot; }
    c.last = r; c.lastSlot = e.slot;
    const sol = BigInt(e.sol_amount);
    if (e.is_buy) {
      c.buys += sol;
      if (e.user !== c.creator) c.buyers.add(e.user);
      if (c.firstBuySlot < 0) c.firstBuySlot = e.slot;
    } else {
      c.sells += sol;
      if (e.user === c.creator) c.devSold = true;
    }
  } else {
    const c = coins.get(e.mint);
    if (c) { c.complete = true; c.completeSlot = e.slot; }
  }
}
const all = [...coins.values()];
console.log(`coins ${all.length} completed ${all.filter((c) => c.complete).length} devSold ${all.filter((c) => c.devSold).length}`);
for (const th of [11000, 12000, 15000, 20000, 30000, 50000, 100000, 200000]) {
  console.log(`peak >= ${(th / 100 - 100).toFixed(0)}%: ${all.filter((c) => c.peak >= th).length}`);
}
for (const th of [11000, 15000, 20000, 50000]) {
  const reach = all.filter((c) => c.peak >= th);
  const endedUp = reach.filter((c) => c.last >= th).length;
  const completed = reach.filter((c) => c.complete).length;
  console.log(`reach +${th / 100 - 100}%: n=${reach.length} still>=th at last trade: ${endedUp} completed: ${completed}`);
}
// Median last/peak ratio for coins that peaked >= +50%
const runners = all.filter((c) => c.peak >= 15000);
const ratios = runners.map((c) => c.last / c.peak).sort((a, b) => a - b);
console.log(`runners +50% n=${runners.length} last/peak median=${ratios.length ? ratios[Math.floor(ratios.length / 2)]!.toFixed(2) : 'n/a'} p25=${ratios.length ? ratios[Math.floor(ratios.length * 0.25)]!.toFixed(2) : 'n/a'} p75=${ratios.length ? ratios[Math.floor(ratios.length * 0.75)]!.toFixed(2) : 'n/a'}`);
// How many coins have >= 20 trades and >= 5 buyers?
console.log(`trades>=20: ${all.filter((c) => c.trades >= 20).length} buyers>=5: ${all.filter((c) => c.buyers.size >= 5).length} buyers>=10: ${all.filter((c) => c.buyers.size >= 10).length}`);
// Completed coins: peak distribution
const comp = all.filter((c) => c.complete);
console.log(`completed peaks: min ${Math.min(...comp.map((c) => c.peak))} median ${comp.map((c) => c.peak).sort((a, b) => a - b)[Math.floor(comp.length / 2)]} max ${Math.max(...comp.map((c) => c.peak))}`);
// Time from create to peak (slots) for +50% runners
const durs = runners.map((c) => c.peakSlot - c.createSlot).sort((a, b) => a - b);
console.log(`create->peak slots for +50%: median ${durs.length ? durs[Math.floor(durs.length / 2)] : 'n/a'} p75 ${durs.length ? durs[Math.floor(durs.length * 0.75)] : 'n/a'} max ${durs.length ? durs[durs.length - 1] : 'n/a'}`);
// Buys vs sells totals
let tb = 0n, ts = 0n;
for (const c of all) { tb += c.buys; ts += c.sells; }
console.log(`total buys ${(Number(tb) / 1e9).toFixed(1)} SOL sells ${(Number(ts) / 1e9).toFixed(1)} SOL`);
// Time from create to graduation for the 35 completed coins.
const comp2 = all.filter((c) => c.complete);
const ttg = comp2.map((c) => c.completeSlot - c.createSlot).sort((a, b) => a - b);
console.log(`create->complete slots: median ${ttg[Math.floor(ttg.length / 2)]} p25 ${ttg[Math.floor(ttg.length * 0.25)]} p75 ${ttg[Math.floor(ttg.length * 0.75)]} min ${ttg[0]} max ${ttg[ttg.length - 1]}`);
for (const w of [30, 100, 300]) {
  for (const th of [12000, 15000, 20000]) {
    const s = all.filter((c) => c.peakSlot - c.createSlot <= w && c.peak >= th);
    const g = s.filter((c) => c.complete).length;
    console.log(`peak>=+${th / 100 - 100}% within ${w} slots: n=${s.length} graduates=${g} rate=${s.length ? (100 * g / s.length).toFixed(1) : '-'}%`);
  }
}
for (const minB of [5, 10, 20]) {
  const s = all.filter((c) => c.buyers.size >= minB && !c.devSold);
  const g = s.filter((c) => c.complete).length;
  console.log(`buyers>=${minB} & !devSold: n=${s.length} graduates=${g} rate=${s.length ? (100 * g / s.length).toFixed(1) : '-'}%`);
}
const s2 = all.filter((c) => c.peak >= 20000 && c.buyers.size >= 10 && !c.devSold);
console.log(`peak>=+100% & buyers>=10 & !devSold: n=${s2.length} graduates=${s2.filter((c) => c.complete).length}`);

// For each graduate: slots from first crossing +20%/+50%/+100% to completion.
console.log('--- graduates: cross->complete gaps (slots) ---');
const cross: Record<string, { c20: number; c50: number; c100: number }> = {};
for (const e of events) {
  if (e.event === 'CreateEvent') {
    cross[e.mint] = { c20: -1, c50: -1, c100: -1 };
  } else if (e.event === 'TradeEvent') {
    const c = coins.get(e.mint);
    const x = cross[e.mint];
    if (!c || !x) continue;
    const r = Number((BigInt(e.virtual_quote_reserves) * c.vt0 * 10000n) / (BigInt(e.virtual_token_reserves) * c.vq0));
    if (x.c20 < 0 && r >= 12000) x.c20 = e.slot;
    if (x.c50 < 0 && r >= 15000) x.c50 = e.slot;
    if (x.c100 < 0 && r >= 20000) x.c100 = e.slot;
  }
}
let catch20 = 0, catch50 = 0, catch100 = 0, tot = 0;
for (const [mint, c] of coins) {
  if (!c.complete) continue;
  const x = cross[mint];
  if (!x) continue;
  tot++;
  const g20 = x.c20 >= 0 ? c.completeSlot - x.c20 : -1;
  const g50 = x.c50 >= 0 ? c.completeSlot - x.c50 : -1;
  const g100 = x.c100 >= 0 ? c.completeSlot - x.c100 : -1;
  if (g20 >= 2) catch20++;
  if (g50 >= 2) catch50++;
  if (g100 >= 2) catch100++;
  if (tot <= 12) console.log(`${mint.slice(0, 8)} complete-create=${c.completeSlot - c.createSlot} gap20=${g20} gap50=${g50} gap100=${g100}`);
}
console.log(`graduates=${tot} catchable(>=2 slots after cross): +20% ${catch20}, +50% ${catch50}, +100% ${catch100}`);

// Survivors: coins still trading at age A with price above create — forward return after that.
for (const A of [300, 1000, 3000]) {
  const surv = all.filter((c) => c.lastSlot - c.createSlot >= A);
  console.log(`alive at age ${A}: ${surv.length} coins`);
}
console.log('--- forward return from first trade at age>=1000 ---');
const fw: number[] = [];
let nPos = 0, nGrad = 0;
for (const c of all) {
  if (c.lastSlot - c.createSlot < 1000) continue;
  // price at age 1000 approximated by last/peak is not available; use peak-after-1000 proxy: skip
  void c;
}
// Direct pass: price at first trade with slot>=create+1000 vs last price.
const priceAt: Record<string, number> = {};
for (const e of events) {
  if (e.event !== 'TradeEvent') continue;
  const c = coins.get(e.mint);
  if (!c) continue;
  if (priceAt[e.mint] === undefined && e.slot - c.createSlot >= 1000) {
    priceAt[e.mint] = Number((BigInt(e.virtual_quote_reserves) * c.vt0 * 10000n) / (BigInt(e.virtual_token_reserves) * c.vq0));
  }
}
const rets: number[] = [];
let above = 0;
for (const [mint, p1000] of Object.entries(priceAt)) {
  const c = coins.get(mint)!;
  if (p1000 >= 10000) above++;
  rets.push(c.last / p1000);
  if (c.complete) nGrad++;
}
rets.sort((a, b) => a - b);
console.log(`coins with a trade at age>=1000: ${rets.length}, price>=create at that point: ${above}, graduates among them: ${nGrad}`);
console.log(`forward last/price@1000: median ${rets.length ? rets[Math.floor(rets.length / 2)]!.toFixed(2) : '-'} p75 ${rets.length ? rets[Math.floor(rets.length * 0.75)]!.toFixed(2) : '-'} share>1.2x: ${rets.length ? (100 * rets.filter((r) => r >= 1.2).length / rets.length).toFixed(1) : '-'}% share>2x: ${rets.length ? (100 * rets.filter((r) => r >= 2).length / rets.length).toFixed(1) : '-'}%`);
