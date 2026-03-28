---
name: hodlmm-arb-scanner
description: "Detects price discrepancies between Bitflow HODLMM (DLMM), XYK pools, and Pyth oracle for sBTC/STX. Emits arb signals with gross/net spread and fee estimates. Read-only; no wallet required."
metadata:
  author: "ronkenx9"
  author-agent: "Parallel Owl"
  user-invocable: "false"
  arguments: "doctor | scan | watch"
  entry: "hodlmm-arb-scanner/hodlmm-arb-scanner.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Arb Scanner

## What it does

Compares sBTC/STX prices across three venues — Pyth oracle, Bitflow XYK pool (on-chain reserves), and Bitflow HODLMM (DLMM bins) — to detect actionable price discrepancies. Calculates gross spread, estimates round-trip fees, and emits a net profitability signal. The `watch` command runs continuous monitoring with configurable alert thresholds.

## Why agents need it

Trading agents executing sBTC/STX swaps need to know which venue offers the best price *right now*. Without this skill, agents swap blindly on whichever pool their default route picks. This skill gives them a pre-trade price check across all Bitflow venues plus the oracle reference, enabling venue-optimal routing and arb detection.

## On-chain proof

Tested on Stacks mainnet (2026-03-28T22:01Z):

| Command | Result |
|---------|--------|
| `doctor` | Pyth: BTC=$66,639 STX=$0.2221 OK. Hiro XYK: 296,699 STX/BTC, 9.998 BTC + 2,966,364 STX, $1.33M TVL OK. |
| `scan` | Oracle: 299,819 STX/BTC. XYK: 296,699 STX/BTC. Spread: 1.04%. Net after fees: 0.74% profitable. |

Data sources: Pyth Hermes (`hermes.pyth.network`), Hiro Stacks API (`api.hiro.so` — on-chain `get-pool` call to `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1`), Bitflow API (`api.bitflow.finance` — HODLMM bins, graceful fallback when unreachable).

## HODLMM integration

When Bitflow API is reachable, the scanner reads HODLMM bin reserves for `dlmm_3` (sBTC/STX) and calculates the DLMM price from active bin data. This enables three-way spread comparison: XYK vs DLMM vs Oracle. When the API is unreachable, it gracefully degrades to XYK vs Oracle spread detection.

## Safety notes

- **Read-only** — never writes to chain or moves funds.
- **No wallet required** — all data comes from public APIs and read-only contract calls.
- **Mainnet only** — Pyth feed IDs and contract addresses are mainnet-specific.
- Fee estimates (XYK 30bps, DLMM 25bps) are approximations — actual fees may vary.
- The `bestArb` signal is informational. Execution requires a separate swap skill with proper slippage protection.

## Commands

### doctor
Check connectivity to all three data sources. Safe to run anytime.
```bash
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts doctor
```

### scan
One-shot scan for price discrepancies across all venues.
```bash
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts scan [--min-spread 0.1]
```
Options:
- `--min-spread` (default: 0.1) — Minimum spread % to report as an opportunity.

### watch
Continuous monitoring. Emits full scan output when spread exceeds threshold, compact output otherwise.
```bash
bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts watch [--interval 60] [--min-spread 0.3] [--max-scans 60]
```
Options:
- `--interval` (default: 60) — Seconds between scans.
- `--min-spread` (default: 0.3) — Minimum spread % to trigger alert.
- `--max-scans` (default: 60) — Exit after this many scans.

## Output contract

All outputs are JSON to stdout.

**scan (spread detected):**
```json
{
  "network": "mainnet",
  "pair": "sBTC/STX",
  "oracle": { "btcUsd": 66589.63, "stxUsd": 0.222099, "stxPerBtc": 299819.37 },
  "xyk": { "stxPerBtc": 296698.91, "liquidityUsd": 1324582.3 },
  "dlmm": { "stxPerBtc": 299123.57, "source": "bitflow-api" },
  "spreads": {
    "xykVsDlmm": { "spreadPct": -0.8104, "cheaperVenue": "XYK", "pricierVenue": "DLMM" },
    "xykVsOracle": { "spreadPct": -1.0408, "cheaperVenue": "XYK", "pricierVenue": "Oracle" }
  },
  "bestArb": {
    "direction": "Buy sBTC on XYK, sell on DLMM",
    "grossSpreadPct": 0.8104,
    "estFeePct": 0.55,
    "netSpreadPct": 0.2604,
    "profitable": true,
    "note": "Net profitable after est. fees. 0.26% edge."
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Bitflow HODLMM API (`api.bitflow.finance`) may be unreachable from some networks. When unavailable, scanner degrades to XYK vs Oracle comparison.
- Pyth price confidence intervals can widen during high volatility. Check `confidence` fields before trading.
- XYK reserves are read from on-chain state via Hiro API — subject to Stacks block time (~10s).
- Fee estimates are static approximations (XYK 30bps, DLMM 25bps). Actual HODLMM fees vary by bin distance from active bin.
- This skill emits signals only. Execution requires the `swap-safety-gate` or `bitflow` skill with proper slippage settings.
