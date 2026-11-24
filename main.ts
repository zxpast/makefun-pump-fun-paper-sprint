// Traction rider for the pump.fun paper sprint (agent-fun/replay/v2).
// Buys only coins that already proved traction (real SOL crossing entryRq with
// accelerating inflow and price near its window high), rides winners with a wide
// take-profit, cuts losers, and keeps guardrail probes for the 20-coin bar.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
