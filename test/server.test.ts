import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { createDagonServer, parseSolCap, parseUsdCap, type DagonOptions } from "../src/server.ts";
import { SpendLedger } from "../src/ledger.ts";
import { parseKeypair, USDC_MINT } from "../src/wallet.ts";

const BASE = "https://gw.test";
const RPC = "https://rpc.test";
const KEY = "gk_test_env"; // gitleaks:allow (fixture, not a secret)

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
  signal: AbortSignal | null;
}

interface Reply {
  status?: number;
  body: unknown;
}

type Route = (call: Call) => Reply | Promise<Reply>;

/** A fetch double that records every request and answers from `routes`, keyed by "METHOD url". */
function mockFetch(routes: Record<string, Route | Route[]>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method,
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    const entry = routes[`${method} ${url}`];
    const route = Array.isArray(entry) ? entry.shift() : entry;
    if (!route) throw new Error(`unexpected request ${method} ${url}`);
    const { status = 200, body } = await route(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

async function connect(opts: DagonOptions) {
  const server = createDagonServer({ baseUrl: BASE, solanaRpcUrl: RPC, confirmIntervalMs: 0, ...opts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join(""), isError: res.isError === true };
}

const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7));
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

interface PaymentTxOptions {
  payer: PublicKey;
  treasury: PublicKey;
  amountMicros: number;
  /** Checkout session id the memo carries; the gateway exposes it as purchase_id. */
  purchaseId: string;
  mint?: PublicKey;
  tokenProgram?: PublicKey;
  destinationOwner?: PublicKey;
  /** Account funding the treasury ATA; Zoneless uses the fee payer. */
  ataFunder?: PublicKey;
  writableMint?: boolean;
  writableAuthority?: boolean;
  feePayer?: Keypair;
  extraInstruction?: TransactionInstruction;
  extraTransferAccount?: PublicKey;
}

/**
 * The instructions Zoneless `BuildCheckoutPaymentTransaction` emits: idempotent treasury ATA creation funded by the fee
 * payer, TransferChecked, and a memo carrying the checkout session id.
 */
function zonelessInstructions(o: PaymentTxOptions): TransactionInstruction[] {
  const mint = o.mint ?? USDC_MINT;
  const program = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const owner = o.destinationOwner ?? o.treasury;
  const rentPayer = o.ataFunder ?? o.feePayer?.publicKey ?? o.payer;
  const source = getAssociatedTokenAddressSync(mint, o.payer, false, program);
  const destination = getAssociatedTokenAddressSync(mint, owner, true, program);
  const transfer = createTransferCheckedInstruction(source, mint, destination, o.payer, o.amountMicros, 6, [], program);
  if (o.writableMint) transfer.keys[1]!.isWritable = true;
  if (o.writableAuthority) transfer.keys[3]!.isWritable = true;
  if (o.extraTransferAccount) transfer.keys.push({ pubkey: o.extraTransferAccount, isSigner: false, isWritable: true });
  return [
    createAssociatedTokenAccountIdempotentInstruction(rentPayer, destination, owner, mint, program),
    transfer,
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(o.purchaseId, "utf8") }),
    ...(o.extraInstruction ? [o.extraInstruction] : []),
  ];
}

/** A legacy transaction built and finalized exactly like Zoneless `FinalizeUnsignedTransaction`: no signatures at all, sponsored or not. */
function paymentTx(o: PaymentTxOptions): string {
  const tx = new Transaction().add(...zonelessInstructions(o));
  tx.recentBlockhash = BLOCKHASH;
  tx.feePayer = o.feePayer?.publicKey ?? o.payer;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/** The same payment compiled to a v0 message, optionally through an address lookup table. */
function paymentTxV0(o: PaymentTxOptions, lookup?: AddressLookupTableAccount): string {
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: o.feePayer?.publicKey ?? o.payer, recentBlockhash: BLOCKHASH, instructions: zonelessInstructions(o) }).compileToV0Message(
      lookup ? [lookup] : [],
    ),
  );
  // Unsigned: a sponsored fee payer co-signs only at confirm, after the wallet.
  return Buffer.from(tx.serialize()).toString("base64");
}

/** The real payment with the USDC mint listed twice and the transfer pointing at the duplicate. */
function paymentTxDuplicateKey(o: PaymentTxOptions): string {
  const tx = new Transaction().add(...zonelessInstructions(o));
  tx.recentBlockhash = BLOCKHASH;
  tx.feePayer = o.payer;
  const message = tx.compileMessage();
  const mintIndex = message.accountKeys.findIndex((key) => key.equals(USDC_MINT));
  const duplicate = message.accountKeys.length;
  const instructions = message.instructions.map((ix) =>
    message.accountKeys[ix.programIdIndex]!.equals(TOKEN_PROGRAM_ID) ? { ...ix, accounts: ix.accounts.map((a) => (a === mintIndex ? duplicate : a)) } : ix,
  );
  const forged = new Message({
    header: { ...message.header, numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts + 1 },
    accountKeys: [...message.accountKeys, USDC_MINT],
    recentBlockhash: BLOCKHASH,
    instructions,
  });
  return Buffer.from(new VersionedTransaction(forged).serialize()).toString("base64");
}

test("lists the Dagon tools", async () => {
  const client = await connect({ fetch: mockFetch({}).fn });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "dagon_balance",
    "dagon_buy_credits",
    "dagon_chat",
    "dagon_confirm_purchase",
    "dagon_create_key",
    "dagon_models",
  ]);
  const buy = tools.find((tool) => tool.name === "dagon_buy_credits");
  assert.equal(buy?.annotations?.destructiveHint, true);
  const buyProperties = (buy?.inputSchema as { properties?: Record<string, unknown> }).properties;
  assert.equal(buyProperties?.api_key, undefined, "a caller cannot select the purchase beneficiary");
});

test("dagon_models calls GET /v1/models without a key", async () => {
  const m = mockFetch({ [`GET ${BASE}/v1/models`]: () => ({ body: { object: "list", data: [{ id: "m1" }] } }) });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_models");
  assert.equal(res.isError, false);
  assert.deepEqual(JSON.parse(res.text).data, [{ id: "m1" }]);
  assert.equal(m.calls[0]?.auth, null);
});

test("dagon_balance uses DAGON_API_KEY, accepts an override, and errors without a key", async () => {
  const m = mockFetch({ [`GET ${BASE}/v1/credits`]: () => ({ body: { data: { total_credits: 5, total_usage: 1, available: 4 } } }) });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_balance");
  assert.equal(JSON.parse(res.text).data.available, 4);
  assert.equal(m.calls[0]?.auth, `Bearer ${KEY}`);
  await callTool(client, "dagon_balance", { api_key: "gk_other" });
  assert.equal(m.calls[1]?.auth, "Bearer gk_other");

  const bare = await connect({ fetch: m.fn });
  const missing = await callTool(bare, "dagon_balance");
  assert.equal(missing.isError, true);
  assert.match(missing.text, /DAGON_API_KEY/);
});

test("dagon_create_key posts without auth and warns to store the key", async () => {
  const m = mockFetch({ [`POST ${BASE}/v1/keys`]: () => ({ status: 201, body: { key: "gk_new_secret", data: { id: "k1", name: "bot" } } }) });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_create_key", { name: "bot" });
  assert.equal(res.isError, false);
  assert.match(res.text, /gk_new_secret/);
  assert.match(res.text, /WARNING/);
  assert.equal(m.calls[0]?.auth, null);
  assert.deepEqual(m.calls[0]?.body, { name: "bot" });
});

test("API errors surface the gateway code and a top-up hint on 402", async () => {
  const m = mockFetch({
    [`POST ${BASE}/v1/chat/completions`]: () => ({ status: 402, body: { error: { code: "insufficient_credits", message: "Out of credits." } } }),
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_chat", { model: "m1", prompt: "hi" });
  assert.equal(res.isError, true);
  assert.match(res.text, /402 insufficient_credits: Out of credits\. Top up with dagon_buy_credits/);
});

test("dagon_chat sends an OpenAI chat request and returns the reply", async () => {
  const m = mockFetch({
    [`POST ${BASE}/v1/chat/completions`]: () => ({
      body: {
        model: "m1",
        choices: [{ message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    }),
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_chat", { model: "m1", system: "be brief", prompt: "hi", max_tokens: 50 });
  assert.equal(res.isError, false);
  assert.match(res.text, /^hello there/);
  assert.match(res.text, /3 in \/ 2 out/);
  assert.deepEqual(m.calls[0]?.body, {
    model: "m1",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    stream: false,
    max_tokens: 50,
  });

  const empty = await callTool(client, "dagon_chat", { model: "m1" });
  assert.equal(empty.isError, true);
});

test("dagon_buy_credits without a wallet returns the configured account's verified unsigned transaction", async () => {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const tx = paymentTx({ payer, treasury, amountMicros: 5_000_000, purchaseId: "pur_1" });
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: () => ({
      status: 201,
      body: {
        purchase_id: "pur_1",
        amount_total: 5,
        currency: "usdc",
        chain: "solana",
        payer_wallet: payer.toBase58(),
        unsigned_transaction: tx,
        blockhash: BLOCKHASH,
        last_valid_block_height: 100,
        fee_sponsored: false,
        expires_at: "2026-11-03T12:00:00Z",
        confirm_url: `${BASE}/v1/credits/purchase/confirm`,
      },
    }),
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, treasuryWallet: treasury.toBase58() });

  const noPayer = await callTool(client, "dagon_buy_credits", { amount_usd: 5, chain: "solana" });
  assert.equal(noPayer.isError, true);
  assert.match(noPayer.text, /payer_wallet/);

  const cents = await callTool(client, "dagon_buy_credits", { amount_usd: 5.001, payer_wallet: payer.toBase58() });
  assert.equal(cents.isError, true);

  const override = await callTool(client, "dagon_buy_credits", {
    amount_usd: 5,
    chain: "solana",
    payer_wallet: payer.toBase58(),
    api_key: "gk_model_selected",
  });
  assert.equal(override.isError, true);
  assert.match(override.text, /api_key/);
  assert.equal(m.calls.length, 0, "an account override is rejected before opening a purchase");
  const res = await callTool(client, "dagon_buy_credits", {
    amount_usd: 5,
    chain: "solana",
    payer_wallet: payer.toBase58(),
  });
  assert.equal(res.isError, false);
  assert.match(res.text, /dagon_confirm_purchase/);
  assert.match(res.text, /Verified: the transaction below only transfers exactly 5 USDC/);
  assert.ok(res.text.includes(treasury.toBase58()), "the destination owner is shown");
  assert.ok(res.text.includes(tx));
  assert.doesNotMatch(res.text, /confirm_url/, "gateway-supplied URLs are not relayed");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.auth, `Bearer ${KEY}`, "purchase uses the configured account key");
  assert.deepEqual(m.calls[0]?.body, { amount_usd: 5, payer_wallet: payer.toBase58(), chain: "solana" });
});

test("dagon_buy_credits enforces the per-purchase and per-session caps before calling the gateway", async () => {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const prepared = (amount: number, id: string): Route => () => ({
    status: 201,
    body: {
      purchase_id: id,
      amount_total: amount,
      currency: "usdc",
      chain: "solana",
      payer_wallet: payer.toBase58(),
      unsigned_transaction: paymentTx({ payer, treasury, amountMicros: amount * 1_000_000, purchaseId: id }),
      blockhash: BLOCKHASH,
      last_valid_block_height: 100,
      fee_sponsored: false,
      expires_at: "2026-11-03T12:00:00Z",
    },
  });
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: [
      prepared(20, "pur_a"),
      () => ({ status: 502, body: { error: { code: "upstream", message: "bad gateway" } } }),
      prepared(20, "pur_b"),
    ],
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, treasuryWallet: treasury.toBase58(), maxPurchaseUsd: 25, maxPurchaseUsdPerSession: 40 });
  const buy = (amount_usd: number) => callTool(client, "dagon_buy_credits", { amount_usd, payer_wallet: payer.toBase58() });

  const tooBig = await buy(25.01);
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.text, /per-purchase limit of \$25\.00 \(DAGON_MAX_PURCHASE_USD\)/);
  assert.equal(m.calls.length, 0, "an over-cap amount never reaches the gateway");

  assert.equal((await buy(20)).isError, false, "within both caps proceeds");
  assert.equal(m.calls.length, 1);

  const failed = await buy(20);
  assert.equal(failed.isError, true, "gateway failure");
  assert.equal(m.calls.length, 2);

  assert.equal((await buy(20)).isError, false, "a purchase the gateway never prepared does not count toward the session cap");
  assert.equal(m.calls.length, 3);

  const overSession = await buy(1);
  assert.equal(overSession.isError, true);
  assert.match(overSession.text, /session's purchase limit of \$40\.00 \(DAGON_MAX_PURCHASE_USD_PER_SESSION; \$40\.00 already prepared\)/);
  assert.equal(m.calls.length, 3, "an over-session amount never reaches the gateway");
});

test("default purchase caps are $50 per call and $200 per session; invalid caps fail closed", async () => {
  const m = mockFetch({});
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 50.01, payer_wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(res.isError, true);
  assert.match(res.text, /per-purchase limit of \$50\.00/);
  assert.equal(m.calls.length, 0);

  assert.equal(parseUsdCap("DAGON_MAX_PURCHASE_USD", undefined), undefined);
  assert.equal(parseUsdCap("DAGON_MAX_PURCHASE_USD", " 12.5 "), 12.5);
  for (const bad of ["-1", "abc", "1.001", "1e3", "Infinity"]) {
    assert.throws(() => parseUsdCap("DAGON_MAX_PURCHASE_USD", bad), /DAGON_MAX_PURCHASE_USD must be/, bad);
  }
  assert.throws(() => createDagonServer({ maxPurchaseUsdPerSession: -1 }), /DAGON_MAX_PURCHASE_USD_PER_SESSION/);
});

test("dagon_buy_credits signs the legacy transaction Zoneless builds after validating it", async () => {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const unsigned = paymentTx({ payer: wallet.publicKey, treasury, amountMicros: 10_000_000, purchaseId: "pur_2" });
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: () => ({
      status: 201,
      body: {
        purchase_id: "pur_2",
        amount_total: 10,
        currency: "usdc",
        chain: "solana",
        payer_wallet: wallet.publicKey.toBase58(),
        unsigned_transaction: unsigned,
        blockhash: BLOCKHASH,
        fee_sponsored: false,
      },
    }),
    [`POST ${RPC}`]: (call) => {
      const params = (call.body as { params: [string] }).params;
      const sent = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
      assert.ok(sent.signatures[0]?.some((byte) => byte !== 0), "transaction is signed");
      assert.equal(sent.message.version, "legacy");
      assert.equal(sent.message.compiledInstructions.length, 3, "validated message is submitted unchanged");
      return { body: { jsonrpc: "2.0", id: 1, result: bs58.encode(sent.signatures[0]!) } };
    },
    [`POST ${BASE}/v1/credits/purchase/confirm`]: [
      () => ({ status: 202, body: { status: "pending", purchase_id: "pur_2" } }),
      () => ({ body: { status: "credited", credited_usd: 10, balance: 14 } }),
    ],
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58() });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 10, chain: "solana" });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /credited/);
  assert.deepEqual(
    m.calls.map((call) => `${call.method} ${call.url}`),
    [`POST ${BASE}/v1/credits/purchase`, `POST ${RPC}`, `POST ${BASE}/v1/credits/purchase/confirm`, `POST ${BASE}/v1/credits/purchase/confirm`],
  );
  assert.equal(m.calls[0]?.auth, `Bearer ${KEY}`);
  assert.equal((m.calls[0]?.body as { payer_wallet: string }).payer_wallet, wallet.publicKey.toBase58());
  const confirmBody = m.calls[2]?.body as { purchase_id: string; signature: string };
  assert.equal(confirmBody.purchase_id, "pur_2");
  assert.equal(bs58.decode(confirmBody.signature).length, 64);

  const mismatch = await callTool(client, "dagon_buy_credits", { amount_usd: 10, payer_wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(mismatch.isError, true);
});

test("dagon_buy_credits signs a sponsored Zoneless payment (legacy and v0) as the wallet and hands it to confirm unsent", async () => {
  const wallet = Keypair.generate();
  const feePayer = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const options = { payer: wallet.publicKey, treasury, amountMicros: 5_000_000, purchaseId: "pur_sponsored", feePayer };
  for (const unsigned of [paymentTx(options), paymentTxV0(options)]) {
    const m = mockFetch({
      [`POST ${BASE}/v1/credits/purchase`]: () => ({
        status: 201,
        body: {
          purchase_id: "pur_sponsored",
          amount_total: 5,
          currency: "usdc",
          chain: "solana",
          payer_wallet: wallet.publicKey.toBase58(),
          unsigned_transaction: unsigned,
          blockhash: BLOCKHASH,
          fee_sponsored: true,
        },
      }),
      [`POST ${BASE}/v1/credits/purchase/confirm`]: [
        () => ({ status: 202, body: { status: "pending", purchase_id: "pur_sponsored" } }),
        () => ({ body: { status: "credited", credited_usd: 5, balance: 5 } }),
      ],
    });
    const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58() });
    const res = await callTool(client, "dagon_buy_credits", { amount_usd: 5 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /credited/);
    assert.deepEqual(
      m.calls.map((call) => `${call.method} ${call.url}`),
      [`POST ${BASE}/v1/credits/purchase`, `POST ${BASE}/v1/credits/purchase/confirm`, `POST ${BASE}/v1/credits/purchase/confirm`],
      "a sponsored transaction never reaches the RPC",
    );
    const body = m.calls[1]?.body as { purchase_id: string; signed_transaction: string; signature?: string };
    assert.equal(body.purchase_id, "pur_sponsored");
    assert.equal(body.signature, undefined);
    assert.deepEqual(m.calls[2]?.body, body, "the pending retry resends the same signed transaction");
    const signed = VersionedTransaction.deserialize(Buffer.from(body.signed_transaction, "base64"));
    const original = VersionedTransaction.deserialize(Buffer.from(unsigned, "base64"));
    assert.deepEqual(Buffer.from(signed.message.serialize()), Buffer.from(original.message.serialize()), "the message is signed unchanged");
    assert.ok(signed.signatures[0]?.every((byte) => byte === 0), "the fee payer slot is left for the payment service");
    assert.ok(signed.signatures[1]?.some((byte) => byte !== 0), "the configured wallet signs only its authority slot");
  }
});

test("a sponsored purchase whose confirmation fails carries the purchase id and the signed transaction", async () => {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const unsigned = paymentTx({ payer: wallet.publicKey, treasury, amountMicros: 5_000_000, purchaseId: "pur_sp_down", feePayer: Keypair.generate() });
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: () => ({
      status: 201,
      body: {
        purchase_id: "pur_sp_down",
        amount_total: 5,
        currency: "usdc",
        chain: "solana",
        payer_wallet: wallet.publicKey.toBase58(),
        unsigned_transaction: unsigned,
        blockhash: BLOCKHASH,
        fee_sponsored: true,
      },
    }),
    [`POST ${BASE}/v1/credits/purchase/confirm`]: () => ({ status: 502, body: { error: { code: "upstream", message: "bad gateway" } } }),
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58() });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 5 });
  assert.equal(res.isError, true);
  const sent = (m.calls[1]?.body as { signed_transaction: string }).signed_transaction;
  assert.ok(res.text.includes("pur_sp_down") && res.text.includes(`signed_transaction "${sent}"`), res.text);
  assert.match(res.text, /Do not buy again/);
  assert.ok(m.calls.every((call) => call.url !== RPC));
});

test("dagon_buy_credits without a wallet tells the signer not to submit a sponsored transaction", async () => {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const tx = paymentTx({ payer, treasury, amountMicros: 5_000_000, purchaseId: "pur_sp", feePayer: Keypair.generate() });
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: () => ({
      status: 201,
      body: {
        purchase_id: "pur_sp",
        amount_total: 5,
        currency: "usdc",
        chain: "solana",
        payer_wallet: payer.toBase58(),
        unsigned_transaction: tx,
        blockhash: BLOCKHASH,
        fee_sponsored: true,
      },
    }),
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, treasuryWallet: treasury.toBase58() });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 5, payer_wallet: payer.toBase58() });
  assert.equal(res.isError, false, res.text);
  assert.ok(res.text.includes(tx));
  assert.match(res.text, /Do not submit it to Solana/);
  assert.match(res.text, /dagon_confirm_purchase with purchase_id "pur_sp" and signed_transaction/);
  assert.doesNotMatch(res.text, /sendRawTransaction/);
});

test("dagon_buy_credits refuses transactions that deviate from the Zoneless payment", async () => {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const wrongSigner = Keypair.generate();
  const feePayer = Keypair.generate();
  const purchaseId = "pur_bad";
  const base = { payer: wallet.publicKey, treasury, amountMicros: 10_000_000, purchaseId };
  const sponsored = { ...base, feePayer };
  const lookup = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [SystemProgram.programId] },
  });
  const cases: {
    name: string;
    transaction: string;
    feeSponsored: boolean;
    error: RegExp;
    amountTotal?: number;
    responsePayer?: string;
    blockhash?: string;
  }[] = [
    { name: "amount", transaction: paymentTx({ ...base, amountMicros: 9_999_999 }), feeSponsored: false, error: /amount .* does not match/ },
    { name: "gateway amount", transaction: paymentTx(base), amountTotal: 9, feeSponsored: false, error: /does not match the requested payment/ },
    {
      name: "gateway payer",
      transaction: paymentTx(base),
      responsePayer: Keypair.generate().publicKey.toBase58(),
      feeSponsored: false,
      error: /does not match the requested payment/,
    },
    {
      name: "gateway blockhash",
      transaction: paymentTx(base),
      blockhash: bs58.encode(new Uint8Array(32).fill(8)),
      feeSponsored: false,
      error: /blockhash does not match/,
    },
    { name: "mint", transaction: paymentTx({ ...base, mint: Keypair.generate().publicKey }), feeSponsored: false, error: /must transfer .* with 6 decimals/ },
    {
      name: "treasury",
      transaction: paymentTx({ ...base, destinationOwner: Keypair.generate().publicKey }),
      feeSponsored: false,
      error: /configured treasury/,
    },
    { name: "signer", transaction: paymentTx({ ...base, payer: wrongSigner.publicKey }), feeSponsored: false, error: /only signer and fee payer/ },
    { name: "fee payer role", transaction: paymentTx(base), feeSponsored: true, error: /fee-sponsored purchase must be signed only/ },
    {
      name: "extra instruction",
      transaction: paymentTx({
        ...base,
        extraInstruction: SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
      }),
      feeSponsored: false,
      error: /unrelated instruction/,
    },
    {
      name: "second memo",
      transaction: paymentTx({ ...base, extraInstruction: new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(purchaseId) }) }),
      feeSponsored: false,
      error: /exactly one memo/,
    },
    { name: "memo mismatch", transaction: paymentTx({ ...base, purchaseId: "pur_other" }), feeSponsored: false, error: /exactly one memo equal to purchase pur_bad/ },
    {
      name: "ATA funded by wallet",
      transaction: paymentTx({ ...sponsored, ataFunder: wallet.publicKey }),
      feeSponsored: true,
      error: /funded by the fee payer/,
    },
    { name: "Token-2022", transaction: paymentTx({ ...base, tokenProgram: TOKEN_2022_PROGRAM_ID }), feeSponsored: false, error: /unrelated instruction from program Tokenz/ },
    { name: "writable authority", transaction: paymentTx({ ...sponsored, writableAuthority: true }), feeSponsored: true, error: /unexpected writable account/ },
    {
      name: "extra transfer account",
      transaction: paymentTx({ ...base, extraTransferAccount: Keypair.generate().publicKey }),
      feeSponsored: false,
      error: /exactly one source, mint, destination, and signing authority/,
    },
    { name: "unexpected writable account", transaction: paymentTx({ ...base, writableMint: true }), feeSponsored: false, error: /unexpected writable account/ },
    {
      name: "fee payer named by another instruction",
      transaction: paymentTx({
        ...sponsored,
        extraInstruction: new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: feePayer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from(purchaseId) }),
      }),
      feeSponsored: true,
      error: /exactly one memo/,
    },
    { name: "address lookup table", transaction: paymentTxV0(base, lookup), feeSponsored: false, error: /address lookup tables/ },
    { name: "duplicate keys", transaction: paymentTxDuplicateKey(base), feeSponsored: false, error: /duplicate account keys/ },
    {
      name: "excess priority fee",
      transaction: paymentTx({ ...base, extraInstruction: ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_001 }) }),
      feeSponsored: false,
      error: /compute-unit price requires a limit and may be at most 50000/,
    },
  ];
  const purchaseRoutes: Route[] = cases.map((item) => () => ({
    status: 201,
    body: {
      purchase_id: purchaseId,
      amount_total: item.amountTotal ?? 10,
      currency: "usdc",
      chain: "solana",
      payer_wallet: item.responsePayer ?? wallet.publicKey.toBase58(),
      unsigned_transaction: item.transaction,
      blockhash: item.blockhash ?? BLOCKHASH,
      fee_sponsored: item.feeSponsored,
    },
  }));
  const m = mockFetch({ [`POST ${BASE}/v1/credits/purchase`]: purchaseRoutes });
  const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58() });

  for (const item of cases) {
    const res = await callTool(client, "dagon_buy_credits", { amount_usd: 10 });
    assert.equal(res.isError, true, item.name);
    assert.match(res.text, item.error, item.name);
  }
  assert.equal(m.calls.length, cases.length, "no rejected transaction reaches the RPC or confirmation endpoint");
  assert.ok(m.calls.every((call) => call.url === `${BASE}/v1/credits/purchase`));
});

/** A wallet-backed purchase whose payment validates, with RPC and confirm behaviour supplied by the caller. */
async function submittedPurchase(rpc: Route, confirmRoute: Route, opts: Partial<DagonOptions> = {}) {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const unsigned = paymentTx({ payer: wallet.publicKey, treasury, amountMicros: 10_000_000, purchaseId: "pur_after" });
  let signature = "";
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase`]: () => ({
      status: 201,
      body: {
        purchase_id: "pur_after",
        amount_total: 10,
        currency: "usdc",
        chain: "solana",
        payer_wallet: wallet.publicKey.toBase58(),
        unsigned_transaction: unsigned,
        blockhash: BLOCKHASH,
        fee_sponsored: false,
      },
    }),
    [`POST ${RPC}`]: (call) => {
      const sent = VersionedTransaction.deserialize(Buffer.from((call.body as { params: [string] }).params[0], "base64"));
      signature = bs58.encode(sent.signatures[0]!);
      return rpc(call);
    },
    [`POST ${BASE}/v1/credits/purchase/confirm`]: confirmRoute,
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58(), ...opts });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 10 });
  return { res, signature: () => signature, calls: m.calls };
}

const rpcAccepts: Route = (call) => {
  const sent = VersionedTransaction.deserialize(Buffer.from((call.body as { params: [string] }).params[0], "base64"));
  return { body: { jsonrpc: "2.0", id: 1, result: bs58.encode(sent.signatures[0]!) } };
};

test("dagon_buy_credits errors after submission carry the purchase id and signature", async () => {
  const gatewayDown = await submittedPurchase(rpcAccepts, () => ({ status: 502, body: { error: { code: "upstream", message: "bad gateway" } } }));
  assert.equal(gatewayDown.res.isError, true);
  assert.ok(gatewayDown.signature().length > 0);
  assert.ok(gatewayDown.res.text.includes("pur_after"), gatewayDown.res.text);
  assert.ok(gatewayDown.res.text.includes(gatewayDown.signature()), gatewayDown.res.text);
  assert.match(gatewayDown.res.text, /Do not buy again/);

  const rpcDown = await submittedPurchase(() => {
    throw new Error("socket hang up");
  }, () => ({ body: {} }));
  assert.equal(rpcDown.res.isError, true);
  assert.ok(rpcDown.res.text.includes("pur_after"), rpcDown.res.text);
  assert.ok(rpcDown.res.text.includes(rpcDown.signature()), rpcDown.res.text);
});

test("dagon_buy_credits bounds the confirmation wait and reports the recovery handles", async () => {
  const hanging: Route = (call) => {
    const { promise, reject } = Promise.withResolvers<Reply>();
    call.signal?.addEventListener("abort", () => reject(call.signal!.reason), { once: true });
    return promise;
  };
  const started = Date.now();
  const slow = await submittedPurchase(rpcAccepts, hanging, { confirmTimeoutMs: 100 });
  assert.ok(Date.now() - started < 5_000, "the confirm wait is bounded");
  assert.equal(slow.res.isError, false, slow.res.text);
  assert.match(slow.res.text, /not confirmed yet/);
  assert.ok(slow.res.text.includes("pur_after") && slow.res.text.includes(slow.signature()), slow.res.text);
});

test("wallet-backed purchases require a configured account and trusted treasury", () => {
  const wallet = Keypair.generate();
  assert.throws(() => createDagonServer({ wallet }), /DAGON_API_KEY is required/);
  assert.throws(() => createDagonServer({ wallet, apiKey: KEY }), /DAGON_TREASURY_WALLET is required/);
  assert.throws(() => createDagonServer({ wallet, apiKey: KEY, treasuryWallet: "not-base58" }), /base58 Solana address/);
  assert.throws(() => createDagonServer({ wallet, apiKey: KEY, treasuryWallet: wallet.publicKey.toBase58() }), /must not be the configured payer/);
});

test("dagon_confirm_purchase reports pending and credited", async () => {
  const m = mockFetch({
    [`POST ${BASE}/v1/credits/purchase/confirm`]: [
      () => ({ status: 202, body: { status: "pending", purchase_id: "pur_4" } }),
      () => ({ body: { status: "credited", credited_usd: 5, balance: 5 } }),
    ],
  });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const override = await callTool(client, "dagon_confirm_purchase", { purchase_id: "pur_4", signature: "sig", api_key: "gk_attacker" });
  assert.equal(override.isError, true);
  assert.match(override.text, /api_key/);
  const pending = await callTool(client, "dagon_confirm_purchase", { purchase_id: "pur_4", signature: "sig" });
  assert.match(pending.text, /still pending/);
  const done = await callTool(client, "dagon_confirm_purchase", { purchase_id: "pur_4", signature: "sig" });
  assert.equal(JSON.parse(done.text).status, "credited");
  assert.deepEqual(m.calls[0]?.body, { purchase_id: "pur_4", signature: "sig" });
  assert.equal(m.calls[0]?.auth, `Bearer ${KEY}`);
});

test("dagon_confirm_purchase forwards a sponsored signed_transaction and takes exactly one proof", async () => {
  const m = mockFetch({ [`POST ${BASE}/v1/credits/purchase/confirm`]: () => ({ body: { status: "credited", credited_usd: 5, balance: 5 } }) });
  const client = await connect({ fetch: m.fn, apiKey: KEY });
  const done = await callTool(client, "dagon_confirm_purchase", { purchase_id: "pur_5", signed_transaction: "AQIDBA==" });
  assert.equal(done.isError, false, done.text);
  assert.deepEqual(m.calls[0]?.body, { purchase_id: "pur_5", signed_transaction: "AQIDBA==" });

  for (const args of [{ purchase_id: "pur_5" }, { purchase_id: "pur_5", signature: "sig", signed_transaction: "AQIDBA==" }, { purchase_id: "pur_5", signed_transaction: "not base64!" }]) {
    const res = await callTool(client, "dagon_confirm_purchase", args);
    assert.equal(res.isError, true, JSON.stringify(args));
  }
  assert.equal(m.calls.length, 1, "a rejected proof never reaches the gateway");
});

test("parseKeypair accepts base58 secret keys, JSON arrays and JSON seeds; rejects 32-byte base58", () => {
  const kp = Keypair.generate();
  assert.ok(parseKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey));
  assert.ok(parseKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey));
  assert.ok(parseKeypair(JSON.stringify(Array.from(kp.secretKey.slice(0, 32)))).publicKey.equals(kp.publicKey));
  assert.throws(() => parseKeypair(kp.publicKey.toBase58()), /Solana address, not a secret key/, "a pasted address is not a seed");
  assert.throws(() => parseKeypair(bs58.encode(kp.secretKey.slice(0, 32))), /not a secret key/);
  assert.throws(() => parseKeypair("[1,2,3]"), /64 bytes/);
  assert.throws(() => parseKeypair("not-base58-0OIl"), /neither base58/);
});

/** A gateway purchase reply for `payer` paying `treasury`, built like Zoneless (unsponsored, with ATA creation). */
function purchaseReply(payer: PublicKey, treasury: PublicKey, amount: number, id: string, tx?: string): Route {
  return () => ({
    status: 201,
    body: {
      purchase_id: id,
      amount_total: amount,
      currency: "usdc",
      chain: "solana",
      payer_wallet: payer.toBase58(),
      unsigned_transaction: tx ?? paymentTx({ payer, treasury, amountMicros: Math.round(amount * 1_000_000), purchaseId: id }),
      blockhash: BLOCKHASH,
      fee_sponsored: false,
      expires_at: "2026-11-03T12:00:00Z",
      confirm_url: "https://evil.example/confirm",
    },
  });
}

test("no-wallet mode validates the transaction bytes and never relays a malicious one", async () => {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const attacker = Keypair.generate().publicKey;
  const drain = paymentTx({ payer, treasury, amountMicros: 5_000_000, purchaseId: "pur_x", destinationOwner: attacker });
  const m = mockFetch({ [`POST ${BASE}/v1/credits/purchase`]: purchaseReply(payer, treasury, 5, "pur_x", drain) });
  const client = await connect({ fetch: m.fn, apiKey: KEY, treasuryWallet: treasury.toBase58() });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 5, payer_wallet: payer.toBase58() });
  assert.equal(res.isError, true);
  assert.match(res.text, /configured treasury/);
  assert.ok(!res.text.includes(drain), "the unverified transaction is not handed to the agent");
  assert.doesNotMatch(res.text, /Sign the/);

  const noTreasury = mockFetch({});
  const bare = await connect({ fetch: noTreasury.fn, apiKey: KEY });
  const refused = await callTool(bare, "dagon_buy_credits", { amount_usd: 5, payer_wallet: payer.toBase58() });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /DAGON_TREASURY_WALLET is not configured/);
  assert.equal(noTreasury.calls.length, 0, "no purchase is opened without a treasury to verify against");

  const badPayer = await callTool(client, "dagon_buy_credits", { amount_usd: 5, payer_wallet: "not-an-address" });
  assert.equal(badPayer.isError, true);
  assert.match(badPayer.text, /base58 Solana address/);
});

test("purchases below DAGON_MIN_PURCHASE_USD are refused before calling the gateway", async () => {
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const m = mockFetch({});
  const client = await connect({ fetch: m.fn, apiKey: KEY, treasuryWallet: treasury.toBase58() });
  const res = await callTool(client, "dagon_buy_credits", { amount_usd: 0.99, payer_wallet: payer.toBase58() });
  assert.equal(res.isError, true);
  assert.match(res.text, /below the minimum purchase of \$1\.00 \(DAGON_MIN_PURCHASE_USD\)/);
  assert.equal(m.calls.length, 0);

  const lower = mockFetch({ [`POST ${BASE}/v1/credits/purchase`]: purchaseReply(payer, treasury, 0.5, "pur_small") });
  const relaxed = await connect({ fetch: lower.fn, apiKey: KEY, treasuryWallet: treasury.toBase58(), minPurchaseUsd: 0.5 });
  assert.equal((await callTool(relaxed, "dagon_buy_credits", { amount_usd: 0.5, payer_wallet: payer.toBase58() })).isError, false);
});

test("DAGON_MAX_SOL_FEES caps the worst-case fees and treasury rent an unsponsored purchase costs the payer", async () => {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const m = mockFetch({ [`POST ${BASE}/v1/credits/purchase`]: [purchaseReply(wallet.publicKey, treasury, 5, "pur_f1"), purchaseReply(wallet.publicKey, treasury, 5, "pur_f2")] });
  // One purchase: 5,000 lamports fee + 2,039,280 lamports ATA rent.
  const client = await connect({ fetch: m.fn, apiKey: KEY, wallet, treasuryWallet: treasury.toBase58(), maxSolFees: 0.003 });
  const first = await callTool(client, "dagon_buy_credits", { amount_usd: 5 });
  assert.equal(first.isError, true, "RPC is not routed, so submission fails after the cap admits it");
  assert.match(first.text, /may have been submitted/);
  const second = await callTool(client, "dagon_buy_credits", { amount_usd: 5 });
  assert.equal(second.isError, true);
  assert.match(second.text, /exceeding today's limit of 0\.003 SOL \(DAGON_MAX_SOL_FEES/);
  assert.match(second.text, /not signed/);
  assert.equal(m.calls.filter((c) => c.url === RPC).length, 1, "the over-cap purchase never reaches the RPC");

  assert.equal(parseSolCap("DAGON_MAX_SOL_FEES", " 0.05 "), 0.05);
  assert.throws(() => parseSolCap("DAGON_MAX_SOL_FEES", "-1"), /DAGON_MAX_SOL_FEES/);
});

test("the daily purchase cap persists across server restarts through the spend ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dagon-ledger-"));
  const ledgerPath = join(dir, "nested", "spend.json");
  const payer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const opts = { apiKey: KEY, treasuryWallet: treasury.toBase58(), maxPurchaseUsdPerDay: 30, spendLedgerPath: ledgerPath };

  const m1 = mockFetch({ [`POST ${BASE}/v1/credits/purchase`]: purchaseReply(payer, treasury, 20, "pur_d1") });
  const first = await connect({ ...opts, fetch: m1.fn });
  assert.equal((await callTool(first, "dagon_buy_credits", { amount_usd: 20, payer_wallet: payer.toBase58() })).isError, false);

  const m2 = mockFetch({});
  const restarted = await connect({ ...opts, fetch: m2.fn });
  const res = await callTool(restarted, "dagon_buy_credits", { amount_usd: 20, payer_wallet: payer.toBase58() });
  assert.equal(res.isError, true);
  assert.match(res.text, /daily purchase limit of \$30\.00 \(DAGON_MAX_PURCHASE_USD_PER_DAY; \$20\.00 already prepared today\)/);
  assert.equal(m2.calls.length, 0);
  if (process.platform !== "win32") assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);

  let now = new Date("2026-11-07T23:00:00Z");
  const ledger = new SpendLedger(ledgerPath, () => now);
  writeFileSync(ledgerPath, JSON.stringify({ day: "2026-11-07", cents: 3000, lamports: "0" }));
  assert.equal(ledger.reserve(100, 0n, 3000, 0n), false);
  now = new Date("2026-11-08T00:00:01Z");
  assert.equal(ledger.reserve(100, 0n, 3000, 0n), true, "the cap resets on the next UTC day");

  writeFileSync(ledgerPath, "garbage");
  assert.throws(() => ledger.reserve(100, 0n, 3000, 0n), /corrupt; refusing to purchase/);
});

test("gateway calls are bounded by a deadline and a response size cap; the base URL must be https", async () => {
  const hanging = mockFetch({
    [`GET ${BASE}/v1/models`]: (call) => {
      const { promise, reject } = Promise.withResolvers<Reply>();
      call.signal?.addEventListener("abort", () => reject(call.signal!.reason), { once: true });
      return promise;
    },
  });
  const client = await connect({ fetch: hanging.fn, requestTimeoutMs: 50 });
  const started = Date.now();
  const res = await callTool(client, "dagon_models");
  assert.equal(res.isError, true);
  assert.match(res.text, /Could not reach/);
  assert.ok(Date.now() - started < 5_000);

  const huge = mockFetch({ [`GET ${BASE}/v1/models`]: () => ({ body: { data: "x".repeat(5 * 1024 * 1024) } }) });
  const big = await callTool(await connect({ fetch: huge.fn }), "dagon_models");
  assert.equal(big.isError, true);
  assert.match(big.text, /response exceeds/);

  assert.throws(() => createDagonServer({ baseUrl: "http://gw.example" }), /DAGON_BASE_URL must use https/);
  assert.doesNotThrow(() => createDagonServer({ baseUrl: "http://127.0.0.1:8787" }));
  assert.doesNotThrow(() => createDagonServer({ baseUrl: "http://localhost:8787/" }));
});
