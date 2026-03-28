---
name: hodlmm-arb-scanner-agent
skill: hodlmm-arb-scanner
description: "Arb detection agent for Bitflow sBTC/STX — compares HODLMM, XYK, and Pyth oracle prices, emits spread signals. Read-only; no wallet required."
---

# Agent Behavior — HODLMM Arb Scanner

## Decision order

1. Run `doctor` first. If any check is `error`, stop and surface the connectivity issue.
2. Run `scan` to get current price spreads across all venues.
3. Read `bestArb`:
   - If `null`: No actionable spread. Log and wait.
   - If `profitable: true`: Spread exceeds fees. Surface the opportunity to the operator or chain to a swap skill.
   - If `profitable: false`: Spread exists but fees consume it. Log and monitor for widening.
4. For continuous monitoring, use `watch --interval 60 --min-spread 0.3`.
5. When an alert fires, evaluate `grossSpreadPct` vs `estFeePct` before acting.

## Guardrails

- This skill is **read-only**. It never writes to chain or moves funds.
- Never execute a swap based solely on this skill's output. Always chain with `swap-safety-gate` or equivalent for execution safety.
- Never ignore the `estFeePct` field — a positive gross spread does not mean profitable after fees.
- Fee estimates are approximations. Real HODLMM fees vary by bin distance. Build in a safety margin.
- The `dlmm.source` field tells you whether HODLMM data is live. If `"unavailable"`, spreads are XYK vs Oracle only — less reliable for arb.
- Default to safe/read-only behavior when intent is ambiguous.
- Never expose secrets or private keys in args or logs.

## Output contract

All commands return structured JSON to stdout.

**doctor:**
```json
{
  "network": "mainnet",
  "status": "ok | error",
  "checks": [
    { "name": "pyth_hermes", "status": "ok | error", "detail": "..." },
    { "name": "hiro_xyk_pool", "status": "ok | error", "detail": "..." },
    { "name": "bitflow_hodlmm", "status": "ok | warn", "detail": "..." }
  ]
}
```

**scan:**
```json
{
  "network": "mainnet",
  "pair": "sBTC/STX",
  "oracle": { "btcUsd": "number", "stxUsd": "number", "stxPerBtc": "number" },
  "xyk": { "stxPerBtc": "number", "liquidityUsd": "number" },
  "dlmm": { "stxPerBtc": "number", "source": "bitflow-api | unavailable" },
  "spreads": { "xykVsDlmm": "SpreadDetail | null", "xykVsOracle": "SpreadDetail" },
  "bestArb": "ArbSignal | null"
}
```

## On error

- `"error": "Pyth returned fewer than 2 price feeds"` — Pyth Hermes outage. Retry after 30s.
- `"error": "Contract call failed"` — Hiro API issue. Check network status.
- `"error": "API error 429"` — Rate limited. Wait 60s before retrying.
- If `dlmm.source: "unavailable"`, scanner still works using oracle vs XYK. Not a hard failure.

## On success

- Log: `pair`, `bestArb.grossSpreadPct`, `bestArb.netSpreadPct`, `bestArb.profitable`.
- If chaining to execution: pass `bestArb.buyVenue` and `bestArb.sellVenue` to the swap skill.
- If running `watch`: store scan results externally for spread trend analysis.
