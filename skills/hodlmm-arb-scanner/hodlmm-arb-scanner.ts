#!/usr/bin/env bun
/**
 * hodlmm-arb-scanner — Detects price discrepancies between Bitflow HODLMM (DLMM),
 * XYK pools, and Pyth oracle for sBTC/STX. Read-only; no wallet required.
 *
 * Data sources (verified live 2026-03-28):
 *   1. Pyth Hermes API — BTC/USD + STX/USD oracle prices
 *   2. Hiro Stacks API — on-chain XYK pool reserves (get-pool read-only call)
 *   3. Bitflow API — HODLMM bin data (fallback: derives spread from oracle vs XYK)
 *
 * Usage: bun run skills/hodlmm-arb-scanner/hodlmm-arb-scanner.ts <command>
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTH_HERMES = "https://hermes.pyth.network";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const FETCH_TIMEOUT_MS = 15_000;
const NETWORK = "mainnet";

// Pyth price feed IDs (mainnet)
const PYTH_BTC_USD =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const PYTH_STX_USD =
  "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

// Bitflow XYK pool contract (sBTC/STX)
const XYK_POOL_ADDR = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR";
const XYK_POOL_NAME = "xyk-pool-sbtc-stx-v-1-1";

// HODLMM pool ID for sBTC/STX
const DLMM_POOL_ID = "dlmm_3";

// Fee estimates (bps)
const FEE_BPS = {
  xyk: 30, // 0.30% Bitflow XYK fee
  dlmm: 25, // 0.25% HODLMM fee (variable, typical)
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PythParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface OraclePrices {
  btcUsd: number;
  stxUsd: number;
  stxPerBtc: number;
  confidence: { btc: number; stx: number };
  publishTime: number;
}

interface XykReserves {
  xBalanceSats: number; // sBTC in sats
  yBalanceMicro: number; // STX in micro-units
  stxPerBtc: number;
  liquidityUsd: number;
}

interface DlmmPriceResult {
  stxPerBtc: number;
  activeBinId: number;
  totalBins: number;
  source: "bitflow-api" | "unavailable";
}

interface SpreadDetail {
  spreadPct: number;
  cheaperVenue: string;
  pricierVenue: string;
}

interface ArbSignal {
  direction: string;
  grossSpreadPct: number;
  estFeePct: number;
  netSpreadPct: number;
  profitable: boolean;
  buyVenue: string;
  sellVenue: string;
  note: string;
}

interface ScanResult {
  network: string;
  pair: string;
  oracle: OraclePrices;
  xyk: XykReserves;
  dlmm: DlmmPriceResult;
  spreads: {
    xykVsDlmm: SpreadDetail | null;
    xykVsOracle: SpreadDetail;
    dlmmVsOracle: SpreadDetail | null;
  };
  bestArb: ArbSignal | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status} at ${url}`);
  return res.json() as Promise<T>;
}

function pct(a: number, b: number): number {
  if (b === 0) return 0;
  return ((a - b) / b) * 100;
}

function round(n: number, decimals: number = 4): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Data source 1: Pyth Hermes — oracle prices
// ---------------------------------------------------------------------------

async function fetchOraclePrices(): Promise<OraclePrices> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD}&ids[]=${PYTH_STX_USD}`;
  const data = await fetchJson<{ parsed: PythParsedPrice[] }>(url);

  if (!data.parsed || data.parsed.length < 2) {
    throw new Error("Pyth returned fewer than 2 price feeds");
  }

  const btcFeed = data.parsed.find((p) => p.id === PYTH_BTC_USD);
  const stxFeed = data.parsed.find((p) => p.id === PYTH_STX_USD);

  if (!btcFeed || !stxFeed) {
    throw new Error("Missing BTC or STX price feed from Pyth");
  }

  const btcUsd =
    Number(btcFeed.price.price) * Math.pow(10, btcFeed.price.expo);
  const stxUsd =
    Number(stxFeed.price.price) * Math.pow(10, stxFeed.price.expo);
  const btcConf =
    Number(btcFeed.price.conf) * Math.pow(10, btcFeed.price.expo);
  const stxConf =
    Number(stxFeed.price.conf) * Math.pow(10, stxFeed.price.expo);

  return {
    btcUsd: round(btcUsd, 2),
    stxUsd: round(stxUsd, 6),
    stxPerBtc: round(btcUsd / stxUsd, 2),
    confidence: { btc: round(btcConf, 2), stx: round(stxConf, 6) },
    publishTime: btcFeed.price.publish_time,
  };
}

// ---------------------------------------------------------------------------
// Data source 2: Hiro Stacks API — on-chain XYK pool reserves
// ---------------------------------------------------------------------------

function decodeClarityUint128(hex: string, fieldName: string): bigint {
  // Find the field name bytes in the hex, then read the uint128 after the 0x01 prefix
  const fieldHex = Buffer.from(fieldName, "utf8").toString("hex");
  const idx = hex.indexOf(fieldHex);
  if (idx === -1) throw new Error(`Field "${fieldName}" not found in response`);

  // Skip: field name bytes + 0x01 (uint type marker)
  const valueStart = idx + fieldHex.length + 2; // +2 for "01" byte
  const valueHex = hex.substring(valueStart, valueStart + 32); // 16 bytes = 32 hex chars
  return BigInt("0x" + valueHex);
}

async function fetchXykReserves(
  oraclePrices: OraclePrices
): Promise<XykReserves> {
  const url = `${HIRO_API}/v2/contracts/call-read/${XYK_POOL_ADDR}/${XYK_POOL_NAME}/get-pool`;
  const data = await fetchJson<{ okay: boolean; result: string }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: XYK_POOL_ADDR, arguments: [] }),
  });

  if (!data.okay) {
    throw new Error(`Contract call failed: ${JSON.stringify(data)}`);
  }

  // Decode Clarity response — extract x-balance (sBTC sats) and y-balance (STX micro)
  const hex = data.result.startsWith("0x")
    ? data.result.substring(2)
    : data.result;

  const xBalanceSats = Number(decodeClarityUint128(hex, "x-balance"));
  const yBalanceMicro = Number(decodeClarityUint128(hex, "y-balance"));

  const xBtc = xBalanceSats / 1e8;
  const yStx = yBalanceMicro / 1e6;
  if (xBtc === 0) throw new Error("XYK pool is empty (xBalance = 0)");
  const stxPerBtc = yStx / xBtc;
  const liquidityUsd =
    xBtc * oraclePrices.btcUsd + yStx * oraclePrices.stxUsd;

  return {
    xBalanceSats,
    yBalanceMicro,
    stxPerBtc: round(stxPerBtc, 2),
    liquidityUsd: round(liquidityUsd, 2),
  };
}

// ---------------------------------------------------------------------------
// Data source 3: Bitflow API — HODLMM pool bins (best-effort)
// ---------------------------------------------------------------------------

interface HodlmmBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface HodlmmBinsResponse {
  active_bin_id?: number;
  bins: HodlmmBin[];
}

async function fetchDlmmPrice(): Promise<DlmmPriceResult> {
  try {
    const bins = await fetchJson<HodlmmBinsResponse>(
      `${BITFLOW_API}/hodlmm/pools/${DLMM_POOL_ID}/bins`
    );

    const activeBinId = bins.active_bin_id ?? 0;
    const totalBins = bins.bins?.length ?? 0;

    // Derive price from active bin reserves
    // HODLMM price = sum(reserve_y) / sum(reserve_x) around active bin
    const nearBins = bins.bins?.filter(
      (b) => Math.abs(b.bin_id - activeBinId) <= 2
    ) ?? [];

    let totalX = 0;
    let totalY = 0;
    for (const bin of nearBins) {
      totalX += Number(bin.reserve_x);
      totalY += Number(bin.reserve_y);
    }

    // reserve_x = sBTC (sats), reserve_y = STX (micro)
    const stxPerBtc = totalX > 0 ? (totalY / 1e6) / (totalX / 1e8) : 0;

    return {
      stxPerBtc: round(stxPerBtc, 2),
      activeBinId,
      totalBins,
      source: stxPerBtc > 0 ? "bitflow-api" : "unavailable",
    };
  } catch {
    return {
      stxPerBtc: 0,
      activeBinId: 0,
      totalBins: 0,
      source: "unavailable",
    };
  }
}

// ---------------------------------------------------------------------------
// Core: spread calculation
// ---------------------------------------------------------------------------

function calculateSpreads(
  oracle: OraclePrices,
  xyk: XykReserves,
  dlmm: DlmmPriceResult
): ScanResult {
  const hasDlmm = dlmm.source !== "unavailable" && dlmm.stxPerBtc > 0;

  // XYK vs Oracle spread
  const xykVsOracle: SpreadDetail = {
    spreadPct: round(pct(xyk.stxPerBtc, oracle.stxPerBtc), 4),
    cheaperVenue: xyk.stxPerBtc < oracle.stxPerBtc ? "XYK" : "Oracle",
    pricierVenue: xyk.stxPerBtc < oracle.stxPerBtc ? "Oracle" : "XYK",
  };

  // XYK vs DLMM spread (if DLMM available)
  let xykVsDlmm: SpreadDetail | null = null;
  let dlmmVsOracle: SpreadDetail | null = null;

  if (hasDlmm) {
    xykVsDlmm = {
      spreadPct: round(pct(xyk.stxPerBtc, dlmm.stxPerBtc), 4),
      cheaperVenue: xyk.stxPerBtc < dlmm.stxPerBtc ? "XYK" : "DLMM",
      pricierVenue: xyk.stxPerBtc < dlmm.stxPerBtc ? "DLMM" : "XYK",
    };
    dlmmVsOracle = {
      spreadPct: round(pct(dlmm.stxPerBtc, oracle.stxPerBtc), 4),
      cheaperVenue: dlmm.stxPerBtc < oracle.stxPerBtc ? "DLMM" : "Oracle",
      pricierVenue: dlmm.stxPerBtc < oracle.stxPerBtc ? "Oracle" : "DLMM",
    };
  }

  // Find best arb opportunity
  let bestArb: ArbSignal | null = null;

  if (hasDlmm) {
    const grossSpread = Math.abs(pct(xyk.stxPerBtc, dlmm.stxPerBtc));
    const estFee = (FEE_BPS.xyk + FEE_BPS.dlmm) / 100;
    const netSpread = grossSpread - estFee;

    if (grossSpread > 0.1) {
      const buyOnXyk = xyk.stxPerBtc < dlmm.stxPerBtc;
      bestArb = {
        direction: buyOnXyk
          ? "Buy sBTC on XYK, sell on DLMM"
          : "Buy sBTC on DLMM, sell on XYK",
        grossSpreadPct: round(grossSpread, 4),
        estFeePct: round(estFee, 4),
        netSpreadPct: round(netSpread, 4),
        profitable: netSpread > 0,
        buyVenue: buyOnXyk ? "Bitflow XYK" : "Bitflow HODLMM",
        sellVenue: buyOnXyk ? "Bitflow HODLMM" : "Bitflow XYK",
        note: netSpread > 0
          ? `Net profitable after est. fees. ${round(netSpread, 2)}% edge.`
          : `Spread exists but est. fees (${round(estFee, 2)}%) consume the edge.`,
      };
    }
  } else {
    // Without DLMM, report XYK vs Oracle spread as the signal
    const grossSpread = Math.abs(pct(xyk.stxPerBtc, oracle.stxPerBtc));
    if (grossSpread > 0.3) {
      bestArb = {
        direction:
          xyk.stxPerBtc < oracle.stxPerBtc
            ? "XYK pool is cheaper than oracle — potential buy signal"
            : "XYK pool is pricier than oracle — potential sell signal",
        grossSpreadPct: round(grossSpread, 4),
        estFeePct: round(FEE_BPS.xyk / 100, 4),
        netSpreadPct: round(grossSpread - FEE_BPS.xyk / 100, 4),
        profitable: grossSpread > FEE_BPS.xyk / 100,
        buyVenue: xyk.stxPerBtc < oracle.stxPerBtc ? "Bitflow XYK" : "Market",
        sellVenue: xyk.stxPerBtc < oracle.stxPerBtc ? "Market" : "Bitflow XYK",
        note: "DLMM data unavailable — using oracle vs XYK only. Run with Bitflow API access for full HODLMM spread.",
      };
    }
  }

  return {
    network: NETWORK,
    pair: "sBTC/STX",
    oracle,
    xyk,
    dlmm,
    spreads: { xykVsDlmm, xykVsOracle, dlmmVsOracle },
    bestArb,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-arb-scanner")
  .description(
    "Detect price discrepancies between Bitflow HODLMM, XYK pools, and Pyth oracle"
  );

// --- doctor ---
program
  .command("doctor")
  .description("Check API connectivity and data freshness")
  .action(async () => {
    try {
      const checks: Array<{ name: string; status: string; detail: string }> =
        [];

      // Fetch oracle once; reuse result for both Pyth and XYK checks
      let oracleResult: Awaited<ReturnType<typeof fetchOraclePrices>> | null =
        null;

      // 1. Pyth Hermes
      try {
        oracleResult = await fetchOraclePrices();
        const age = Math.round(Date.now() / 1000 - oracleResult.publishTime);
        checks.push({
          name: "pyth_hermes",
          status: "ok",
          detail: `BTC=$${oracleResult.btcUsd} STX=$${oracleResult.stxUsd} | age ${age}s | conf BTC=$${oracleResult.confidence.btc}`,
        });
      } catch (e) {
        checks.push({
          name: "pyth_hermes",
          status: "error",
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      // 2. Hiro Stacks API (XYK pool) — reuses oracle fetch from check 1
      try {
        if (!oracleResult) throw new Error("Oracle unavailable — skipping XYK check");
        const xyk = await fetchXykReserves(oracleResult);
        checks.push({
          name: "hiro_xyk_pool",
          status: "ok",
          detail: `${round(xyk.stxPerBtc, 2)} STX/BTC | ${round(xyk.xBalanceSats / 1e8, 4)} BTC + ${round(xyk.yBalanceMicro / 1e6, 0)} STX | $${round(xyk.liquidityUsd, 0)} TVL`,
        });
      } catch (e) {
        checks.push({
          name: "hiro_xyk_pool",
          status: "error",
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      // 3. Bitflow HODLMM API
      try {
        const dlmm = await fetchDlmmPrice();
        if (dlmm.source === "unavailable") {
          checks.push({
            name: "bitflow_hodlmm",
            status: "warn",
            detail: `HODLMM API unreachable — scanner will use oracle+XYK only. Use aibtc MCP jingswap_get_prices for DLMM data.`,
          });
        } else {
          checks.push({
            name: "bitflow_hodlmm",
            status: "ok",
            detail: `${dlmm.stxPerBtc} STX/BTC | active bin ${dlmm.activeBinId} | ${dlmm.totalBins} total bins`,
          });
        }
      } catch (e) {
        checks.push({
          name: "bitflow_hodlmm",
          status: "warn",
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      const hasError = checks.some((c) => c.status === "error");
      printJson({
        network: NETWORK,
        status: hasError ? "error" : "ok",
        checks,
        note: "Read-only scanner. No wallet or funds required.",
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- scan ---
program
  .command("scan")
  .description("Scan sBTC/STX for price discrepancies across venues")
  .option(
    "--min-spread <pct>",
    "Minimum spread % to flag as opportunity",
    "0.1"
  )
  .action(async (opts) => {
    try {
      const minSpread = parseFloat(opts.minSpread);

      // Fetch from all three sources in parallel
      const [oracle, dlmm] = await Promise.all([
        fetchOraclePrices(),
        fetchDlmmPrice(),
      ]);
      const xyk = await fetchXykReserves(oracle);

      const result = calculateSpreads(oracle, xyk, dlmm);

      // Apply min-spread filter
      if (result.bestArb && result.bestArb.grossSpreadPct < minSpread) {
        result.bestArb = null;
      }

      printJson(result);
    } catch (e) {
      handleError(e);
    }
  });

// --- watch ---
program
  .command("watch")
  .description("Continuously scan and emit signals when spread widens")
  .option("--interval <seconds>", "Scan interval in seconds", "60")
  .option("--min-spread <pct>", "Minimum spread to emit alert", "0.3")
  .option("--max-scans <n>", "Max scans before exit", "60")
  .action(async (opts) => {
    try {
      const interval = parseInt(opts.interval) * 1000;
      const minSpread = parseFloat(opts.minSpread);
      const maxScans = parseInt(opts.maxScans);
      let scanCount = 0;

      printJson({
        status: "watching",
        interval: `${opts.interval}s`,
        minSpread: `${minSpread}%`,
        maxScans,
        startedAt: new Date().toISOString(),
      });

      while (scanCount < maxScans) {
        scanCount++;
        try {
          const [oracle, dlmm] = await Promise.all([
            fetchOraclePrices(),
            fetchDlmmPrice(),
          ]);
          const xyk = await fetchXykReserves(oracle);
          const result = calculateSpreads(oracle, xyk, dlmm);

          const hasSpread =
            result.bestArb && result.bestArb.grossSpreadPct >= minSpread;
          if (hasSpread) {
            printJson({ scan: scanCount, alert: true, ...result });
          } else {
            printJson({
              scan: scanCount,
              alert: false,
              xykStxPerBtc: xyk.stxPerBtc,
              dlmmStxPerBtc: dlmm.stxPerBtc || "n/a",
              oracleStxPerBtc: oracle.stxPerBtc,
              xykVsOraclePct: round(pct(xyk.stxPerBtc, oracle.stxPerBtc), 4),
              timestamp: new Date().toISOString(),
            });
          }
        } catch (e) {
          printJson({
            scan: scanCount,
            error: e instanceof Error ? e.message : String(e),
          });
        }

        if (scanCount < maxScans) {
          await new Promise((r) => setTimeout(r, interval));
        }
      }

      printJson({ status: "complete", totalScans: scanCount });
    } catch (e) {
      handleError(e);
    }
  });

program.parse();
