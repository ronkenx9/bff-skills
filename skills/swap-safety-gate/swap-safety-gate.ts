#!/usr/bin/env bun
/**
 * swap-safety-gate — Bitflow swap regime gate with execution layer
 *
 * Scores swap safety 0-100 across:
 *   - Price impact (40pts)
 *   - Route diversity (20pts)
 *   - Liquidity depth (25pts, HODLMM bins or ticker fallback)
 *   - Route health (15pts)
 *
 * Gate: score >= 60 = safeToSwap: true. Run executes only if gate passes.
 * HODLMM bonus eligible: Yes — directly reads HODLMM bin reserves for depth scoring.
 *
 * Usage: bun run skills/swap-safety-gate/swap-safety-gate.ts <subcommand> [options]
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;

const SAFE_THRESHOLD = 60;
const WARNING_THRESHOLD = 40;
const DEFAULT_MAX_PRICE_IMPACT_PCT = 5.0;
const DEFAULT_MAX_AMOUNT = 1000;

const TOKEN_DECIMALS: Record<string, number> = {
  "token-stx": 6,
  "token-sbtc": 8,
  "token-USDCx-auto": 6,
  "token-aeusdc": 6,
  "token-alex": 8,
  "token-welsh": 6,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TickerEntry {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  liquidity_in_usd: string;
}

interface RouteEntry {
  source: string;
  executable: boolean;
  tokenPath?: string[];
  expectedAmountOut?: string;
  priceImpact?: number;
  amountOut?: string;
}

interface QuoteResult {
  expectedAmountOut: string;
  priceImpact?: number;
  route?: string[];
}

interface HodlmmBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface HodlmmBinsResponse {
  active_bin_id?: number;
  bins: HodlmmBin[];
}

interface ScoreFactor {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
}

interface Assessment {
  swapScore: number;
  safeToSwap: boolean;
  severity: "safe" | "warning" | "blocked";
  factors: {
    priceImpact: ScoreFactor;
    routeDiversity: ScoreFactor;
    liquidityDepth: ScoreFactor;
    routeHealth: ScoreFactor;
  };
  recommendation: {
    route: string;
    expectedOut: string;
    priceImpactPct: string;
  };
  blockReason: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDecimals(tokenId: string): number {
  return TOKEN_DECIMALS[tokenId] ?? 6;
}

function toMicroUnits(amount: number, tokenId: string): number {
  return Math.round(amount * Math.pow(10, getDecimals(tokenId)));
}

function printJson(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status} at ${url}`);
  return res.json() as Promise<T>;
}

async function getTickers(baseId?: string, targetId?: string): Promise<TickerEntry[]> {
  let url = `${BITFLOW_API}/ticker`;
  const params = new URLSearchParams();
  if (baseId) params.set("base_currency", baseId);
  if (targetId) params.set("target_currency", targetId);
  if (params.toString()) url += `?${params.toString()}`;
  const data = await fetchJson<TickerEntry[] | { tickers: TickerEntry[] }>(url);
  return Array.isArray(data) ? data : (data as { tickers: TickerEntry[] }).tickers ?? [];
}

async function getRoutes(
  tokenX: string,
  tokenY: string,
  amountIn: number
): Promise<RouteEntry[]> {
  const micro = toMicroUnits(amountIn, tokenX);
  const url = `${BITFLOW_API}/routes?token_x=${encodeURIComponent(tokenX)}&token_y=${encodeURIComponent(tokenY)}&amount_in=${micro}`;
  const data = await fetchJson<RouteEntry[] | { routes: RouteEntry[] }>(url);
  return Array.isArray(data) ? data : (data as { routes: RouteEntry[] }).routes ?? [];
}

async function getQuote(
  tokenX: string,
  tokenY: string,
  amountIn: number
): Promise<QuoteResult | null> {
  try {
    const micro = toMicroUnits(amountIn, tokenX);
    const url = `${BITFLOW_API}/quote?token_x=${encodeURIComponent(tokenX)}&token_y=${encodeURIComponent(tokenY)}&amount_in=${micro}`;
    return await fetchJson<QuoteResult>(url);
  } catch {
    return null;
  }
}

async function getHodlmmBins(poolId: string): Promise<HodlmmBinsResponse | null> {
  try {
    return await fetchJson<HodlmmBinsResponse>(
      `${BITFLOW_API}/hodlmm/pools/${poolId}/bins`
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scorePriceImpact(impactPct: number): ScoreFactor {
  let score: number;
  let detail: string;
  if (impactPct < 1) {
    score = 40;
    detail = `${impactPct.toFixed(2)}% — low`;
  } else if (impactPct < 3) {
    score = 24;
    detail = `${impactPct.toFixed(2)}% — moderate`;
  } else if (impactPct < 5) {
    score = 10;
    detail = `${impactPct.toFixed(2)}% — high`;
  } else {
    score = 0;
    detail = `${impactPct.toFixed(2)}% — severe (hard block at ≥5%)`;
  }
  return { name: "priceImpact", score, maxScore: 40, detail };
}

function scoreRouteDiversity(executableRoutes: RouteEntry[]): ScoreFactor {
  const count = executableRoutes.length;
  let score: number;
  let detail: string;
  if (count >= 2) {
    score = 20;
    detail = `${count} executable routes — good redundancy`;
  } else if (count === 1) {
    score = 10;
    detail = "1 executable route — single-provider dependency risk";
  } else {
    score = 0;
    detail = "No executable routes found";
  }
  return { name: "routeDiversity", score, maxScore: 20, detail };
}

function scoreLiquidityDepth(
  amountIn: number,
  tokenX: string,
  tickers: TickerEntry[],
  hodlmmBins: HodlmmBinsResponse | null
): ScoreFactor {
  // Prefer HODLMM bins (precise atomic-unit comparison)
  if (hodlmmBins && hodlmmBins.bins.length > 0) {
    const totalReserveX = hodlmmBins.bins.reduce(
      (sum, b) => sum + Number(b.reserve_x),
      0
    );
    if (totalReserveX > 0) {
      const atomicIn = toMicroUnits(amountIn, tokenX);
      const ratio = atomicIn / totalReserveX;
      let score: number;
      let detail: string;
      if (ratio < 0.01) {
        score = 25;
        detail = `Trade is ${(ratio * 100).toFixed(2)}% of HODLMM pool — excellent depth`;
      } else if (ratio < 0.05) {
        score = 18;
        detail = `Trade is ${(ratio * 100).toFixed(2)}% of HODLMM pool — moderate depth`;
      } else if (ratio < 0.10) {
        score = 8;
        detail = `Trade is ${(ratio * 100).toFixed(2)}% of HODLMM pool — thin`;
      } else {
        score = 0;
        detail = `Trade is ${(ratio * 100).toFixed(2)}% of HODLMM pool — dangerous`;
      }
      return { name: "liquidityDepth", score, maxScore: 25, detail };
    }
  }

  // Fallback: ticker liquidity_in_usd
  const pair = tickers.find(
    (t) =>
      (t.base_currency === tokenX || t.target_currency === tokenX) &&
      t.liquidity_in_usd &&
      Number(t.liquidity_in_usd) > 0
  );
  const liquidityUsd = pair ? Number(pair.liquidity_in_usd) : 0;
  let score: number;
  let detail: string;
  if (liquidityUsd > 500_000) {
    score = 25;
    detail = `$${(liquidityUsd / 1_000).toFixed(0)}K pool liquidity — deep (ticker estimate)`;
  } else if (liquidityUsd > 100_000) {
    score = 18;
    detail = `$${(liquidityUsd / 1_000).toFixed(0)}K pool liquidity — moderate (ticker estimate)`;
  } else if (liquidityUsd > 25_000) {
    score = 8;
    detail = `$${(liquidityUsd / 1_000).toFixed(0)}K pool liquidity — thin (ticker estimate)`;
  } else {
    score = 0;
    detail =
      liquidityUsd > 0
        ? `$${(liquidityUsd / 1_000).toFixed(0)}K pool liquidity — very thin (ticker estimate)`
        : "No liquidity data available";
  }
  return { name: "liquidityDepth", score, maxScore: 25, detail };
}

function scoreRouteHealth(routes: RouteEntry[]): ScoreFactor {
  const hasSdk = routes.some((r) => r.source === "sdk" && r.executable);
  const hasHodlmm = routes.some((r) => r.source === "hodlmm" && r.executable);
  let score: number;
  let detail: string;
  if (hasSdk && hasHodlmm) {
    score = 15;
    detail = "Both SDK and HODLMM routes live";
  } else if (hasSdk) {
    score = 8;
    detail = "SDK route only — HODLMM unavailable for this pair";
  } else if (hasHodlmm) {
    score = 8;
    detail = "HODLMM route only — no SDK fallback";
  } else {
    score = 0;
    detail = "No routes available";
  }
  return { name: "routeHealth", score, maxScore: 15, detail };
}

// ---------------------------------------------------------------------------
// Core assessment
// ---------------------------------------------------------------------------

async function computeAssessment(
  tokenX: string,
  tokenY: string,
  amountIn: number,
  maxPriceImpactPct: number,
  hodlmmPoolId?: string
): Promise<Assessment> {
  // Fetch routes, quote, tickers in parallel
  const [routes, quote, tickers] = await Promise.all([
    getRoutes(tokenX, tokenY, amountIn),
    getQuote(tokenX, tokenY, amountIn),
    getTickers(tokenX, tokenY).catch(() => [] as TickerEntry[]),
  ]);

  // HODLMM bins — use explicit pool ID if provided
  const hodlmmBins = hodlmmPoolId ? await getHodlmmBins(hodlmmPoolId) : null;

  const executableRoutes = routes.filter((r) => r.executable);
  const bestRoute = executableRoutes[0] ?? null;

  // Price impact: prefer quote API, fall back to route data
  const priceImpactPct =
    typeof quote?.priceImpact === "number"
      ? quote.priceImpact * 100
      : typeof bestRoute?.priceImpact === "number"
      ? bestRoute.priceImpact * 100
      : 0;

  const expectedOut =
    quote?.expectedAmountOut ?? bestRoute?.expectedAmountOut ?? bestRoute?.amountOut ?? "unknown";

  // Score each factor
  const priceImpactFactor = scorePriceImpact(priceImpactPct);
  const routeDiversityFactor = scoreRouteDiversity(executableRoutes);
  const liquidityFactor = scoreLiquidityDepth(amountIn, tokenX, tickers, hodlmmBins);
  const routeHealthFactor = scoreRouteHealth(routes);

  const swapScore =
    priceImpactFactor.score +
    routeDiversityFactor.score +
    liquidityFactor.score +
    routeHealthFactor.score;

  // Hard block conditions (regardless of score)
  let blockReason: string | null = null;
  if (executableRoutes.length === 0) {
    blockReason = "No executable route found for this token pair";
  } else if (priceImpactPct > maxPriceImpactPct) {
    blockReason = `Price impact ${priceImpactPct.toFixed(2)}% exceeds limit of ${maxPriceImpactPct}% — pass --confirm-high-impact to override`;
  }

  const safeToSwap = !blockReason && swapScore >= SAFE_THRESHOLD;
  const severity: "safe" | "warning" | "blocked" = blockReason
    ? "blocked"
    : swapScore >= SAFE_THRESHOLD
    ? "safe"
    : swapScore >= WARNING_THRESHOLD
    ? "warning"
    : "blocked";

  return {
    swapScore,
    safeToSwap,
    severity,
    factors: {
      priceImpact: priceImpactFactor,
      routeDiversity: routeDiversityFactor,
      liquidityDepth: liquidityFactor,
      routeHealth: routeHealthFactor,
    },
    recommendation: {
      route: bestRoute?.source ?? "none",
      expectedOut,
      priceImpactPct: `${priceImpactPct.toFixed(2)}%`,
    },
    blockReason,
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("swap-safety-gate")
  .description("Bitflow swap regime gate — score safety 0-100, execute only when safe")
  .version("1.0.0");

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description("Check Bitflow API connectivity and environment readiness")
  .action(async () => {
    const checks: Array<{ name: string; status: string; detail: string }> = [];

    // Ticker API
    try {
      const tickers = await getTickers();
      checks.push({
        name: "bitflow_ticker_api",
        status: "ok",
        detail: `${tickers.length} trading pairs live`,
      });
    } catch (e) {
      checks.push({
        name: "bitflow_ticker_api",
        status: "error",
        detail: e instanceof Error ? e.message : "unreachable",
      });
    }

    // Routes API (1 STX → sBTC probe)
    try {
      const routes = await getRoutes("token-stx", "token-sbtc", 1);
      const exec = routes.filter((r) => r.executable).length;
      checks.push({
        name: "bitflow_routes_api",
        status: "ok",
        detail: `${routes.length} routes found, ${exec} executable (STX→sBTC probe)`,
      });
    } catch (e) {
      checks.push({
        name: "bitflow_routes_api",
        status: "error",
        detail: e instanceof Error ? e.message : "unreachable",
      });
    }

    // HODLMM bins API (dlmm_3 probe)
    try {
      const bins = await getHodlmmBins("dlmm_3");
      checks.push({
        name: "bitflow_hodlmm_api",
        status: bins && bins.bins.length > 0 ? "ok" : "warning",
        detail:
          bins && bins.bins.length > 0
            ? `dlmm_3: ${bins.bins.length} bins, active bin ${bins.active_bin_id ?? "unknown"}`
            : "dlmm_3 returned no bins — HODLMM depth scoring will use ticker fallback",
      });
    } catch (e) {
      checks.push({
        name: "bitflow_hodlmm_api",
        status: "warning",
        detail: "HODLMM bins unavailable — depth scoring falls back to ticker",
      });
    }

    const anyError = checks.some((c) => c.status === "error");
    const allOk = checks.every((c) => c.status === "ok");

    printJson({
      network: NETWORK,
      status: anyError ? "error" : allOk ? "ok" : "degraded",
      checks,
      note: "Swap execution requires an unlocked aibtc wallet (--wallet-password or pre-unlock).",
      timestamp: new Date().toISOString(),
    });
  });

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

program
  .command("assess")
  .description("Score a pending swap 0-100 and emit safeToSwap signal. Read-only.")
  .requiredOption("--token-x <id>", "Input token ID (e.g. token-stx, token-sbtc)")
  .requiredOption("--token-y <id>", "Output token ID (e.g. token-sbtc, token-USDCx-auto)")
  .requiredOption("--amount-in <decimal>", "Input amount in human-readable units (e.g. 10.0 for 10 STX)")
  .option("--hodlmm-pool-id <id>", "HODLMM pool ID for precise depth scoring (e.g. dlmm_3)")
  .option("--max-price-impact <pct>", "Max allowed price impact % (default: 5.0)", String(DEFAULT_MAX_PRICE_IMPACT_PCT))
  .action(
    async (opts: {
      tokenX: string;
      tokenY: string;
      amountIn: string;
      hodlmmPoolId?: string;
      maxPriceImpact: string;
    }) => {
      try {
        const amountIn = parseFloat(opts.amountIn);
        if (isNaN(amountIn) || amountIn <= 0)
          throw new Error("--amount-in must be a positive number");
        const maxImpact = parseFloat(opts.maxPriceImpact);

        const assessment = await computeAssessment(
          opts.tokenX,
          opts.tokenY,
          amountIn,
          maxImpact,
          opts.hodlmmPoolId
        );

        printJson({
          network: NETWORK,
          tokenIn: opts.tokenX,
          tokenOut: opts.tokenY,
          amountIn: opts.amountIn,
          hodlmmPoolId: opts.hodlmmPoolId ?? null,
          swapScore: assessment.swapScore,
          safeToSwap: assessment.safeToSwap,
          severity: assessment.severity,
          factors: assessment.factors,
          recommendation: assessment.recommendation,
          blockReason: assessment.blockReason,
          note: assessment.safeToSwap
            ? `Score ${assessment.swapScore}/100 — safe to execute. Run 'run' subcommand to proceed.`
            : `Score ${assessment.swapScore}/100 — ${assessment.blockReason ?? "below safe threshold of " + SAFE_THRESHOLD}`,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        handleError(e);
      }
    }
  );

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

program
  .command("run")
  .description("Re-assess with live data, then execute swap only if gate passes")
  .requiredOption("--token-x <id>", "Input token ID")
  .requiredOption("--token-y <id>", "Output token ID")
  .requiredOption("--amount-in <decimal>", "Input amount in human-readable units")
  .option("--hodlmm-pool-id <id>", "HODLMM pool ID for precise depth scoring (e.g. dlmm_3)")
  .option("--slippage-tolerance <decimal>", "Slippage tolerance 0-1 (default: 0.01)", "0.01")
  .option("--max-price-impact <pct>", "Max price impact % (default: 5.0)", String(DEFAULT_MAX_PRICE_IMPACT_PCT))
  .option("--max-amount <decimal>", `Max swap amount (default: ${DEFAULT_MAX_AMOUNT})`, String(DEFAULT_MAX_AMOUNT))
  .option("--confirm-high-impact", "Override the >5% price impact hard block")
  // NOTE: --wallet-password intentionally omitted. Unlock wallet before running this skill.
  // Passing credentials through MCP command output risks exposure in logs and agent history.
  .action(
    async (opts: {
      tokenX: string;
      tokenY: string;
      amountIn: string;
      hodlmmPoolId?: string;
      slippageTolerance: string;
      maxPriceImpact: string;
      maxAmount: string;
      confirmHighImpact?: boolean;
    }) => {
      try {
        const amountIn = parseFloat(opts.amountIn);
        const maxAmount = parseFloat(opts.maxAmount);

        if (isNaN(amountIn) || amountIn <= 0)
          throw new Error("--amount-in must be a positive number");

        // Hard spend limit — checked before any API calls
        if (amountIn > maxAmount) {
          printJson({
            status: "blocked",
            swapScore: 0,
            safeToSwap: false,
            blockReason: `Amount ${amountIn} exceeds --max-amount ${maxAmount}. Reduce --amount-in or increase --max-amount.`,
            action: "Reduce trade size or explicitly raise --max-amount",
            mcp_command: null,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const maxImpact = opts.confirmHighImpact ? 100 : parseFloat(opts.maxPriceImpact);

        // Fresh assessment at execution time
        const assessment = await computeAssessment(
          opts.tokenX,
          opts.tokenY,
          amountIn,
          maxImpact,
          opts.hodlmmPoolId
        );

        if (!assessment.safeToSwap) {
          printJson({
            status: assessment.severity,
            swapScore: assessment.swapScore,
            safeToSwap: false,
            factors: assessment.factors,
            blockReason:
              assessment.blockReason ??
              `Score ${assessment.swapScore} is below safe threshold of ${SAFE_THRESHOLD}`,
            action:
              assessment.swapScore >= WARNING_THRESHOLD
                ? "Conditions marginal — reduce size or wait for better market depth."
                : "Swap blocked by regime gate. Do not execute.",
            mcp_command: null,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Gate passed — emit MCP command for agent framework to execute
        const mcpParams: Record<string, unknown> = {
          token_x: opts.tokenX,
          token_y: opts.tokenY,
          amount_in: opts.amountIn,
          slippage_tolerance: parseFloat(opts.slippageTolerance),
        };
        if (opts.confirmHighImpact) {
          mcpParams.confirm_high_impact = true;
        }

        printJson({
          status: "safe",
          swapScore: assessment.swapScore,
          safeToSwap: true,
          assessment: {
            severity: assessment.severity,
            factors: assessment.factors,
            recommendation: assessment.recommendation,
          },
          action: "Gate passed — execute swap via aibtc MCP bitflow swap tool",
          mcp_command: {
            tool: "mcp__aibtc__bitflow_swap",
            params: mcpParams,
          },
          note: "Assessment performed at execution time with live market data.",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        handleError(e);
      }
    }
  );

program.parse(process.argv);
