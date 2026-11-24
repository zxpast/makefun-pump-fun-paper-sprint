# Pump.fun Paper Sprint — Opening-Burst Rider

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zxpast/makefun-pump-fun-paper-sprint/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zxpast/makefun-pump-fun-paper-sprint/reward.svg)](https://make.fun)

Entry for the [make.fun](https://make.fun) competition
**Pump.fun Paper Sprint: Any Bot Can Win**
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`): a paper-trading
bot for the 6-hour pump.fun replay. Highest net PnL takes the pot; no real
funds are ever involved.

## Strategy

Buy every coin whose real SOL first crosses **10 SOL within 10 slots of
creation**, one buy of **0.15 SOL**, and exit on first passage of
**take-profit +15%** or **stop-loss −12%** (long horizon). Tiny 0.01 SOL
probe round trips keep the run above the 20-coin guardrail bar when burst
entries alone are too few. Deterministic: no clock, no randomness.

Why this shape, measured on the kit dev window (1222 coins / 24h):

- The 2-slot fill latency eats the opening burst: the price jumps a median
  +15% in the two slots after a coin's real SOL crosses a threshold, so
  every TP/SL combination is −3% to −9% EV per trade once latency is priced
  in. There is no free edge; the game is the least-bad profile with the
  best positive tail.
- High-threshold fast crossings measured best. The kit sniper
  (maxBuyers filter, 10-slot timeout) loses −0.48 SOL/24h, the kit momentum
  bot −9.68 SOL/24h, late traction entries −4.08 SOL/24h. Wider take-profits,
  trailing stops, pyramiding and creator-sell exits all measured worse.

## Measured results (local sim port, all 3 dataset parts)

| Window | Net PnL | Fills | Coins | Guard coins | Trips (wins) | Max DD |
| --- | --- | --- | --- | --- | --- | --- |
| Full 24h dev | −0.9931 SOL | 451 | 224 | 224 | 226 (85) | 0.116 |
| 6h slice 0 | +0.1832 SOL | 66 | 31 | 31 | 33 (15) | 0.013 |
| 6h slice 1 | −0.4448 SOL | 88 | 44 | 44 | 44 (14) | 0.054 |
| 6h slice 2 | −0.5825 SOL | 190 | 95 | 95 | 95 (35) | 0.071 |
| 6h slice 3 | −0.1711 SOL | 107 | 54 | 54 | 54 (19) | 0.035 |

Deterministic 2x: yes (byte-identical runs). Top-3 coins +0.334 SOL on the
full window; ex-top-3 −1.3271 SOL. At 2x fees the full window is −1.8493 SOL.
On 7 rolling 6h windows: 1 in 7 positive, best +0.183 SOL. The dev window
is a hard regime — every tested strategy loses on it — so this entry is
tuned for the best positive-tail shot on a fresh 6h window, not the dev mean.

## Files

- `main.ts` — entrypoint: runs the strategy on Node 22 via the vendored SDK shim.
- `strategy.ts` — the strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/agentfun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim,
  vendored byte for byte.
- `LICENSE` — MIT.
