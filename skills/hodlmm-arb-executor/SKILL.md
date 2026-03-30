---
name: hodlmm-arb-executor
description: "Evaluates the spread between Bitflow XYK and HODLMM (DLMM) for STX/sBTC, manages safe LP positioning caps, and generates valid MCP swap/liquidity commands."
metadata:
  author: "ronkenx9"
  author-agent: "Arb Execution Sentinel"
  user-invocable: "false"
  arguments: "doctor | watch | simulate | execute"
  entry: "hodlmm-arb-executor/hodlmm-arb-executor.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, l2"
---

# HODLMM Arb Executor

## What it does
Monitors and executes spread-aware LP positioning for STX/sBTC on Bitflow. It scans oracle and pool reserve data, enforces strict spend caps and cooldowns, and generates sequenced MCP commands to add or remove liquidity based on market conditions.

## Why agents need it
Agents need a safe, stateful execution pipeline to realize yield opportunities without risking total wallet deployment. This skill encapsulates complex data fetching, spread calculation, safety guards (like the 100k sat spend cap), and state tracking into a single command loop.

## Safety notes
- **Writes to chain:** Yes, via the emitted MCP commands (only when using `--confirm`).
- **Moves funds:** Yes, the generated commands will execute swaps and LP deposits.
- **Mainnet only:** Bitflow HODLMM APIs do not exist on testnet.
- **Spend Cap:** Hardcoded to a safety maximum of 100,000 sats per execution.
- **Cooldown:** Enforces a 10-minute delay between active executions to prevent spam.

## Commands

### doctor
Checks environment, API reachability (Hiro, Pyth, Bitflow), and wallet STX gas balance. Safe to run anytime.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts doctor
```

### watch
Continuous polling mode that alerts when the spread crosses the minimum threshold. Safe, read-only.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts watch --min-spread <pct>
```

### simulate
Dry-run mode. Runs the full spread analysis pipeline and shows the exact MCP commands it would generate without emitting them. Safe, read-only.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts simulate --max-sats 100000
```

### execute
Core execution. Requires the `--confirm` flag to emit the actual MCP JSON payload. Without the flag, behaves identically to `simulate`.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts execute --confirm --max-sats 100000
```

## Output contract

All outputs are JSON to stdout.

**Success (Simulate):**
```json
{
  "result": "success",
  "details": {
    "mode": "dry-run",
    "wouldExecute": true,
    "action": "ENTRY",
    "commands": [
      {
        "step": 1,
        "tool": "bitflow_swap",
        "description": "Buy 100000 sats sBTC (auto-routing to optimal pool)",
        "params": {
          "tokenX": "token-stx",
          "tokenY": "token-sbtc",
          "amount": 100000,
          "slippage": 1
        }
      }
    ],
    "estimatedPnlSats": 0,
    "note": "Re-run with --confirm to execute live."
  }
}
```

**Success (Execute w/ Confirm):**
```json
{
  "result": "success",
  "details": {
    "mode": "live",
    "commands": [ ...MCP payloads... ]
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- DLMM pool data is required; if Bitflow's API is down, execution degrades gracefully or skips.
- Requires STX for gas fees.
- Does not auto-manage LP withdrawals unless the "spread reversal" or "2-hour max" exit conditions are met internally.
