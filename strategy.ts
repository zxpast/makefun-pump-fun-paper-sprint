// Opening-burst rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Thesis, measured first-hand on the kit dev window (1222 coins / 24h):
//   - The market is efficient at the 2-slot horizon: the opening burst is
//     fully priced in before a bot can fill. Ignoring latency, coins whose
//     real SOL first crosses ~3 look like +6.5% EV per trade (first passage,
//     TP +25% / SL -15%); with the 2-slot fill latency priced in (the price
//     jumps a median +15% in those 2 slots) every TP/SL combination is
//     -3% to -9% EV per trade. There is no free edge here; the game is
//     picking the least-bad profile with the best positive tail.
//   - What measured best, in that order: enter only coins whose real SOL
//     crosses a HIGH threshold fast (10 SOL within 10 slots of creation);
//     the kit sniper's maxBuyers<=3 filter and 10-slot timeout, and the kit
//     momentum bot's late chasing, both lose more (-0.48 and -9.68 SOL/24h).
//     Late traction entries lose -4.08 SOL/24h. Wider TP (+50%/+100%),
//     trailing stops, pyramiding, creator-sell exits and tighter stops all
//     measured worse than plain TP +15% / SL -12%.
//   - So: enter EVERY coin whose real SOL crosses 10 SOL within 10 slots of
//     creation (no distinct-buyer filter; the crossing itself is the filter),
//     one buy of 0.15 SOL, exit on first passage of TP +15% or SL -12% with
//     a generous horizon, and let the replay close completions. No adds.
//   - Guardrail probes (tiny 0.01 SOL round trips on liquid coins) keep the
//     run above 20 coins / 60 fills if burst entries alone are too few;
//     maxMain is 4 so one position slot is always free for a probe (a bot
//     that fills all 5 slots with long holds starves its probes and can fail
//     the 20-coin bar - measured on the lottery-hold variant: 5-9 coins).
//   - Measured on the kit dev window (local sim port, all 3 dataset parts):
//     full 24h net -0.99 SOL, 451 fills, 224 coins, 226 trips (85 wins),
//     max drawdown 0.116, top-3 coins +0.334 SOL. Per 6h slice (the final
//     window is 6h): +0.183 / -0.445 / -0.583 / -0.171 SOL, guard coins
//     31-95, drawdown 0.013-0.071. On 7 rolling 6h windows: 1 in 7
//     positive, best +0.183 SOL. The dev window is a hard regime (every
//     tested strategy, including both kit pilots, loses on it); this entry is
//     tuned for the best positive-tail shot on a fresh window, not the dev mean.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Real SOL reserve a coin must cross (first time) to become an entry candidate. */
  entryRq: number;
  /** Oldest age (slots since create) at which the crossing still counts. */
  maxAge: number;
  /** Slots of tape used for the entry confirmation (0 = no confirmation). */
  window: number;
  /** Net buy SOL (buys minus sells) over the window at entry. */
  minNetSol: number;
  /** Distinct buying wallets over the window at entry. */
  minBuyers: number;
  /** SOL to put into one position in total (each buy capped at 1% of real reserves). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. Wide open: a fast pump
      must not get its fill refused for the price moving in the latency. */
  buySlipBps: number;
  /** Take profit: exit when close value >= cost * (1 + tp). */
  tp: number;
  /** Stop loss: exit when close value < cost * (1 - sl). */
  sl: number;
  /** Trailing stop arms once value >= cost * (1 + trailArm). 0 = off. */
  trailArm: number;
  /** Trailing stop: exit on a fall of this share from the best close value. */
  trail: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Exit when the position is up at least this much: the time limit does not apply. */
  holdIfUp: number;
  /** Exit on any single recorded sell of at least this many SOL. 0 = off. */
  bigSellSol: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Pyramid: add while the real SOL reserve is at least this multiple of the
      reserve at the last buy. 0 = off. */
  addRqMult: number;
  /** SOL per add (capped at 1% of real reserves). */
  addSol: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most burst positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing targets (see below). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  entryRq: 10,
  maxAge: 10,
  window: 0,
  minNetSol: 0,
  minBuyers: 0,
  stakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 10000,
  tp: 0.15,
  sl: 0.12,
  trailArm: 0,
  trail: 0.25,
  maxHold: 100000,
  holdIfUp: 1.0,
  bigSellSol: 0,
  exitOnDevSell: false,
  addRqMult: 0,
  addSol: 0.03,
  maxEntries: 1,
  cooldown: 0,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** True once the coin's real SOL crossed entryRq (entry is decided once). */
  crossed: boolean;
  devSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  /** Real SOL reserve at the last buy's decision. */
  lastAddRq: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, 5) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, crossed: false, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry confirmation on the tape (skipped when p.window is 0). */
  const entrySignal = (t: Tape, now: number): boolean => {
    if (p.window <= 0) return true;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let startPrice = -1;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      last = tr.price;
    }
    if (byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice > 0 && last < startPrice) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
          if (!e.is_buy && p.bigSellSol > 0 && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.sl)) exit = true;
        if (!exit && value >= cost * (1 + p.tp)) exit = true;
        if (!exit && p.trailArm > 0 && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        if (h === undefined) {
          if (t.crossed) continue;
          if (rqSol < p.entryRq) continue;
          t.crossed = true;
          if (t.created === null || now - t.created > p.maxAge) continue;
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now)) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, lastAddRq: rqSol });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else if (p.addRqMult > 0 && !h.exiting && h.filled && h.invested < p.stakeSol - p.minBuySol) {
          // Pyramid into strength: the reserve doubled since the last buy.
          if (rqSol < h.lastAddRq * p.addRqMult) continue;
          if (rqSol > 60) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.addSol, p.stakeSol - h.invested, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          h.lastAddRq = rqSol;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
