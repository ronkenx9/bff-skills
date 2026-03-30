#!/usr/bin/env bun
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const STATE_FILE_PATH = path.join(os.homedir(), ".hodlmm-arb-executor-state.json");
const COOLDOWN_MINUTES = 10;
const ABSOLUTE_MAX_SATS = 100_000; // ~$85 max risk ceiling
const DLMM_POOL_ID = "dlmm_3"; // Default STX/sBTC DLMM pool
const XYK_POOL_ID = "stx-sbtc-xyk"; // Reference for spread
const BITFLOW_API_URL = "https://app.bitflow.finance/api";

// Token Identifiers (Bitflow Skill Standard)
const TOKEN_STX = "token-stx";
const TOKEN_SBTC = "token-sbtc";

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
interface ExecutionLog {
    timestamp: string;
    action: "ENTRY" | "EXIT";
    grossSpreadPct: number;
    netSpreadPct: number;
    cappedSatsDeployed: number;
    buyVenue: string;
    sellVenue: string;
    dlmmActiveBinAtEntry?: number;
    estimatedPnlSats: number;
}

interface ExecutorState {
    last_execution_at: string | null;
    last_spread_pct: number;
    open_position: {
        active: boolean;
        entryTimestamp: string | null;
        dlmmBinId: number | null;
        satsDeployed: number;
        entrySpreadPct: number;
    };
    cooldown_minutes: number;
    executions: ExecutionLog[];
    stats: {
        totalExecutions: number;
        estimatedCumulativePnlSats: number;
        avgNetSpreadPct: number;
    };
}

const DEFAULT_STATE: ExecutorState = {
    last_execution_at: null,
    last_spread_pct: 0,
    open_position: {
        active: false,
        entryTimestamp: null,
        dlmmBinId: null,
        satsDeployed: 0,
        entrySpreadPct: 0
    },
    cooldown_minutes: COOLDOWN_MINUTES,
    executions: [],
    stats: {
        totalExecutions: 0,
        estimatedCumulativePnlSats: 0,
        avgNetSpreadPct: 0
    }
};

function loadState(): ExecutorState {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const data = fs.readFileSync(STATE_FILE_PATH, "utf-8");
            return JSON.parse(data) as ExecutorState;
        }
    } catch (e) {
        // Silently fallback to default state on corrupted parse
    }
    return DEFAULT_STATE;
}

function saveState(state: ExecutorState) {
    try {
        // Enforce max 50 executions log to prevent unbounded growth
        if (state.executions.length > 50) {
            state.executions = state.executions.slice(state.executions.length - 50);
        }
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch (e) {
        console.log(JSON.stringify({ error: "Failed to write state file." }));
    }
}

// ============================================================================
// SAFETY & DOCTOR PREFLIGHT
// ============================================================================

async function fetchWithTimeout(resource: RequestInfo, options: RequestInit & { timeout?: number } = {}) {
    const { timeout = 5000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(resource, {
        ...options,
        signal: controller.signal
    });
    clearTimeout(id);
    return response;
}

// Check network endpoints to ensure the agent won't fail mid-execution
async function runDoctor() {
    const status: any = { pyth: false, hiro: false, bitflow: false };

    try {
        const pythRes = await fetchWithTimeout("https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43");
        if (pythRes.ok) status.pyth = true;
    } catch (e) { }

    try {
        const hiroRes = await fetchWithTimeout("https://api.hiro.so/v2/info");
        if (hiroRes.ok) status.hiro = true;
    } catch (e) { }

    try {
        const bfRes = await fetchWithTimeout(`${BITFLOW_API_URL}/pool`);
        if (bfRes.ok) status.bitflow = true;
    } catch (e) { }

    const allPassed = status.pyth && status.hiro && status.bitflow;

    if (allPassed) {
        return { result: "ready", details: status };
    } else {
        throw new Error(`Doctor preflight failed. Status: ${JSON.stringify(status)}`);
    }
}

// ============================================================================
// MARKET DATA & SPREAD ANALYSIS
// ============================================================================

async function fetchMarketData() {
    // 1. Pyth Oracle
    const pythUrl = "https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    const pythRes = await fetchWithTimeout(pythUrl);
    if (!pythRes.ok) throw new Error("Failed to fetch Pyth oracle data.");
    const pythData = await pythRes.json();
    const priceObj = pythData.parsed[0].price;
    const oraclePrice = Number(priceObj.price) * Math.pow(10, priceObj.expo);

    // 2. XYK Pool
    const xykRes = await fetchWithTimeout(`${BITFLOW_API_URL}/pool/${XYK_POOL_ID}`);
    if (!xykRes.ok) throw new Error("Failed to fetch XYK pool data.");
    const xykData = await xykRes.json();
    const stxBalance = Number(xykData.balanceX) / 1e6;
    const sbtcBalance = Number(xykData.balanceY) / 1e8;
    const xykPrice = stxBalance / sbtcBalance;

    // 3. DLMM Pool (HODLMM)
    const dlmmRes = await fetchWithTimeout(`${BITFLOW_API_URL}/pool/${DLMM_POOL_ID}`);
    let dlmmPrice = oraclePrice;
    let dlmmActiveBin = 0;
    let dlmmAvailable = false;

    if (dlmmRes.ok) {
        dlmmAvailable = true;
        const dlmmData = await dlmmRes.json();
        if (dlmmData.activeBinId) {
            dlmmActiveBin = Number(dlmmData.activeBinId);
            dlmmPrice = Number(dlmmData.price || oraclePrice);
        }
    }

    return { oraclePrice, xykPrice, dlmmPrice, dlmmActiveBin, dlmmAvailable };
}

// ============================================================================
// COMMAND GENERATION & LP LOGIC
// ============================================================================

function generateEntryCommands(amountSats: number, dlmmActiveBin: number) {
    return [
        {
            step: 1,
            tool: "bitflow_swap",
            description: `Buy ${amountSats} sats sBTC (auto-routing to optimal pool)`,
            params: {
                tokenX: TOKEN_STX,
                tokenY: TOKEN_SBTC,
                amount: amountSats,
                slippage: 1.0
            }
        },
        {
            step: 2,
            tool: "bitflow_hodlmm_add_liquidity",
            description: `Deposit ${amountSats} sats sBTC into DLMM active bin ID: ${dlmmActiveBin}`,
            params: {
                poolId: DLMM_POOL_ID,
                amountX: 0,
                amountY: amountSats,
                activeBinTolerance: 2,
                slippageTolerance: 1.0
            }
        }
    ];
}

function generateExitCommands(positionStats: any, currentActiveBin: number) {
    const binOffset = positionStats.dlmmBinId ? (positionStats.dlmmBinId - currentActiveBin) : 0;

    return [
        {
            step: 1,
            tool: "bitflow_hodlmm_remove_liquidity",
            description: `Withdraw position from DLMM pool at bin offset: ${binOffset}`,
            params: {
                poolId: DLMM_POOL_ID,
                binOffset: binOffset,
                amountX: 0,
                amountY: positionStats.satsDeployed
            }
        },
        {
            step: 2,
            tool: "bitflow_swap",
            description: `Sell withdrawn sBTC back to STX (auto-routing to optimal pool)`,
            params: {
                tokenX: TOKEN_SBTC,
                tokenY: TOKEN_STX,
                amount: positionStats.satsDeployed,
                slippage: 1.0
            }
        }
    ];
}

// ============================================================================
// EXECUTION PIPELINE
// ============================================================================

async function runPipeline(mode: "live" | "simulate", maxSats: number) {
    const state = loadState();

    // Check 10-min cooldown
    if (state.last_execution_at) {
        const lastExec = new Date(state.last_execution_at);
        const diffMins = (Date.now() - lastExec.getTime()) / (1000 * 60);
        if (diffMins < COOLDOWN_MINUTES) {
            console.log(JSON.stringify({
                result: "cooldown",
                details: { message: `Cooldown active. ${Math.ceil(COOLDOWN_MINUTES - diffMins)} minutes remaining.` }
            }));
            return;
        }
    }

    try {
        const market = await fetchMarketData();

        // Spread calculation (e.g., if XYK is 100 and DLMM is 101, spread is 1%)
        const spreadPct = ((market.dlmmPrice - market.xykPrice) / market.xykPrice) * 100;
        state.last_spread_pct = spreadPct;

        let commands: any[] = [];
        let action: "ENTRY" | "EXIT" | "NONE" = "NONE";
        let note = "";
        let estimatedPnlSats = 0;

        // Arbitrary threshold: 0.5% spread + DLMM is available
        const SPREAD_ENTRY_THRESHOLD = 0.5;

        if (state.open_position.active) {
            // EXIT CONDITION: Spread reversed OR it has been 2 hours
            let shouldExit = false;
            if (spreadPct <= 0) {
                shouldExit = true;
                note = "Spread reversed. Exiting position.";
            }

            if (state.open_position.entryTimestamp) {
                const entryTime = new Date(state.open_position.entryTimestamp);
                if ((Date.now() - entryTime.getTime()) / (1000 * 60 * 60) >= 2) {
                    shouldExit = true;
                    note = "2-hour max position time reached. Exiting position.";
                }
            }

            if (shouldExit) {
                commands = generateExitCommands(state.open_position, market.dlmmActiveBin);
                action = "EXIT";

                // P&L Theoretical Approximation
                const netSpread = state.open_position.entrySpreadPct - spreadPct;
                estimatedPnlSats = Math.floor(state.open_position.satsDeployed * (netSpread / 100));
            } else {
                note = "Holding position. Exit conditions not met.";
            }

        } else if (market.dlmmAvailable && spreadPct > SPREAD_ENTRY_THRESHOLD) {
            // ENTRY CONDITION: No open position + favorable spread
            const deploySats = Math.min(maxSats, ABSOLUTE_MAX_SATS);
            commands = generateEntryCommands(deploySats, market.dlmmActiveBin);
            action = "ENTRY";
            note = `Profitable spread detected (${spreadPct.toFixed(2)}%). Entering position.`;
        } else {
            note = "No profitable spread. No action taken.";
        }

        if (mode === "simulate") {
            console.log(JSON.stringify({
                result: "success",
                details: {
                    mode: "dry-run",
                    wouldExecute: commands.length > 0,
                    action: action,
                    commands,
                    estimatedPnlSats: estimatedPnlSats,
                    note: note + " Re-run with --confirm to execute live."
                }
            }, null, 2));
            return;
        }

        if (mode === "live" && commands.length > 0) {
            // If live and commands generated, output payload and record state
            const log: ExecutionLog = {
                timestamp: new Date().toISOString(),
                action: action as "ENTRY" | "EXIT",
                grossSpreadPct: spreadPct,
                netSpreadPct: spreadPct - 0.2, // ~0.2% approximated fee slip
                cappedSatsDeployed: action === "ENTRY" ? maxSats : state.open_position.satsDeployed,
                buyVenue: action === "ENTRY" ? "XYK" : "DLMM",
                sellVenue: action === "ENTRY" ? "DLMM" : "XYK",
                dlmmActiveBinAtEntry: market.dlmmActiveBin,
                estimatedPnlSats: estimatedPnlSats
            };

            state.last_execution_at = log.timestamp;
            state.executions.push(log);
            state.stats.totalExecutions++;
            state.stats.estimatedCumulativePnlSats += estimatedPnlSats;

            if (action === "ENTRY") {
                state.open_position = {
                    active: true,
                    entryTimestamp: log.timestamp,
                    dlmmBinId: market.dlmmActiveBin,
                    satsDeployed: maxSats,
                    entrySpreadPct: spreadPct
                };
            } else {
                state.open_position = { active: false, entryTimestamp: null, dlmmBinId: null, satsDeployed: 0, entrySpreadPct: 0 };
            }

            saveState(state);

            console.log(JSON.stringify({
                result: "success",
                details: {
                    mode: "live",
                    action,
                    log,
                    commands: commands
                }
            }, null, 2));
        } else if (mode === "live") {
            console.log(JSON.stringify({ result: "success", details: { note: note, commands: [] } }));
        }

    } catch (e: any) {
        console.log(JSON.stringify({ error: e.message || "Execution encountered an error." }));
    }
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

const program = new Command();

program
    .name("hodlmm-arb-executor")
    .description("Evaluates the spread between Bitflow XYK and HODLMM (DLMM) for STX/sBTC, manages safe LP positioning caps, and generates valid MCP swap/liquidity commands.");

program
    .command("doctor")
    .description("Check environment readiness and API reachability")
    .action(async () => {
        try {
            const res = await runDoctor();
            console.log(JSON.stringify(res, null, 2));
        } catch (e: any) {
            console.log(JSON.stringify({ error: e.message }, null, 2));
        }
    });

program
    .command("simulate")
    .description("Dry-run the pipeline. Outputs the actions the skill would take with --confirm.")
    .option("--max-sats <number>", "Spend cap in sats", "100000")
    .action(async (opts: { maxSats: string }) => {
        const maxSats = Math.min(Number(opts.maxSats), ABSOLUTE_MAX_SATS);
        await runPipeline("simulate", maxSats);
    });

program
    .command("watch")
    .description("Continuous polling. Alerts when spread exceeds minimum threshold.")
    .option("--min-spread <number>", "Minimum spread percentage to alert", "0.5")
    .action(async (opts: { minSpread: string }) => {
        setInterval(async () => {
            console.log(JSON.stringify({ result: "success", details: { status: "polling", timestamp: new Date().toISOString() } }));
            await runPipeline("simulate", 100000); // Simulate only bounds safely
        }, 60000); // Check every 1m
    });

program
    .command("execute")
    .description("Core execution. Generates live MCP commands JSON.")
    .option("--confirm", "REQUIRED to emit live MCP commands. Without this, runs as simulate.")
    .option("--max-sats <number>", "Spend cap in sats", "100000")
    .action(async (opts: { confirm: boolean, maxSats: string }) => {
        const maxSats = Math.min(Number(opts.maxSats), ABSOLUTE_MAX_SATS);
        if (!opts.confirm) {
            await runPipeline("simulate", maxSats);
        } else {
            await runPipeline("live", maxSats);
        }
    });

program.parse();
