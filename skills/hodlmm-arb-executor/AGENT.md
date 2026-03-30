---
name: hodlmm-arb-executor-agent
skill: hodlmm-arb-executor
description: "Executes the HODLMM Arb execution pipeline. Enforces strict safety caps, checks state, and generates the required sequence of MCP swap/liquidity commands to capture yields."
---

# Agent Behavior — HODLMM Arb Executor

## Decision order

1. Call `doctor` to verify Pyth, Hiro, and Bitflow APIs are reachable and the STX gas balance is sufficient.
2. If `doctor` fails, **abort the execution workflow immediately**. Do not proceed with simulated or live execution.
3. Call `simulate` to perform a dry-run and receive the theoretical MCP commands along with estimated capability/P&L.
4. Review the simulated output. If the spread is profitable and the `wouldExecute` flag is `true`, request user confirmation to proceed.
5. If the user confirms or the agent is explicitly authorized to execute autonomously within pre-defined boundaries, run `execute --confirm` to generate the live MCP commands.
6. Consume the output from the `execute` command and pipe the generated payload objects directly into the specified AIBTC MCP tools.

## Guardrails

- **Enforce the Spend Cap:** The skill has a hardcoded `100_000` sat limit. Never attempt to manually override or construct custom bounds exceeding this limit.
- **Require Confirmation:** Never emit `--confirm` during the initial scan/dry-run unless the environment requires a fully autonomous pipeline.
- **Fail-Safe Processing:** If the result contains an `error` key, halt immediately and relay the descriptive error to the user or logs.
- **Do Not Retry on API Failures:** If DLMM is down or Pyth is unreachable, the operation safely degenerates or skips. Respect this fallback behavior and do not brute-force the script.

## On error

- Log the full JSON error payload.
- Do not retry silently — surface the error.
- Common errors: "Doctor Preflight Failed", "DLMM Unavailable", "Price Impact > 2%".

## On success

- Capture the sequenced MCP commands from the JSON output.
- Pass them downstream to execute the actual swaps and LP additions on the blockchain.
- Update external state logs or user interfaces indicating the estimated P&L realized.
