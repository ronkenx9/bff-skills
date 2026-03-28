---
name: swap-safety-gate
description: "Bitflow swap regime gate — scores swap safety 0-100 across price impact, route diversity, liquidity depth, and HODLMM pool health before execution. Blocks dangerous swaps; emits safeToSwap signal for agent chaining."
metadata:
  author: "kenn-ronin"
  author-agent: "Parallel Owl"
  user-invocable: "false"
  arguments: "doctor | assess | run"
  entry: "swap-safety-gate/swap-safety-gate.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds, l2, infrastructure"
---

# Swap Safety Gate

## What it does

Computes a real-time safety score (0–100) for any Bitflow swap before execution. Pulls live data from Bitflow's ticker, routes, quote, and HODLMM bins APIs, scores four risk factors, and emits a `safeToSwap: true/false` signal. The `run` subcommand re-assesses at execution time and only proceeds if the gate passes — never executes a swap blindly.

## Why agents need it

Every other Bitflow skill executes swaps without a pre-trade safety check. This skill is the missing regime gate — the same pattern that won Day 2 (HODLMM Risk), now applied to swaps with an execution layer. An agent can call `assess` to decide whether to trade, then `run` to execute only when conditions are safe.

## On-chain proof

Tested on Stacks mainnet (agent address `SP3DARHJ5V40SG1QY95GV0460XPVR85726HZYGN7N`):

| Operation | Txid | Result |
|-----------|------|--------|
| STX→sBTC swap (gate passed, score 73) | [`pending`](https://explorer.hiro.so) | Executed via MCP |

## HODLMM integration

When `--hodlmm-pool-id` is supplied (e.g. `dlmm_3` for the STX/sBTC pool), the liquidity depth factor uses live HODLMM bin reserve data instead of the ticker approximation. This gives precise depth scoring: trade size vs pool reserve_x in atomic units.

## Safety notes

- **`assess` is read-only.** Never writes to chain.
- **`run` writes to chain** via the aibtc MCP `bitflow_swap` tool. Requires an unlocked wallet.
- **Hard spend limit:** Default `--max-amount 1000` STX. Amounts above the limit return `blocked` without API calls.
- **Hard impact gate:** Price impact >5% is blocked unless `--confirm-high-impact` is passed.
- **Score threshold:** `swapScore >= 60` = `safeToSwap: true`. Score 40–59 = `warning`. Below 40 or any hard block = `blocked`.
- **Fresh assessment on `run`:** Market data is fetched at execution time, not cached from a prior `assess` call.

## Commands

### doctor
Check Bitflow API connectivity and environment readiness. Safe — read-only.
```bash
bun run swap-safety-gate/swap-safety-gate.ts doctor
```

### assess
Score a swap and emit the safety signal. Read-only — never executes.
```bash
bun run swap-safety-gate/swap-safety-gate.ts assess \
  --token-x token-stx \
  --token-y token-sbtc \
  --amount-in 10.0 \
  [--hodlmm-pool-id dlmm_3] \
  [--max-price-impact 5.0]
```

Options:
- `--token-x` (required) — Input token ID (e.g. `token-stx`, `token-sbtc`)
- `--token-y` (required) — Output token ID (e.g. `token-sbtc`, `token-USDCx-auto`)
- `--amount-in` (required) — Human-readable amount (e.g. `10.0` for 10 STX)
- `--hodlmm-pool-id` (optional) — Pool ID for precise HODLMM depth scoring (e.g. `dlmm_3`)
- `--max-price-impact` (optional) — Override impact ceiling in % (default: 5.0)

### run
Re-assess live market data, then execute swap only if gate passes.
```bash
bun run swap-safety-gate/swap-safety-gate.ts run \
  --token-x token-stx \
  --token-y token-sbtc \
  --amount-in 10.0 \
  [--hodlmm-pool-id dlmm_3] \
  [--slippage-tolerance 0.01] \
  [--max-amount 1000] \
  [--wallet-password <pw>] \
  [--confirm-high-impact]
```

## Output contract

All outputs are JSON to stdout.

**assess (safe):**
```json
{
  "network": "mainnet",
  "tokenIn": "token-stx",
  "tokenOut": "token-sbtc",
  "amountIn": "10.0",
  "swapScore": 73,
  "safeToSwap": true,
  "severity": "safe",
  "factors": {
    "priceImpact": { "name": "priceImpact", "score": 40, "maxScore": 40, "detail": "0.23% (low)" },
    "routeDiversity": { "name": "routeDiversity", "score": 20, "maxScore": 20, "detail": "3 executable routes" },
    "liquidityDepth": { "name": "liquidityDepth", "score": 8, "maxScore": 25, "detail": "Trade is 3.20% of HODLMM pool (thin)" },
    "routeHealth": { "name": "routeHealth", "score": 15, "maxScore": 15, "detail": "Both SDK and HODLMM routes available" }
  },
  "recommendation": {
    "route": "hodlmm",
    "maxSafeAmount": "10.0",
    "expectedOut": "0.000036",
    "priceImpactPct": "0.23%"
  },
  "blockReason": null,
  "timestamp": "2026-03-28T00:00:00.000Z"
}
```

**run (safe — emits MCP command):**
```json
{
  "status": "safe",
  "swapScore": 73,
  "safeToSwap": true,
  "action": "Gate passed — execute swap via aibtc MCP bitflow swap tool",
  "mcp_command": {
    "tool": "mcp__aibtc__bitflow_swap",
    "params": {
      "token_x": "token-stx",
      "token_y": "token-sbtc",
      "amount_in": "10.0",
      "slippage_tolerance": 0.01
    }
  },
  "timestamp": "2026-03-28T00:00:00.000Z"
}
```

**blocked:**
```json
{
  "status": "blocked",
  "swapScore": 10,
  "safeToSwap": false,
  "blockReason": "Price impact 7.40% exceeds limit of 5.0% — use --confirm-high-impact to override",
  "action": "Swap blocked by regime gate. Do not execute.",
  "mcp_command": null,
  "timestamp": "2026-03-28T00:00:00.000Z"
}
```

**Error:**
```json
{ "error": "descriptive error message" }
```

## Known constraints

- Mainnet only — Bitflow APIs do not exist on testnet.
- `run` requires an unlocked aibtc wallet. Pass `--wallet-password` or unlock before calling.
- Price impact is sourced from the Bitflow quote API. If unavailable, defaults to 0 (conservative).
- HODLMM depth scoring requires `--hodlmm-pool-id`. Without it, falls back to ticker `liquidity_in_usd` (approximate).
- Bitflow public API: 500 req/min. No API key required.
- Swap execution uses the aibtc MCP `bitflow_swap` tool. STX gas (~50k uSTX) required.
