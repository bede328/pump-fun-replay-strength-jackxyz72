// Wait-for-Strength + Dip-Sprint for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: never buy a raw launch. A coin earns an entry only after it proves strength —
// its price holds above its create price by `confirmRunupBps` for `confirmHoldSlots` slots,
// with sustained positive net flow from several distinct buyers and no dev sell — or after
// it already proved strength, pulled back (dip-sprint), and flow turns positive again.
// Exits: take-profit, stop-loss vs cost, trailing stop off the best value, a hold cap,
// dev-sell exit and a hard negative-flow exit. A pure function of the batches it is fed:
// no clock, no randomness, no I/O. The hello message gives the caps and seed; each batch
// event arrives per slot and the orders returned here fill two slots later.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a strength entry may be decided. */
  strengthMinAge: number;
  /** Oldest age at which a strength entry may still be decided. */
  strengthMaxAge: number;
  /** Price must hold at least this far (bps) above the create price to count as strength. */
  confirmRunupBps: number;
  /** Slots the price must have held above the confirm level, continuously. */
  confirmHoldSlots: number;
  /** Price may not have run more than this far (bps) above create at strength entry. */
  strengthMaxRunupBps: number;
  /** Net flow window (slots) and what it must show at entry. */
  flowWindow: number;
  minFlowLamports: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Flow acceleration: short window (slots) whose net flow must clear accelMinFlowLamports. */
  flowAccelShort: number;
  accelMinFlowLamports: number;
  /** Distinct buyers in the short acceleration window, at least. */
  minRecentBuyers: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Dip-sprint: peak run-up (bps above create) a coin must have reached first. */
  dipMinPeakRunupBps: number;
  /** Dip-sprint: pullback (bps) from the peak that arms a dip buy. */
  dipPullbackBps: number;
  /** Dip-sprint: price must still sit at least this far (bps) above create. */
  dipFloorBps: number;
  /** Dip-sprint: the peak must be at most this many slots old. */
  dipPeakAge: number;
  /** Dip-sprint: oldest age for a dip entry. */
  dipMaxAge: number;
  /** Dip-sprint: short-window net flow that must be positive to buy the dip. */
  dipFlowWindow: number;
  dipMinFlowLamports: number;
  /** Dip-sprint: distinct buyers in the dip flow window, at least. */
  dipMinRecentBuyers: number;
  /** Pyramid adds: buys after the first one, each on a later batch, while the coin keeps rising. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addLamports: number;
  /** An add needs the recent net flow at least this. */
  addMinFlowLamports: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  strengthMinAge: 6,
  strengthMaxAge: 900,
  confirmRunupBps: 5000,
  confirmHoldSlots: 20,
  strengthMaxRunupBps: 8000,
  flowWindow: 30,
  minFlowLamports: 50_000_000,
  minBuyers: 4,
  minTrades: 5,
  maxBigSellBps: 10_000,
  flowAccelShort: 10,
  accelMinFlowLamports: 50_000_000,
  minRecentBuyers: 3,
  minRealSol: 300_000_000,
  maxRealSol: 50_000_000_000,
  skipDevSold: true,
  stakeLamports: 150_000_000,
  minBuyLamports: 20_000_000,
  buySlippageBps: 10_000,
  dipMinPeakRunupBps: 100_000,
  dipPullbackBps: 8000,
  dipFloorBps: 20_000,
  dipPeakAge: 400,
  dipMaxAge: 1500,
  dipFlowWindow: 12,
  dipMinFlowLamports: 100_000_000,
  dipMinRecentBuyers: 3,
  maxAdds: 2,
  addStepBps: 1000,
  addDelay: 2,
  addLamports: 150_000_000,
  addMinFlowLamports: 0,
  tpBps: 4000,
  slBps: 2000,
  trailArmBps: 1500,
  trailBps: 800,
  maxHold: 200,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 100_000_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  /** Largest single non-creator sell, as bps of real SOL before it. */
  bigSellBps: bigint;
  soldByOthers: bigint;
  bought: bigint;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Slot from which the price has held above the confirm level, or null. */
  aboveSince: number | null;
  /** Best price ratio (bps vs create) seen so far, and the slot it was seen. */
  peakBps: bigint;
  peakSlot: number;
  /** Price ratio (bps vs create) at the previous batch, for dip recovery checks. */
  prevBps: bigint | null;
  /** Entry already taken (strength or dip); after an exit the coin is done for good. */
  entered: boolean;
  done: boolean;
  complete: boolean;
  /** Pyramid state: decision price (bps vs create) of the last buy, its slot, adds used. */
  lastBuyBps: bigint;
  lastBuySlot: number;
  addsUsed: number;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Current price vs the create price, in bps (10000 = flat). */
function priceBps(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint): bigint {
  if (vt <= 0n || vq0 <= 0n) return 0n;
  return (vq * vt0 * BPS) / (vt * vq0);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set(),
          devSold: false,
          bigSellBps: 0n,
          soldByOthers: 0n,
          bought: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          aboveSince: null,
          peakBps: 10_000n,
          peakSlot: e.slot,
          prevBps: null,
          entered: false,
          done: false,
          complete: false,
          lastBuyBps: 0n,
          lastBuySlot: 0,
          addsUsed: 0,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
        // Keep only recent ticks (flow windows never exceed 120 slots).
        let drop = 0;
        while (drop < c.recent.length && c.recent[drop]!.slot <= batch.slot - 150) drop++;
        if (drop > 0) c.recent.splice(0, drop);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last `window` slots. Pure: readEvents already prunes old ticks. */
  function flow(c: Coin, slot: number, window: number): { net: bigint; buyers: number } {
    const from = slot - window;
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.slot <= from) continue;
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Refresh per-coin price state from the latest known reserves, then exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot, P.flowWindow).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: strength first, dip-sprint second. One entry per coin, ever.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (!c.entered && age > Math.max(P.strengthMaxAge, P.dipMaxAge)) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const bps = priceBps(vq, vt, c.vq0, c.vt0);
        // Track strength hold + peak while the coin is watched.
        if (bps >= BPS + BigInt(P.confirmRunupBps)) {
          if (c.aboveSince === null) c.aboveSince = state.slot;
        } else {
          c.aboveSince = null;
        }
        if (bps > c.peakBps) {
          c.peakBps = bps;
          c.peakSlot = state.slot;
        }
        const prev = c.prevBps;
        c.prevBps = bps;

        // Pyramid add: the coin keeps making new highs on positive flow — buy
        // another 1%-of-reserve tranche (the cap grows with the curve, so a real
        // runner gets a much bigger total stake than a single first buy allows).
        if (c.entered) {
          if (
            state.positions.has(c.mint) &&
            !selling.has(c.mint) &&
            !hasPendingBuy(state, c.mint) &&
            c.addsUsed < P.maxAdds &&
            state.slot - c.lastBuySlot >= P.addDelay &&
            bps >= c.lastBuyBps + BigInt(P.addStepBps) &&
            !c.devSold
          ) {
            const fl = flow(c, state.slot, P.flowWindow);
            if (fl.net >= BigInt(P.addMinFlowLamports)) {
              const rq = curve.real_quote_reserves;
              if (rq >= BigInt(P.minRealSol) && rq <= BigInt(P.maxRealSol)) {
                const maxBuy = state.maxBuyLamports(c.mint);
                const addAmt = BigInt(P.addLamports) < maxBuy ? BigInt(P.addLamports) : maxBuy;
                if (addAmt >= minBuy && free >= addAmt + tx) {
                  orders.push({ side: 'buy', mint: c.mint, quote_lamports: addAmt, max_slippage_bps: P.buySlippageBps });
                  free -= addAmt + tx;
                  c.addsUsed += 1;
                  c.lastBuyBps = bps;
                  c.lastBuySlot = state.slot;
                }
              }
            }
          }
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }

        let want = false;
        // (1) Wait-for-strength: price held above the confirm level long enough,
        // with sustained positive flow and enough distinct buyers.
        if (!want && age >= P.strengthMinAge && age <= P.strengthMaxAge) {
          const heldLong = c.aboveSince !== null && state.slot - c.aboveSince >= P.confirmHoldSlots;
          if (heldLong && bps <= BPS + BigInt(P.strengthMaxRunupBps) && c.bigSellBps <= BigInt(P.maxBigSellBps)) {
            const fl = flow(c, state.slot, P.flowWindow);
            let accelOk = true;
            if (P.flowAccelShort > 0) {
              const short = flow(c, state.slot, P.flowAccelShort);
              accelOk = short.net >= BigInt(P.accelMinFlowLamports) && short.buyers >= P.minRecentBuyers;
            }
            if (accelOk && fl.net >= BigInt(P.minFlowLamports) && fl.buyers >= P.minBuyers && c.trades >= P.minTrades) want = true;
          }
        }
        // (2) Dip-sprint: proved strength, pulled back from its peak, still above
        // the floor, peak is fresh, and short-window flow is buying again.
        if (!want && age <= P.dipMaxAge && c.peakBps >= BPS + BigInt(P.dipMinPeakRunupBps)) {
          const pulledBack = bps <= c.peakBps - BigInt(P.dipPullbackBps);
          const aboveFloor = bps >= BPS + BigInt(P.dipFloorBps);
          const peakFresh = state.slot - c.peakSlot <= P.dipPeakAge;
          const recovering = prev !== null && bps >= prev;
          if (pulledBack && aboveFloor && peakFresh && recovering) {
            const fl = flow(c, state.slot, P.dipFlowWindow);
            if (fl.net >= BigInt(P.dipMinFlowLamports) && fl.buyers >= P.dipMinRecentBuyers && c.trades >= P.minTrades) want = true;
          }
        }
        if (!want) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.entered = true;
        c.lastBuyBps = bps;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}
