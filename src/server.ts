import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PublicKey, type Keypair } from "@solana/web3.js";
import { z } from "zod";
import { checkedHttpsUrl, deadline, readJsonCapped, REQUEST_TIMEOUT_MS } from "./http.ts";
import { SpendLedger } from "./ledger.ts";
import { sendTransaction, signTransaction, validatePurchaseTransaction } from "./wallet.ts";

export const DEFAULT_BASE_URL = "https://inference.dagon.so";
export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

export interface DagonOptions {
  /** Configured account key (gk_...) used by keyed tools. Purchases are always bound to this key. */
  apiKey?: string;
  baseUrl?: string;
  /** When set, dagon_buy_credits validates and signs the purchase, submitting it itself unless it is fee sponsored. */
  wallet?: Keypair;
  /** Independently configured Solana treasury owner. Required for purchases so remote transaction bytes can be verified. */
  treasuryWallet?: string;
  solanaRpcUrl?: string;
  fetch?: typeof fetch;
  /** How many times to ask the gateway to confirm a submitted payment while it is still pending. */
  confirmAttempts?: number;
  confirmIntervalMs?: number;
  /** Upper bound on the whole wallet-backed confirmation wait; afterwards the purchase is reported as pending. */
  confirmTimeoutMs?: number;
  /** Largest single dagon_buy_credits amount, in USD (DAGON_MAX_PURCHASE_USD). Defaults to DEFAULT_MAX_PURCHASE_USD. */
  maxPurchaseUsd?: number;
  /** Total USD of purchases this server process may prepare (DAGON_MAX_PURCHASE_USD_PER_SESSION). Defaults to DEFAULT_MAX_PURCHASE_USD_PER_SESSION. */
  maxPurchaseUsdPerSession?: number;
  /** Smallest dagon_buy_credits amount, in USD (DAGON_MIN_PURCHASE_USD). Defaults to DEFAULT_MIN_PURCHASE_USD. */
  minPurchaseUsd?: number;
  /** Total USD of purchases per UTC day across restarts (DAGON_MAX_PURCHASE_USD_PER_DAY). Defaults to DEFAULT_MAX_PURCHASE_USD_PER_DAY. */
  maxPurchaseUsdPerDay?: number;
  /** Worst-case SOL (network fees + treasury account rent) unsponsored purchases may cost the payer per UTC day (DAGON_MAX_SOL_FEES). */
  maxSolFees?: number;
  /** File persisting the daily totals (DAGON_SPEND_LEDGER). Without it the daily totals live only in this process. */
  spendLedgerPath?: string;
  /** Deadline for each gateway and Solana RPC request. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

export const DEFAULT_MAX_PURCHASE_USD = 50;
export const DEFAULT_MAX_PURCHASE_USD_PER_SESSION = 200;
export const DEFAULT_MIN_PURCHASE_USD = 1;
export const DEFAULT_MAX_PURCHASE_USD_PER_DAY = 200;
export const DEFAULT_MAX_SOL_FEES = 0.05;
const LAMPORTS_PER_SOL = 1_000_000_000;
/** Largest gateway response body read into memory (chat completions included). */
const MAX_GATEWAY_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Parses an operator-set USD cap; unset/blank yields undefined (use default), anything invalid throws so misconfiguration fails closed. */
export function parseUsdCap(name: string, raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`${name} must be a non-negative USD amount in whole cents (e.g. 50 or 12.5).`);
  return Number(value);
}

/** Parses an operator-set SOL amount (up to 9 decimals); unset/blank yields undefined, anything invalid throws. */
export function parseSolCap(name: string, raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error(`${name} must be a non-negative SOL amount (e.g. 0.05).`);
  return Number(value);
}

const capCents = (name: string, usd: number): number => {
  const cents = Math.round(usd * 100);
  if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(cents) || Math.abs(usd * 100 - cents) > 1e-6) {
    throw new Error(`${name} must be a non-negative USD amount in whole cents.`);
  }
  return cents;
};

interface GatewayReply {
  status: number;
  data: unknown;
}

/** What a purchase confirmation carries: the signature of a transaction the payer sent, or a wallet-signed fee-sponsored transaction. */
type ConfirmProof = { signature: string } | { signed_transaction: string };

/** A signed Solana transaction in base64 (at most 1232 bytes), the shape the gateway's confirm accepts. */
const SIGNED_TRANSACTION = /^[A-Za-z0-9+/]{4,1644}={0,2}$/;

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const apiKeyArg = z.string().optional().describe("Dagon account key (gk_...). Defaults to the DAGON_API_KEY environment variable.");

export function createDagonServer(opts: DagonOptions = {}): McpServer {
  const baseUrl = checkedHttpsUrl("DAGON_BASE_URL", opts.baseUrl || DEFAULT_BASE_URL);
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const rpcUrl = opts.solanaRpcUrl || DEFAULT_SOLANA_RPC_URL;
  const confirmAttempts = Math.max(1, opts.confirmAttempts ?? 20);
  const confirmIntervalMs = opts.confirmIntervalMs ?? 3000;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const configuredKey = opts.apiKey?.trim() || undefined;
  const configuredWallet = opts.wallet;
  let treasury: PublicKey | undefined;
  if (configuredWallet) {
    if (!configuredKey) throw new Error("DAGON_API_KEY is required when DAGON_WALLET_SECRET_KEY is configured.");
    if (!opts.treasuryWallet?.trim()) throw new Error("DAGON_TREASURY_WALLET is required when DAGON_WALLET_SECRET_KEY is configured.");
  }
  const rawTreasury = opts.treasuryWallet?.trim();
  if (rawTreasury) {
    try {
      treasury = new PublicKey(rawTreasury);
    } catch {
      throw new Error("DAGON_TREASURY_WALLET must be a base58 Solana address.");
    }
    if (configuredWallet && treasury.equals(configuredWallet.publicKey)) throw new Error("DAGON_TREASURY_WALLET must not be the configured payer wallet.");
  }
  const maxPurchaseCents = capCents("DAGON_MAX_PURCHASE_USD", opts.maxPurchaseUsd ?? DEFAULT_MAX_PURCHASE_USD);
  const maxSessionCents = capCents("DAGON_MAX_PURCHASE_USD_PER_SESSION", opts.maxPurchaseUsdPerSession ?? DEFAULT_MAX_PURCHASE_USD_PER_SESSION);
  const minPurchaseCents = capCents("DAGON_MIN_PURCHASE_USD", opts.minPurchaseUsd ?? DEFAULT_MIN_PURCHASE_USD);
  const maxDayCents = capCents("DAGON_MAX_PURCHASE_USD_PER_DAY", opts.maxPurchaseUsdPerDay ?? DEFAULT_MAX_PURCHASE_USD_PER_DAY);
  const maxSolFees = opts.maxSolFees ?? DEFAULT_MAX_SOL_FEES;
  const maxLamports = Math.round(maxSolFees * LAMPORTS_PER_SOL);
  if (!Number.isFinite(maxSolFees) || maxSolFees < 0 || !Number.isSafeInteger(maxLamports)) throw new Error("DAGON_MAX_SOL_FEES must be a non-negative SOL amount.");
  const maxDayLamports = BigInt(maxLamports);
  const ledger = new SpendLedger(opts.spendLedgerPath);
  /** Cents of purchases prepared (or in flight to be prepared) by this server process. */
  let sessionCents = 0;

  const keyFor = (override: string | undefined): string => {
    const key = override?.trim() || configuredKey;
    if (!key) throw new Error("No API key: set DAGON_API_KEY in the MCP server's environment or pass api_key. Create one with dagon_create_key.");
    return key;
  };

  /** Purchases are deliberately bound to server configuration; tool arguments can never select the beneficiary. */
  const purchaseKey = (): string => {
    if (!configuredKey) throw new Error("No purchase account: set DAGON_API_KEY in the MCP server's environment. Purchase tools do not accept an api_key override.");
    return configuredKey;
  };

  /** Calls the gateway and returns status + parsed JSON; throws with the gateway's error message on failure. */
  const call = async (method: string, path: string, init: { key?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<GatewayReply> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.key) headers.authorization = `Bearer ${init.key}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        signal: deadline(init.signal, requestTimeoutMs),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      throw new Error(`Could not reach ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let data: unknown;
    try {
      data = await readJsonCapped(res, MAX_GATEWAY_RESPONSE_BYTES);
    } catch (e) {
      throw new Error(`Bad response from ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const err = isRecord(data) && isRecord(data.error) ? data.error : null;
      const code = err && typeof err.code === "string" ? err.code : `http_${res.status}`;
      const message = err && typeof err.message === "string" ? err.message : res.statusText || "Request failed.";
      let hint = "";
      if (res.status === 402) hint = " Top up with dagon_buy_credits.";
      if (res.status === 401) hint = " Check DAGON_API_KEY.";
      throw new Error(`Dagon API error ${res.status} ${code}: ${message}${hint}`);
    }
    return { status: res.status, data };
  };

  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Confirms a payment, retrying while the gateway reports it as still pending. `proof` is the signature of a transaction
   * the payer sent itself, or the wallet-signed fee-sponsored transaction, which the payment service co-signs and sends
   * (resending the same one is safe). The whole wait is bounded by `timeoutMs`; running out of time reports the payment as
   * pending rather than failing. `signal` aborts it.
   */
  const confirm = async (key: string, purchaseId: string, proof: ConfirmProof, attempts: number, timeoutMs: number, signal?: AbortSignal) => {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; ; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { pending: true, data: null };
      const timeout = AbortSignal.timeout(remaining);
      let reply: GatewayReply;
      try {
        reply = await call("POST", "/v1/credits/purchase/confirm", {
          key,
          body: { purchase_id: purchaseId, ...proof },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (timeout.aborted && !signal?.aborted) return { pending: true, data: null };
        throw e;
      }
      const { status, data } = reply;
      const pending = status === 202 || (isRecord(data) && data.status === "pending");
      if (!pending || i + 1 >= attempts) return { pending, data };
      await sleep(Math.max(0, Math.min(confirmIntervalMs, deadline - Date.now())), undefined, { signal });
    }
  };

  const server = new McpServer({ name: "dagon-inference", version: "0.1.0" });

  server.registerTool(
    "dagon_models",
    {
      title: "List Dagon models",
      description: "List the models available on Dagon Inference, with their pricing (GET /v1/models). No API key needed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (_args, extra) => run(async () => json((await call("GET", "/v1/models", { signal: extra.signal })).data)),
  );

  server.registerTool(
    "dagon_balance",
    {
      title: "Check Dagon credit balance",
      description: "Show the credit balance of a Dagon account key in USD: total credits, total usage, available (GET /v1/credits).",
      inputSchema: { api_key: apiKeyArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ api_key }, extra) => run(async () => json((await call("GET", "/v1/credits", { key: keyFor(api_key), signal: extra.signal })).data)),
  );

  server.registerTool(
    "dagon_create_key",
    {
      title: "Create a Dagon API key",
      description:
        "Create a new Dagon account key (POST /v1/keys). The secret is shown only once: store it securely (e.g. as DAGON_API_KEY) and never paste it into shared chats or files under version control.",
      inputSchema: { name: z.string().max(80).optional().describe("Label for the key, up to 80 characters.") },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ name }, extra) =>
      run(async () => {
        // No Authorization header: a bearer on this route is treated as an admin request.
        const { data } = await call("POST", "/v1/keys", { body: name ? { name } : {}, signal: extra.signal });
        const key = isRecord(data) && typeof data.key === "string" ? data.key : null;
        if (!key) throw new Error("The gateway did not return a key.");
        return text(
          [
            `New Dagon API key: ${key}`,
            "",
            "WARNING: this secret is shown only once and cannot be recovered. Store it securely (a password manager, or DAGON_API_KEY in your MCP server config). Anyone holding it can spend its credits.",
            "",
            JSON.stringify(isRecord(data) ? data.data ?? null : null, null, 2),
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "dagon_buy_credits",
    {
      title: "Buy Dagon credits with Solana USDC",
      description:
        "Buy credits for the configured Dagon account, paid in USDC on Solana. The server checks that the gateway's transaction is exactly the USDC payment to the configured treasury (DAGON_TREASURY_WALLET). If the MCP server has a wallet (DAGON_WALLET_SECRET_KEY), it then signs and confirms it (submitting it itself unless the purchase is fee sponsored, in which case the payment service adds the fee payer's signature and submits it). Otherwise it returns the verified unsigned transaction for payer_wallet to sign; then call dagon_confirm_purchase with signed_transaction (fee sponsored: do not submit it yourself) or with the signature of the transaction you submitted (not fee sponsored).",
      inputSchema: z.strictObject({
        amount_usd: z.number().positive().describe("Amount to buy in USD (whole cents, e.g. 5 or 12.5)."),
        chain: z.literal("solana").default("solana").describe("Payment chain. Only 'solana' (USDC) is supported."),
        payer_wallet: z.string().optional().describe("Base58 Solana address that pays. Required when the server has no wallet configured."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ amount_usd, chain, payer_wallet }, extra) =>
      run(async () => {
        if (Math.abs(amount_usd * 100 - Math.round(amount_usd * 100)) > 1e-6) throw new Error("amount_usd must be in whole cents.");
        const amountCents = Math.round(amount_usd * 100);
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("amount_usd is outside the supported whole-cent range.");
        const key = purchaseKey();
        if (amountCents < minPurchaseCents) {
          throw new Error(`amount_usd ${amount_usd} is below the minimum purchase of $${(minPurchaseCents / 100).toFixed(2)} (DAGON_MIN_PURCHASE_USD). No purchase was created.`);
        }
        if (amountCents > maxPurchaseCents) {
          throw new Error(`amount_usd ${amount_usd} exceeds the per-purchase limit of $${(maxPurchaseCents / 100).toFixed(2)} (DAGON_MAX_PURCHASE_USD). No purchase was created.`);
        }
        if (sessionCents + amountCents > maxSessionCents) {
          throw new Error(
            `amount_usd ${amount_usd} would exceed this MCP session's purchase limit of $${(maxSessionCents / 100).toFixed(2)} (DAGON_MAX_PURCHASE_USD_PER_SESSION; $${(sessionCents / 100).toFixed(2)} already prepared). No purchase was created.`,
          );
        }
        if (!treasury) {
          throw new Error("DAGON_TREASURY_WALLET is not configured, so the gateway's payment transaction cannot be verified. Set it to Dagon's published treasury address. No purchase was created.");
        }
        const wallet = configuredWallet;
        const payer = wallet ? wallet.publicKey.toBase58() : payer_wallet?.trim();
        if (!payer) throw new Error("No wallet configured (DAGON_WALLET_SECRET_KEY): pass payer_wallet, the Solana address that will sign the payment.");
        if (wallet && payer_wallet && payer_wallet.trim() !== payer) {
          throw new Error(`payer_wallet ${payer_wallet} does not match the configured wallet ${payer}.`);
        }
        let payerKey: PublicKey;
        try {
          payerKey = new PublicKey(payer);
        } catch {
          throw new Error("payer_wallet must be a base58 Solana address.");
        }
        if (payerKey.equals(treasury)) throw new Error("payer_wallet must not be the treasury.");
        // Reserve before the await so concurrent calls cannot jointly exceed the caps; released if no purchase is prepared.
        if (!ledger.reserve(amountCents, 0n, maxDayCents, maxDayLamports)) {
          throw new Error(
            `amount_usd ${amount_usd} would exceed the daily purchase limit of $${(maxDayCents / 100).toFixed(2)} (DAGON_MAX_PURCHASE_USD_PER_DAY; $${(ledger.totals().cents / 100).toFixed(2)} already prepared today). No purchase was created.`,
          );
        }
        sessionCents += amountCents;
        let data: unknown;
        try {
          ({ data } = await call("POST", "/v1/credits/purchase", { key, body: { amount_usd, payer_wallet: payer, chain }, signal: extra.signal }));
        } catch (e) {
          sessionCents -= amountCents;
          ledger.release(amountCents, 0n);
          throw e;
        }
        if (
          !isRecord(data) ||
          typeof data.purchase_id !== "string" ||
          data.purchase_id.length < 1 ||
          data.purchase_id.length > 200 ||
          typeof data.unsigned_transaction !== "string" ||
          data.unsigned_transaction.length > 1_700 ||
          typeof data.amount_total !== "number" ||
          !Number.isFinite(data.amount_total) ||
          Math.round(data.amount_total * 100) !== amountCents ||
          Math.abs(data.amount_total * 100 - amountCents) > 1e-6 ||
          data.currency !== "usdc" ||
          data.chain !== "solana" ||
          data.payer_wallet !== payer ||
          typeof data.fee_sponsored !== "boolean" ||
          typeof data.blockhash !== "string" ||
          data.blockhash.length < 1 ||
          data.blockhash.length > 64
        ) {
          throw new Error("The gateway returned a purchase that does not match the requested payment.");
        }
        const purchaseId = data.purchase_id;
        const intent = {
          amountMicros: amountCents * 10_000,
          payer: payerKey,
          treasury,
          feeSponsored: data.fee_sponsored,
          blockhash: data.blockhash,
          purchaseId,
        };
        // The same byte-level validation runs whether this server signs or hands the transaction to another signer.
        const signedTx = wallet ? signTransaction(data.unsigned_transaction, wallet, intent) : null;
        const payerLamports = signedTx ? signedTx.payerLamports : validatePurchaseTransaction(data.unsigned_transaction, intent).payerLamports;
        if (!ledger.reserve(0, payerLamports, maxDayCents, maxDayLamports)) {
          throw new Error(
            `Purchase ${purchaseId} would cost the payer up to ${Number(payerLamports) / LAMPORTS_PER_SOL} SOL in network fees and treasury account rent, exceeding today's limit of ${maxSolFees} SOL (DAGON_MAX_SOL_FEES; ${Number(ledger.totals().lamports) / LAMPORTS_PER_SOL} SOL already committed). It was not signed; do not sign it elsewhere.`,
          );
        }

        if (!signedTx) {
          const solCost = payerLamports === 0n ? "the network fee is sponsored" : `it costs ${payer} up to ${Number(payerLamports) / LAMPORTS_PER_SOL} SOL in fees and treasury account rent`;
          return text(
            [
              `Purchase ${purchaseId} created: ${amountCents / 100} USDC from ${payer} to treasury ${treasury.toBase58()}, expires ${String(data.expires_at)}.`,
              "",
              `Verified: the transaction below only transfers exactly ${amountCents / 100} USDC from ${payer}'s USDC account to the treasury's USDC account, with the purchase memo; ${solCost}.`,
              "No wallet is configured on this MCP server, so the payment is not signed. Next steps:",
              `1. Sign the base64 Solana transaction below with ${payer}, without rebuilding it, before it expires.`,
              ...(data.fee_sponsored
                ? [
                    "2. Do not submit it to Solana: it is fee sponsored, and the payment service adds the fee payer's signature and submits it.",
                    `3. Call dagon_confirm_purchase with purchase_id "${purchaseId}" and signed_transaction, the base64 wallet-signed transaction.`,
                  ]
                : [
                    "2. Submit it to Solana (sendRawTransaction) before it expires.",
                    `3. Call dagon_confirm_purchase with purchase_id "${purchaseId}" and the transaction signature.`,
                  ]),
              "",
              JSON.stringify(
                {
                  purchase_id: purchaseId,
                  amount_total: data.amount_total,
                  currency: data.currency,
                  payer_wallet: payer,
                  treasury_wallet: treasury.toBase58(),
                  unsigned_transaction: data.unsigned_transaction,
                  blockhash: data.blockhash,
                  last_valid_block_height: data.last_valid_block_height,
                  fee_sponsored: data.fee_sponsored,
                  expires_at: data.expires_at,
                },
                null,
                2,
              ),
            ].join("\n"),
          );
        }

        const { signed, signature } = signedTx;
        const proof: ConfirmProof = signature === null ? { signed_transaction: signed } : { signature };
        const recovery =
          signature === null
            ? `call dagon_confirm_purchase with purchase_id "${purchaseId}" and signed_transaction "${signed}"`
            : `call dagon_confirm_purchase with purchase_id "${purchaseId}" and signature "${signature}"`;
        const payment = signature === null ? `Payment for purchase ${purchaseId}` : `Payment ${signature} for purchase ${purchaseId}`;
        // From here the payment may be on-chain: every outcome must carry the handles needed to recover it.
        try {
          if (signature !== null) {
            const sent = await sendTransaction(doFetch, rpcUrl, signed, deadline(extra.signal, requestTimeoutMs));
            if (sent !== signature) throw new Error(`Solana RPC reported signature ${sent} instead of the signed ${signature}`);
          }
          const { pending, data: result } = await confirm(key, purchaseId, proof, confirmAttempts, confirmTimeoutMs, extra.signal);
          if (pending) return text(`${payment} was submitted but is not confirmed yet. In a moment, ${recovery}.`);
          return text(`Purchase ${purchaseId} paid${signature === null ? "" : ` (signature ${signature})`}.\n\n${JSON.stringify(result, null, 2)}`);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(`${payment} may have been submitted, but it could not be confirmed (${reason}). Do not buy again: ${recovery} to check whether it landed.`);
        }
      }),
  );

  server.registerTool(
    "dagon_confirm_purchase",
    {
      title: "Confirm a Dagon credit purchase",
      description:
        "Report a dagon_buy_credits payment you signed yourself so the configured account is credited (POST /v1/credits/purchase/confirm). Fee sponsored: pass signed_transaction, the base64 wallet-signed transaction, without submitting it (the payment service adds the fee payer's signature and submits it; resending the same one is safe). Not fee sponsored: submit it yourself and pass its signature.",
      inputSchema: z.strictObject({
        purchase_id: z.string().min(1).describe("purchase_id returned by dagon_buy_credits."),
        signature: z.string().min(1).optional().describe("Base58 Solana transaction signature of the payment you submitted (not fee sponsored)."),
        signed_transaction: z
          .string()
          .regex(SIGNED_TRANSACTION, "signed_transaction must be a base64 Solana transaction.")
          .optional()
          .describe("Base64 wallet-signed transaction of a fee-sponsored purchase, not submitted."),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ purchase_id, signature, signed_transaction }, extra) =>
      run(async () => {
        if ((signature === undefined) === (signed_transaction === undefined)) {
          throw new Error("Pass exactly one of signature (not fee sponsored) or signed_transaction (fee sponsored).");
        }
        const proof: ConfirmProof = signature !== undefined ? { signature } : { signed_transaction: signed_transaction! };
        const { pending, data } = await confirm(purchaseKey(), purchase_id, proof, 1, confirmTimeoutMs, extra.signal);
        if (pending) return text(`Purchase ${purchase_id} is still pending on-chain confirmation. Try dagon_confirm_purchase again in a few seconds.`);
        return json(data);
      }),
  );

  server.registerTool(
    "dagon_chat",
    {
      title: "Chat with a Dagon model",
      description: "Send a chat completion to a Dagon model (POST /v1/chat/completions, non-streaming) and return the reply. Spends credits.",
      inputSchema: {
        model: z.string().min(1).describe("Model id from dagon_models."),
        prompt: z.string().optional().describe("User message. Use this or messages."),
        messages: z
          .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
          .optional()
          .describe("Full conversation, OpenAI chat format. Use this or prompt."),
        system: z.string().optional().describe("Optional system prompt, prepended to the conversation."),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        api_key: apiKeyArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ model, prompt, messages, system, max_tokens, temperature, api_key }, extra) =>
      run(async () => {
        const convo = [...(system ? [{ role: "system", content: system }] : []), ...(messages ?? []), ...(prompt ? [{ role: "user", content: prompt }] : [])];
        if (!convo.some((m) => m.role === "user")) throw new Error("Provide prompt or messages with at least one user message.");
        const body: Record<string, unknown> = { model, messages: convo, stream: false };
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (temperature !== undefined) body.temperature = temperature;
        const { data } = await call("POST", "/v1/chat/completions", { key: keyFor(api_key), body, signal: extra.signal });
        const choice = isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : null;
        const message = choice && isRecord(choice.message) ? choice.message : null;
        if (!message) throw new Error("The gateway returned no completion.");
        const reply = typeof message.content === "string" ? message.content : "";
        const usage = isRecord(data) && isRecord(data.usage) ? data.usage : null;
        const meta = [`model: ${isRecord(data) && typeof data.model === "string" ? data.model : model}`];
        if (usage) meta.push(`tokens: ${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out`);
        if (choice && typeof choice.finish_reason === "string") meta.push(`finish: ${choice.finish_reason}`);
        return text(`${reply}\n\n[${meta.join(", ")}]`);
      }),
  );

  return server;
}
