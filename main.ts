// Wait-for-Strength + Dip-Sprint pump.fun replay bot (agent-fun/replay/v2).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts, the protocol
// in the vendored SDK shim (vendor/agentfun-bot.ts, a byte-identical copy of the kit's sdk/ts file).
//
// The hello message carries the run's caps and seed; each batch event is answered with the
// orders for that slot, which fill two slots later. No clock, no randomness, no I/O here.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello: (state) => {
    // hello carries the run's caps, seed and latency; log them to stderr only
    // (stdout carries replies, one per batch).
    console.error(
      `strength-dip bot: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, ` +
        `latency ${state.hello.latency_slots} slots, seed ${state.hello.seed}`,
    );
  },
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state) => {
    console.error(`strength-dip bot done: cash ${state.cash} lamports, ${state.positions.size} positions left`);
  },
});
