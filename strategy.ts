// Surge Catcher — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea: most pump.fun coins spike at launch and then bleed back to their
// create price, so blind buying loses to fees. The money is in the tail: the
// few coins that keep being bought after the launch spike, and the brief
// surges inside the first minutes. This bot only buys a coin when fresh
// buying is still arriving (launch window or a mature runner window), sizes
// every entry the same small stake, never pyramids, and exits fast — take
// profit, a tight stop, a trailing stop once it is up, a time limit, or the
// moment the creator sells. A tiny probe mechanism keeps the run above the
// guardrail floors (round trips on enough distinct coins) without chasing.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O. Iteration is only over insertion-ordered
// maps fed by the batch stream, so two executions produce byte-identical
// action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  // --- launch entries: age in slots since the CreateEvent ---
  launchMaxAge: number;
  launchMinRq: number; // real SOL at decision, low/high
  launchMaxRq: number;
  launchMinBuyers: number; // distinct non-creator buyers seen before entry
  launchMaxBuyers: number;
  launchMaxDevBuy: number; // creator's own buys in the create slot (SOL)
  launchSkipDevSold: boolean;
  launchStake: number; // SOL per position
  // --- runner entries: mature coins still being bought ---
  runnerMinAge: number;
  runnerMaxAge: number;
  runnerWindow: number; // slots of tape the signal reads
  runnerMinNet: number; // net SOL inflow (buys minus sells) over the window
  runnerMinBuyers: number; // distinct buyers over the window
  runnerMinUp: number; // price rise over the window (fraction)
  runnerNearHigh: number; // price now as a share of the window high
  runnerMinRq: number;
  runnerMaxRq: number;
  runnerStake: number;
  // --- exits (same engine for both entry kinds) ---
  takeProfit: number; // sell when value >= cost * (1 + takeProfit)
  stopLoss: number; // sell when value <= cost * (1 - stopLoss)
  trailArm: number; // arm the trailing stop once value >= cost * (1 + trailArm)
  trail: number; // sell when value < peak * (1 - trail)
  maxHold: number; // slots; 0 = no time exit
  holdIfUp: number; // time exit waived while value >= cost * (1 + holdIfUp)
  exitOnDevSell: boolean; // sell the moment the creator sells while held
  fadeWindow: number; // sell when net flow over this window < -fadeNet; 0 = off
  fadeNet: number;
  // --- sizing / pacing ---
  maxMain: number; // most runner+launch positions open at once (rest is for probes)
  maxExposure: number; // most SOL at cost across all positions at once
  minBuy: number; // smallest buy worth sending (SOL)
  buySlipBps: number; // slippage on buys; sells always go out at 10000
  cooldown: number; // slots to wait after an exit before the same coin may be bought again
  maxEntries: number; // most entries per coin over the run
  // --- guardrail probes: tiny round trips when the fill/coin pace lags ---
  probeSol: number;
  probeTargetCoins: number;
  probeTargetFills: number;
  paceSecs: number; // block seconds the pace is measured over
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  launchMaxAge: 0,
  launchMinRq: 4,
  launchMaxRq: 10,
  launchMinBuyers: 0,
  launchMaxBuyers: 1,
  launchMaxDevBuy: 0.5,
  launchSkipDevSold: true,
  launchStake: 0.1,
  runnerMinAge: 1000000000, // runner entries disabled: chasing mature coins loses
  runnerMaxAge: 900,
  runnerWindow: 40,
  runnerMinNet: 0.8,
  runnerMinBuyers: 5,
  runnerMinUp: 0.04,
  runnerNearHigh: 0.92,
  runnerMinRq: 2,
  runnerMaxRq: 40,
  runnerStake: 0.1,
  takeProfit: 0.4,
  stopLoss: 0.02,
  trailArm: 0.1,
  trail: 0.15,
  maxHold: 12,
  holdIfUp: 0.05,
  exitOnDevSell: true,
  fadeWindow: 20,
  fadeNet: 1,
  maxMain: 4,
  maxExposure: 6,
  minBuy: 0.01,
  buySlipBps: 10000,
  cooldown: 150,
  maxEntries: 1, // one entry per coin per run: in a resampled window a coin can
  // appear twice, and re-entering it only pays its fees twice
  probeSol: 0.01,
  probeTargetCoins: 22,
  probeTargetFills: 0,
  paceSecs: 21600,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Ledger {
  created: number | null;
  creator: string | null;
  ticks: Tick[];
  devBuy: number; // creator buys in the create slot (SOL)
  devSold: boolean;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number; // best close value seen (SOL)
  invested: number; // SOL sent in buys (fees included)
  exiting: boolean;
  filled: boolean;
  devSoldAtOpen: boolean;
  lastValue: number;
}

export function createRunner(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Ledger>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.runnerWindow, p.fadeWindow) + 5;

  const bookOf = (mint: Pubkey): Ledger => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: null, ticks: [], devBuy: 0, devSold: false, entries: 0, lastExit: -1e12 };
      books.set(mint, b);
    }
    return b;
  };

  /** Net SOL (buys minus sells) over the last `w` slots of a ledger's tape. */
  const netFlow = (b: Ledger, now: number, w: number): number => {
    let net = 0;
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const t = b.ticks[i]!;
      if (t.slot <= now - w) break;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  /** What selling `tokens` against (vq, vt) would pay after curve fees (SOL). */
  const sellValue = (tokens: number, vq: number, vt: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    return ((tokens * vq) / (vt + tokens)) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
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
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (b.creator !== null && e.user === b.creator) {
            if (e.is_buy && e.slot === b.created) b.devBuy += sol;
            if (!e.is_buy) b.devSold = true;
          }
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.ticks.length && b.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) b.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // ---- 1. Exits on held positions ----
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const b = bookOf(mint);
            if (h.filled) b.lastExit = now;
            else b.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = sellValue(tokens, vq, vt) / LAMPORTS - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        const b = bookOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value < h.peak * (1 - p.trail)) exit = true;
        if (!exit && p.maxHold > 0 && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && p.exitOnDevSell && b.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit && p.fadeWindow > 0 && netFlow(b, now, p.fadeWindow) < -p.fadeNet) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // ---- 2. Probe sells: dump the probe as soon as its buy has landed ----
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

      // ---- 3. Entries ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const b = books.get(mint)!;
        if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        let stake = 0;
        if (b.created !== null) {
          const age = now - b.created;
          if (age <= p.launchMaxAge) {
            // Launch entry: young coin, creator not dumping, few enough distinct buyers.
            if (rqSol < p.launchMinRq || rqSol > p.launchMaxRq) continue;
            if (p.launchSkipDevSold && b.devSold) continue;
            if (b.devBuy > p.launchMaxDevBuy) continue;
            let buyers = 0;
            const seen = new Set<string>();
            for (const t of b.ticks) {
              if (t.buy && t.user !== b.creator && !seen.has(t.user)) {
                seen.add(t.user);
                buyers++;
              }
            }
            if (buyers < p.launchMinBuyers || buyers > p.launchMaxBuyers) continue;
            stake = p.launchStake;
          } else if (age >= p.runnerMinAge && age <= p.runnerMaxAge) {
            // Runner entry: still being bought, holding near its window high.
            if (rqSol < p.runnerMinRq || rqSol > p.runnerMaxRq) continue;
            const from = now - p.runnerWindow;
            let net = 0;
            let firstPrice = -1;
            let high = 0;
            let last = 0;
            const buyers = new Set<string>();
            for (const t of b.ticks) {
              if (t.slot <= from) continue;
              if (firstPrice < 0) firstPrice = t.price;
              if (t.buy) {
                net += t.sol;
                buyers.add(t.user);
              } else {
                net -= t.sol;
              }
              if (t.price > high) high = t.price;
              last = t.price;
            }
            if (firstPrice <= 0 || last <= 0) continue;
            if (net < p.runnerMinNet) continue;
            if (buyers.size < p.runnerMinBuyers) continue;
            if (last / firstPrice - 1 < p.runnerMinUp) continue;
            if (last < high * p.runnerNearHigh) continue;
            if (price <= 0) continue;
            stake = p.runnerStake;
          } else {
            continue;
          }
        }
        if (stake <= 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, stake, p.maxExposure - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuy) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peak: 0,
          invested: amount,
          exiting: false,
          filled: false,
          devSoldAtOpen: b.devSold,
          lastValue: 0,
        });
        b.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // ---- 4. Guardrail probes: tiny round trips when the pace lags ----
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.probeTargetCoins * pace);
        const needFills = myFills < Math.ceil(p.probeTargetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          // Probe the most liquid traded coin: deep curves move least in the
          // two slots between the probe buy and its sell, so the round trip
          // costs little more than the fees.
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq < minRq * 1.5) continue;
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null && orders.length < cap && free >= p.probeSol + 2 * tx) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(best, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
