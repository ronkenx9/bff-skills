---
name: swap-safety-gate-agent
skill: swap-safety-gate
description: "Regime gate agent for Bitflow swaps — always assesses before executing, blocks dangerous swaps, and emits structured MCP commands for safe execution."
---

# Agent Behavior — Swap Safety Gate

## Decision order

1. Run `doctor` first. If `status` is `error`, stop and surface the API connectivity issue — do not attempt swaps.
2. Run `assess --token-x <x> --token-y <y> --amount-in <amount>` (add `--hodlmm-pool-id` if known).
3. Read `severity`:
   - `safe` (score ≥ 60): Proceed to `run`.
   - `warning` (score 40–59): Surface score and factors to operator. Do not proceed without explicit confirmation.
   - `blocked`: Do not proceed. Surface `blockReason` to operator. Never override silently.
4. Run `run` with the same parameters plus `--wallet-password` if available. The skill re-assesses at execution time with fresh market data — do not assume the prior `assess` result is still valid.
5. Execute the `mcp_command` emitted by `run`.
6. Confirm tx hash from the MCP tool response. Log the swap.

## Guardrails

- **Never execute a swap when `safeToSwap` is `false`.**
- **Never skip `assess` before `run`.** The `run` command re-assesses internally, but the agent should also assess independently to log the decision reasoning.
- **Never silently override a `blocked` status.** `--confirm-high-impact` and `--max-amount` overrides require explicit operator instruction.
- **Respect `--max-amount`.** Default is 1000 STX. Do not increase without explicit user instruction.
- **Never expose `--wallet-password` in logs, outputs, or messages.** Pass it only as a flag, never print it.
- **On `warning` severity:** Surface the specific low-scoring factor (e.g. thin liquidity, single route) and ask the operator whether to proceed. Do not auto-proceed on warnings.
- **Default to smaller amounts for new pairs.** If `liquidityDepth` factor scores < 10, cut `--amount-in` in half before retrying.

## Scoring reference

| Factor | Max | What it measures |
|--------|-----|-----------------|
| `priceImpact` | 40 | <1% = 40, 1-3% = 24, 3-5% = 10, >5% = 0 |
| `routeDiversity` | 20 | 2+ routes = 20, 1 route = 10, none = 0 |
| `liquidityDepth` | 25 | Trade size vs pool reserve (HODLMM bins or ticker) |
| `routeHealth` | 15 | Both SDK+HODLMM = 15, one = 8, none = 0 |

Gate: **≥ 60 = safe. 40–59 = warning. < 40 or hard block = blocked.**

## Capital allocation strategy

- Keep a liquid STX reserve ≥ 200,000 uSTX for gas before attempting any swap.
- Default `--max-amount 1000` STX per call. For large positions, split across multiple calls.
- Re-assess before each call — market conditions can change between cycles.
- Chain with `hodlmm-risk assess-pool` before adding liquidity: swap gate + LP gate = full pre-trade safety.

## Output contract

```json
{
  "status": "safe | warning | blocked | error",
  "swapScore": 73,
  "safeToSwap": true,
  "severity": "safe | warning | blocked",
  "factors": {},
  "blockReason": null,
  "action": "next recommended action",
  "mcp_command": { "tool": "...", "params": {} }
}
```

## On error

- `"error": "API error 429"` — Bitflow rate limit. Wait 60s before retrying.
- `"error": "No executable route"` — No route available. Check token IDs and try again later.
- `"error": "API error 5xx"` — Bitflow outage. Do not retry aggressively. Surface to operator.
- Never retry on `blocked` status without understanding the `blockReason`.

## On success

- Log: `swapScore`, `severity`, `recommendation.route`, `recommendation.priceImpactPct`.
- After MCP `bitflow_swap` executes: confirm `txid` from response.
- Log: `"Swap executed: <amountIn> <tokenX> → <tokenY> | Score: <score> | Tx: <txid>"`.
- If swap hits the `warning` zone but was explicitly approved: log the override with operator's reason.
