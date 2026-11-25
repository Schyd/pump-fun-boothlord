# Surge Catcher — pump.fun paper-trading bot

A bot for the [u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) contest on [make.fun](https://make.fun).

[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Schyd/pump-fun-boothlord/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Schyd/pump-fun-boothlord/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![contest](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

## Idea

Most pump.fun coins spike at launch and then bleed back to their create price, so blind launch-buying loses to fees. The money is in the tail: the few launches that actually run. This bot only buys a coin in its create slot, and only when the launch is quiet — at most one non-creator buyer so far, the creator bought at most 0.5 SOL in the create slot and hasn't sold, and real SOL is 4–10. Then it exits fast: take profit, a tight stop, a trailing stop once it is up, or a short time limit. It never pyramids and never re-enters a coin. A tiny probe mechanism (0.01 SOL round trips on the most liquid traded coin) keeps the run above the guardrail floors without chasing.

Everything is a pure function of the batches the harness sends: no clock, no randomness, no I/O, so two executions produce byte-identical action logs.

## Files

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (written from scratch for this entry).
- `vendor/agentfun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte; it is infrastructure, not strategy.

## How it runs

The harness speaks `agent-fun/replay/v2` over NDJSON on stdin/stdout: it sends `hello`, then `batch`es, then `done`, and the bot answers exactly one `reply` per batch. Capital is 10 SOL, at most 5 open positions, each order at most 1% of a curve's real reserve, protocol fee 95 bps + creator fee 30 bps per fill, and a 2-slot fill latency.

## Dev results (local `grade-local --driver process`, 24 h dev window)

Verified with the kit's real grader (commit `747188f`):

- **Net PnL: +0.0137 SOL** (+0.14% on 10 SOL), max drawdown 0.23%, win rate 8.6% (3/35)
- 35 round trips, 70 fills, 0 rejected, 0 failed txs, 35 distinct coins
- Fees paid: 0.0263 SOL. Ranked: yes. The only eligibility notes are `no_transcripts` and `cost_unpriced`, which are artefacts of a local grade (transcripts and cost are produced at submit time); there is no `below_hold_cash` flag because PnL is positive.
- Six-hour slices (standalone 6 h windows, the shape of the final): −0.018 / −0.004 / +0.017 / −0.010 SOL — mean −0.004, so a single 6 h final is a coin flip with a small negative drift; the edge is the fat tail (the best trip made +0.035 SOL, and without it the 24 h result is −0.021).
- Stress (`grade-local --stress`, 20 resampled copies): median −0.016 SOL, 4/20 positive. The stress median is negative because the dev gain rides on one coin (the top 3 coins are 100% of the gains); a looser filter that enters more coins scores higher on dev (+0.047 SOL) but far worse on stress (median −0.24 SOL), so the selective filter is the robust choice.

For comparison on the same window: pilot momentum −9.45 SOL, pilot reversion −4.37 SOL, pilot sniper −0.42 SOL, equal-weight baseline −0.02 SOL (5 coins only, fails the ≥20-coin guardrail).

## Final parameters

- Launch entry, create slot only (`launchMaxAge 0`): at most 1 non-creator buyer so far, creator bought ≤ 0.5 SOL in the create slot, creator hasn't sold, real SOL 4–10. Stake 0.1 SOL (capped at 1% of real reserve).
- Runner entries disabled: chasing mature coins lost money in every sweep.
- Exits: take profit +40%, stop loss −2%, time limit 12 slots (waived while up ≥ 5%), trailing stop armed at +10% / 10% pullback, exit on creator sell, fade exit on net outflow < −1 SOL over 20 slots. No pyramiding, no re-entry (`maxEntries 1`).
- Guardrail probes: 0.01 SOL round trips on the most liquid traded coin, only enough to hold the pace at 22 distinct coins over 6 h (the guardrail needs ≥ 20); the fill target is 0, because the fill count is not a guardrail and extra probes only burn fees.
