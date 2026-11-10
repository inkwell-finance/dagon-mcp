#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultLedgerPath } from "./ledger.ts";
import { createDagonServer, parseSolCap, parseUsdCap } from "./server.ts";
import { parseKeypair } from "./wallet.ts";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`dagon-mcp: stdio MCP server for Dagon Inference (https://inference.dagon.so)

Usage: npx -y dagon-mcp   (speaks MCP over stdin/stdout; configure it in an MCP client)

Environment: DAGON_API_KEY, DAGON_BASE_URL, DAGON_WALLET_SECRET_KEY, DAGON_TREASURY_WALLET,
DAGON_SOLANA_RPC_URL, DAGON_MIN_PURCHASE_USD, DAGON_MAX_PURCHASE_USD, DAGON_MAX_PURCHASE_USD_PER_SESSION,
DAGON_MAX_PURCHASE_USD_PER_DAY, DAGON_MAX_SOL_FEES, DAGON_SPEND_LEDGER
Docs: https://github.com/inkwell-finance/dagon-mcp#readme`);
  process.exit(0);
}

const env = process.env;
const secret = env.DAGON_WALLET_SECRET_KEY?.trim();
const wallet = secret ? parseKeypair(secret) : undefined;
// stderr only: stdout carries the MCP protocol. Lets the user check the key decoded to the address they expect.
if (wallet) console.error(`dagon-mcp: payer wallet ${wallet.publicKey.toBase58()}`);

const server = createDagonServer({
  apiKey: env.DAGON_API_KEY?.trim() || undefined,
  baseUrl: env.DAGON_BASE_URL?.trim() || undefined,
  wallet,
  treasuryWallet: env.DAGON_TREASURY_WALLET?.trim() || undefined,
  solanaRpcUrl: env.DAGON_SOLANA_RPC_URL?.trim() || undefined,
  maxPurchaseUsd: parseUsdCap("DAGON_MAX_PURCHASE_USD", env.DAGON_MAX_PURCHASE_USD),
  maxPurchaseUsdPerSession: parseUsdCap("DAGON_MAX_PURCHASE_USD_PER_SESSION", env.DAGON_MAX_PURCHASE_USD_PER_SESSION),
  minPurchaseUsd: parseUsdCap("DAGON_MIN_PURCHASE_USD", env.DAGON_MIN_PURCHASE_USD),
  maxPurchaseUsdPerDay: parseUsdCap("DAGON_MAX_PURCHASE_USD_PER_DAY", env.DAGON_MAX_PURCHASE_USD_PER_DAY),
  maxSolFees: parseSolCap("DAGON_MAX_SOL_FEES", env.DAGON_MAX_SOL_FEES),
  spendLedgerPath: env.DAGON_SPEND_LEDGER?.trim() || defaultLedgerPath(env),
});

await server.connect(new StdioServerTransport());
