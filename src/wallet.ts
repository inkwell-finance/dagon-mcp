import { Keypair, type MessageCompiledInstruction, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { readJsonCapped } from "./http.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;
const MAX_TRANSACTION_BYTES = 1232;
const MAX_COMPUTE_UNITS = 200_000;
const MAX_CU_PRICE_MICROLAMPORTS = 50_000n;
const MAX_RPC_RESPONSE_BYTES = 64 * 1024;

export interface PurchaseIntent {
  amountMicros: number;
  payer: PublicKey;
  treasury: PublicKey;
  feeSponsored: boolean;
  blockhash: string;
  /** Gateway purchase id (the Zoneless checkout session id); the transaction's memo must equal it. */
  purchaseId: string;
}

/** Classic SPL Token associated account for `owner` and `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint = USDC_MINT): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

/**
 * Parses a Solana secret key given as base58 (the Phantom/Solflare 64-byte export format) or as a JSON byte array (the
 * solana-keygen file format). A 32-byte seed is accepted only as a JSON array: 32 bytes of base58 is what a Solana
 * address looks like, and treating a pasted public address as a seed would create a wallet anyone can derive.
 * Errors never echo the input.
 */
export function parseKeypair(raw: string): Keypair {
  const text = raw.trim();
  let bytes: Uint8Array;
  const json = text.startsWith("[");
  if (json) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new Error("DAGON_WALLET_SECRET_KEY is not valid JSON.");
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("DAGON_WALLET_SECRET_KEY must be a JSON array of bytes (0-255).");
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(text);
    } catch {
      throw new Error("DAGON_WALLET_SECRET_KEY is neither base58 nor a JSON byte array.");
    }
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32 && json) return Keypair.fromSeed(bytes);
  if (bytes.length === 32) {
    throw new Error("DAGON_WALLET_SECRET_KEY is 32 bytes of base58, which is a Solana address, not a secret key. Use the 64-byte secret key export (or a 32-byte seed as a JSON array).");
  }
  throw new Error(`DAGON_WALLET_SECRET_KEY must decode to 64 bytes (or a 32-byte seed as a JSON array), got ${bytes.length}.`);
}

const zeroSignature = (signature: Uint8Array): boolean => signature.every((byte) => byte === 0);

const transactionBytes = (base64: string): Uint8Array => {
  if (!base64 || base64.length > 1_700) throw new Error("The purchase transaction is not valid canonical base64.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_TRANSACTION_BYTES) throw new Error(`The purchase transaction exceeds Solana's ${MAX_TRANSACTION_BYTES}-byte packet limit.`);
  if (bytes.toString("base64") !== base64) throw new Error("The purchase transaction is not valid canonical base64.");
  return bytes;
};

/** Lamports per signature Solana charges as the base network fee. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Rent-exempt minimum of a 165-byte SPL token account, paid by whoever funds the treasury ATA creation. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export interface ValidatedPurchase {
  tx: VersionedTransaction;
  /** Index of the payer's signature slot. */
  walletIndex: number;
  /** Worst-case lamports the payer's SOL balance can lose: network fees and the treasury ATA rent when not sponsored. */
  payerLamports: bigint;
}

/**
 * Proves that a gateway transaction is the Zoneless checkout payment for exactly this purchase: one TransferChecked of
 * the requested USDC amount from `intent.payer`'s associated token account to the configured treasury's, signed by
 * `intent.payer`, one SPL Memo carrying the purchase id, and optionally one idempotent creation of the treasury's USDC
 * account funded by the fee payer. The only other accepted instructions are bounded compute-budget settings. Legacy and
 * v0 messages are accepted; address lookups, extra signers, accounts, instructions, and writable authorities fail closed.
 */
export function validatePurchaseTransaction(unsignedBase64: string, intent: PurchaseIntent): ValidatedPurchase {
  if (!Number.isSafeInteger(intent.amountMicros) || intent.amountMicros <= 0) throw new Error("The purchase amount is not a safe positive USDC amount.");

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(transactionBytes(unsignedBase64));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The purchase transaction")) throw error;
    throw new Error("The purchase transaction could not be decoded.");
  }
  const message = tx.message;
  if (message.version !== "legacy" && message.version !== 0) throw new Error("The purchase transaction must use a legacy or version 0 message.");
  if (message.addressTableLookups.length !== 0) throw new Error("The purchase transaction must not use address lookup tables.");
  if (message.recentBlockhash !== intent.blockhash) throw new Error("The purchase transaction blockhash does not match the purchase response.");

  const keys = message.staticAccountKeys;
  const keyStrings = keys.map((key) => key.toBase58());
  if (new Set(keyStrings).size !== keys.length) throw new Error("The purchase transaction contains duplicate account keys.");
  const payer = intent.payer;

  const requiredSigners = message.header.numRequiredSignatures;
  const walletIndex = intent.feeSponsored ? 1 : 0;
  if (requiredSigners !== (intent.feeSponsored ? 2 : 1) || !keys[walletIndex]?.equals(payer)) {
    throw new Error(
      intent.feeSponsored
        ? "A fee-sponsored purchase must be signed only by its fee payer and the configured wallet."
        : "The configured wallet must be the purchase transaction's only signer and fee payer.",
    );
  }
  if (intent.feeSponsored) {
    // Zoneless co-signs as fee payer only after the wallet has signed, so the fee payer's slot is not checked here.
    const feePayer = keys[0];
    if (!feePayer || feePayer.equals(payer)) throw new Error("The fee-sponsored purchase must name a fee payer distinct from the configured wallet.");
  }
  const walletSignature = tx.signatures[walletIndex];
  if (!walletSignature || !zeroSignature(walletSignature)) throw new Error("The purchase transaction must be unsigned by the configured wallet.");

  // `compiledInstructions` is a getter that rebuilds its objects on legacy messages; take one snapshot for identity checks.
  const instructions = message.compiledInstructions;
  let transfer: MessageCompiledInstruction | null = null;
  let createAta: MessageCompiledInstruction | null = null;
  let memo: MessageCompiledInstruction | null = null;
  let computeLimit: number | null = null;
  let computePrice: bigint | null = null;
  const expectedMemo = Buffer.from(intent.purchaseId, "utf8");
  const used = new Set<number>([0]);
  for (const instruction of instructions) {
    used.add(instruction.programIdIndex);
    for (const index of instruction.accountKeyIndexes) used.add(index);
    const program = keys[instruction.programIdIndex];
    if (!program) throw new Error("The purchase transaction contains an invalid program account.");
    const data = instruction.data;
    if (program.equals(COMPUTE_BUDGET_PROGRAM)) {
      if (instruction.accountKeyIndexes.length !== 0) throw new Error("A compute-budget instruction must not name accounts.");
      if (data[0] === 2 && data.length === 5 && computeLimit === null) {
        computeLimit = Buffer.from(data).readUInt32LE(1);
      } else if (data[0] === 3 && data.length === 9 && computePrice === null) {
        computePrice = Buffer.from(data).readBigUInt64LE(1);
      } else {
        throw new Error("The purchase transaction contains an unsupported or duplicate compute-budget instruction.");
      }
    } else if (program.equals(TOKEN_PROGRAM)) {
      if (transfer !== null || data[0] !== 12 || data.length !== 10) {
        throw new Error("The purchase transaction must contain exactly one SPL Token TransferChecked instruction.");
      }
      transfer = instruction;
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM)) {
      if (createAta !== null || data.length !== 1 || data[0] !== 1) {
        throw new Error("The purchase transaction may contain only one idempotent treasury token-account creation.");
      }
      createAta = instruction;
    } else if (program.equals(MEMO_PROGRAM)) {
      if (memo !== null || instruction.accountKeyIndexes.length !== 0 || !expectedMemo.equals(Buffer.from(data))) {
        throw new Error(`The purchase transaction must contain exactly one memo equal to purchase ${intent.purchaseId}.`);
      }
      memo = instruction;
    } else {
      throw new Error(`The purchase transaction contains an unrelated instruction from program ${program.toBase58()}.`);
    }
  }
  if (!memo) throw new Error(`The purchase transaction must contain exactly one memo equal to purchase ${intent.purchaseId}.`);
  if (computeLimit !== null && (computeLimit <= 0 || computeLimit > MAX_COMPUTE_UNITS)) {
    throw new Error(`The purchase transaction compute-unit limit may be at most ${MAX_COMPUTE_UNITS}.`);
  }
  if (computePrice !== null && (computeLimit === null || computePrice > MAX_CU_PRICE_MICROLAMPORTS)) {
    throw new Error(`The purchase transaction compute-unit price requires a limit and may be at most ${MAX_CU_PRICE_MICROLAMPORTS} microlamports.`);
  }
  if (!transfer) throw new Error("The purchase transaction has no SPL Token TransferChecked instruction.");
  if (transfer.accountKeyIndexes.length !== 4) throw new Error("The USDC transfer must have exactly one source, mint, destination, and signing authority.");

  const [sourceIndex, mintIndex, destinationIndex, authorityIndex] = transfer.accountKeyIndexes;
  const source = sourceIndex === undefined ? undefined : keys[sourceIndex];
  const mint = mintIndex === undefined ? undefined : keys[mintIndex];
  const destination = destinationIndex === undefined ? undefined : keys[destinationIndex];
  const authority = authorityIndex === undefined ? undefined : keys[authorityIndex];
  if (!source || !mint || !destination || !authority) throw new Error("The USDC transfer contains an invalid account index.");
  if (!authority.equals(payer) || authorityIndex !== walletIndex) {
    throw new Error("The configured wallet must be the USDC transfer authority.");
  }
  if (!mint.equals(USDC_MINT) || transfer.data[9] !== USDC_DECIMALS) {
    throw new Error(`The purchase transaction must transfer ${USDC_MINT.toBase58()} with ${USDC_DECIMALS} decimals.`);
  }
  if (!source.equals(associatedTokenAddress(payer))) {
    throw new Error("The purchase transaction must debit the configured wallet's USDC associated token account.");
  }
  if (!destination.equals(associatedTokenAddress(intent.treasury))) {
    throw new Error("The purchase transaction does not pay the configured treasury's USDC associated token account.");
  }
  const amount = Buffer.from(transfer.data).readBigUInt64LE(1);
  if (amount !== BigInt(intent.amountMicros)) {
    throw new Error(`The purchase transaction amount ${amount} does not match the intended ${intent.amountMicros} USDC base units.`);
  }
  if (createAta) {
    const ataKeys = createAta.accountKeyIndexes;
    const expected = [associatedTokenAddress(intent.treasury), intent.treasury, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM];
    if (
      ataKeys.length !== 6 ||
      ataKeys[0] !== 0 ||
      ataKeys[1] !== destinationIndex ||
      !expected.every((key, i) => keys[ataKeys[i + 1]!]?.equals(key))
    ) {
      throw new Error("The treasury token-account creation must be funded by the fee payer for the treasury's USDC account.");
    }
  }

  const expectedWritable = new Set([0, sourceIndex, destinationIndex]);
  for (let index = 0; index < keys.length; index++) {
    if (message.isAccountWritable(index) !== expectedWritable.has(index)) {
      throw new Error(`The purchase transaction has an unexpected writable account ${keys[index]!.toBase58()}.`);
    }
    if (!used.has(index)) throw new Error(`The purchase transaction has an unrelated account ${keys[index]!.toBase58()}.`);
  }
  // A sponsor may fund the treasury account's rent (slot 0 of that one instruction) and pay fees, nothing else.
  if (
    intent.feeSponsored &&
    instructions.some((instruction) =>
      instruction.accountKeyIndexes.some((index, position) => index === 0 && !(instruction === createAta && position === 0)),
    )
  ) {
    throw new Error("The sponsored fee payer may only pay the network fee and the treasury token-account rent.");
  }

  let payerLamports = 0n;
  if (!intent.feeSponsored) {
    const priority = computeLimit !== null && computePrice !== null ? (BigInt(computeLimit) * computePrice + 999_999n) / 1_000_000n : 0n;
    payerLamports = LAMPORTS_PER_SIGNATURE * BigInt(requiredSigners) + priority + (createAta ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n);
  }
  return { tx, walletIndex, payerLamports };
}

/**
 * Validates the purchase transaction with `keypair` as the payer (see validatePurchaseTransaction), then signs it as the
 * wallet. `signature` is the transaction id when the wallet is the fee payer; a fee-sponsored transaction has no id yet
 * (it is the fee payer's signature, added by Zoneless at confirm), so it is null.
 */
export function signTransaction(
  unsignedBase64: string,
  keypair: Keypair,
  intent: PurchaseIntent,
): { signed: string; signature: string | null; payerLamports: bigint } {
  if (!intent.payer.equals(keypair.publicKey)) throw new Error("The purchase intent payer does not match the configured wallet.");
  const { tx, walletIndex, payerLamports } = validatePurchaseTransaction(unsignedBase64, intent);
  tx.sign([keypair]);
  const own = tx.signatures[walletIndex];
  if (!own || zeroSignature(own)) throw new Error("The purchase transaction is missing the configured wallet's signature.");
  return { signed: Buffer.from(tx.serialize()).toString("base64"), signature: intent.feeSponsored ? null : bs58.encode(own), payerLamports };
}

/** Submits a signed base64 transaction through a Solana JSON-RPC endpoint and returns its signature. */
export async function sendTransaction(fetchFn: typeof fetch, rpcUrl: string, signedBase64: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchFn(rpcUrl, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [signedBase64, { encoding: "base64", preflightCommitment: "confirmed" }],
    }),
  });
  const body = (await readJsonCapped(res, MAX_RPC_RESPONSE_BYTES).catch(() => null)) as { result?: unknown; error?: { message?: unknown } } | null;
  if (!res.ok || !body || body.error || typeof body.result !== "string") {
    const msg = body?.error && typeof body.error.message === "string" ? body.error.message : `HTTP ${res.status}`;
    throw new Error(`Solana RPC rejected the transaction: ${msg}`);
  }
  return body.result;
}
