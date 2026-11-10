# Dagon Inference MCP server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server for
[Dagon Inference](https://inference.dagon.so): list models, check a balance, create keys, buy credits with USDC on
Solana, and chat.

[![npm](https://img.shields.io/npm/v/dagon-mcp)](https://www.npmjs.com/package/dagon-mcp) MIT licensed.

Dagon Inference serves uncensored (abliterated) open-weight LLMs through an OpenAI-compatible API, paid with USDC on
Solana. This server lets an MCP client (Claude Desktop, Claude Code, Cursor, ...) use it directly. Needs Node 22.18 or
newer; no install step:

```sh
npx -y dagon-mcp
```

Get an account key with the `dagon_create_key` tool or at <https://inference.dagon.so>.

**No MCP client?** An agent can pay per request with [x402](https://inference.dagon.so/x402-llm-api) instead: send
the request with no key, sign the USDC transfer the `402` asks for, retry, and keep the key returned in
`x-dagon-key`. No key, no SOL, no install beyond an x402 client such as `@x402/fetch` with `@x402/svm`. This server
does not pay with x402; it uses keys and the wallet purchase below.

## Tools

| Tool | What it does | Key |
| --- | --- | --- |
| `dagon_models` | `GET /v1/models`: models and prices. | no |
| `dagon_balance` | `GET /v1/credits`: credits, usage and available balance in USD. | yes |
| `dagon_create_key` | `POST /v1/keys`: creates an account key, shown once. | no |
| `dagon_buy_credits` | `{ amount_usd, chain: "solana", payer_wallet? }`: buys credits with Solana USDC. | yes |
| `dagon_confirm_purchase` | `{ purchase_id, signature }` for a payment you submitted yourself, or `{ purchase_id, signed_transaction }` for a fee-sponsored one you signed but did not submit: credits it. | yes |
| `dagon_chat` | `{ model, prompt or messages, system?, max_tokens?, temperature? }`: one non-streaming chat completion. | yes |

Balance and chat use `DAGON_API_KEY` by default and accept an `api_key` argument. Purchases and confirmations never
accept an account override: they always use the server's configured `DAGON_API_KEY`, so a tool caller cannot redirect
a configured wallet's payment to another account.

### Buying credits

`dagon_buy_credits` calls `POST /v1/credits/purchase`, then `POST /v1/credits/purchase/confirm`
([guide](https://inference.dagon.so/buy-llm-credits-from-an-agent-wallet)).

Before any gateway call, the amount must be at least `DAGON_MIN_PURCHASE_USD` (default $1), within
`DAGON_MAX_PURCHASE_USD` (per call, default $50), together with purchases this server process has already prepared
within `DAGON_MAX_PURCHASE_USD_PER_SESSION` (default $200), and together with everything prepared today (UTC) by any
server process sharing the spend ledger within `DAGON_MAX_PURCHASE_USD_PER_DAY` (default $200). Requests outside these
limits fail with a tool error and create nothing. Purchases the gateway did not create do not count. The session total
resets when the MCP server restarts; the daily total does not, because it is kept in `DAGON_SPEND_LEDGER` (default
`%APPDATA%\dagon-mcp\spend-ledger.json` on Windows, `$XDG_CONFIG_HOME/dagon-mcp/spend-ledger.json` or
`~/.config/dagon-mcp/spend-ledger.json` elsewhere; written with mode 0600 where supported). An unreadable or corrupt
ledger refuses purchases. `DAGON_TREASURY_WALLET` is required for every purchase, with or without a wallet.

When the gateway does not sponsor the network fee, the payer's worst-case SOL cost (5,000 lamports per signature, the
compute-budget priority fee, and 0.00203928 SOL rent whenever the transaction creates the treasury's USDC account) is
counted against `DAGON_MAX_SOL_FEES` per UTC day (default 0.05 SOL) in the same ledger; a purchase that would exceed it
is refused unsigned. An invalid limit stops the server at startup.

- **`DAGON_WALLET_SECRET_KEY` set:** `DAGON_API_KEY` and `DAGON_TREASURY_WALLET` are also required. The server first
  proves that the returned transaction (legacy or v0 message) is exactly the payment the payment service builds: one
  USDC `TransferChecked` of the requested amount from the configured wallet's associated token account to the
  configured treasury's associated token account, one SPL Memo whose data is the `purchase_id`, and at most one
  idempotent creation of the treasury's USDC account whose rent is paid by the fee payer. It rejects mismatched
  response metadata, amounts, mint, token program, destination, memo, blockhash, fee-payer or signer roles, lookup
  tables, duplicate keys, unrelated instructions, accounts or writable authorities; a sponsor fee payer may appear in
  no instruction except as that rent payer. Only bounded Solana compute-budget instructions may also accompany the
  transfer. After validation it signs as the wallet. A fee-sponsored transaction carries no fee payer signature: the
  server does not submit it but sends it to the gateway's confirm as `signed_transaction`, and the payment service adds
  its fee payer signature and submits it. Otherwise it submits through `DAGON_SOLANA_RPC_URL` and confirms with the
  signature. Either way it confirms the purchase for at most 45 seconds; past that it reports the purchase as pending.
  Once the payment may be on-chain, every result and error names the `purchase_id` and the transaction signature (or,
  when fee sponsored, the signed transaction): do not buy again, pass them to `dagon_confirm_purchase`. The wallet
  needs the USDC, and SOL for the fee only when the purchase is not fee sponsored. Give the client a tool timeout of at
  least 90 seconds; cancelling the tool call stops the wait.
- **No wallet:** pass `payer_wallet`. The server runs the same byte-level validation with `payer_wallet` as payer and
  transfer authority, and only then returns the unsigned base64 transaction, naming the treasury it pays and the SOL it
  can cost. A transaction that fails validation is never returned. Sign it with that wallet before it expires, without
  rebuilding it. When `fee_sponsored` is true, do not submit it: call `dagon_confirm_purchase` with `purchase_id` and
  `signed_transaction` (the base64 wallet-signed transaction). Otherwise submit it, then call `dagon_confirm_purchase`
  with `purchase_id` and its `signature`.

The secret key never leaves the server process and is never echoed, including in errors. At startup the server prints
the derived payer address to stderr; check it is the wallet you meant. The trusted treasury address is configured
independently rather than accepted from the gateway response. Use a dedicated hot wallet holding only what you intend
to spend.

Every gateway and Solana RPC request is aborted after 30 seconds or when the client cancels the tool call, and gateway
responses larger than 4 MiB are refused.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAGON_API_KEY` | none | Account key (`gk_...`) for balance, purchases and chat. Required with `DAGON_WALLET_SECRET_KEY`; purchases cannot override it. |
| `DAGON_BASE_URL` | `https://inference.dagon.so` | Gateway URL. Must be `https://`; `http://` is accepted only for `localhost`/`127.x`/`[::1]`. |
| `DAGON_WALLET_SECRET_KEY` | none | Solana secret key: 64-byte base58 (Phantom/Solflare export) or JSON byte array (`solana-keygen` file; a 32-byte seed is accepted only in this form). 32 bytes of base58 is a Solana address and is refused. Enables validated self-signed purchases. |
| `DAGON_TREASURY_WALLET` | none | Trusted Solana treasury owner whose USDC associated token account receives purchases. Required for any purchase and with `DAGON_WALLET_SECRET_KEY`. |
| `DAGON_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC for submitting signed purchases that are not fee sponsored (the payment service submits sponsored ones). |
| `DAGON_MIN_PURCHASE_USD` | `1` | Smallest single `dagon_buy_credits` amount in USD (whole cents). |
| `DAGON_MAX_PURCHASE_USD` | `50` | Largest single `dagon_buy_credits` amount in USD (whole cents). `0` disables purchases. |
| `DAGON_MAX_PURCHASE_USD_PER_SESSION` | `200` | Total USD of purchases one MCP server process may prepare. |
| `DAGON_MAX_PURCHASE_USD_PER_DAY` | `200` | Total USD of purchases per UTC day, persisted across restarts in the spend ledger. |
| `DAGON_MAX_SOL_FEES` | `0.05` | Worst-case SOL (fees plus treasury account rent) unsponsored purchases may cost the payer per UTC day. |
| `DAGON_SPEND_LEDGER` | user config dir (see above) | File holding the daily totals. |

## Install

### Claude Code

```sh
claude mcp add dagon --env DAGON_API_KEY=gk_... -- npx -y dagon-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config); write the values themselves:

```json
{
  "mcpServers": {
    "dagon": {
      "command": "npx",
      "args": ["-y", "dagon-mcp"],
      "env": {
        "DAGON_API_KEY": "gk_...",
        "DAGON_TREASURY_WALLET": "9rMdbu4KdLWH2nPXbzhm9HTKaibGZ2ckakQbW1wPh6KK"
      }
    }
  }
}
```

On Windows, if `npx` is not found, use `"command": "cmd", "args": ["/c", "npx", "-y", "dagon-mcp"]`.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "dagon": {
      "command": "npx",
      "args": ["-y", "dagon-mcp"],
      "env": { "DAGON_API_KEY": "gk_..." }
    }
  }
}
```

### Project `.mcp.json`, omp

Claude Code and omp expand `${VAR}` from your environment, so secrets stay out of the file:

```json
{
  "mcpServers": {
    "dagon": {
      "command": "npx",
      "args": ["-y", "dagon-mcp"],
      "env": {
        "DAGON_API_KEY": "${DAGON_API_KEY}",
        "DAGON_WALLET_SECRET_KEY": "${DAGON_WALLET_SECRET_KEY:-}",
        "DAGON_TREASURY_WALLET": "${DAGON_TREASURY_WALLET:-}"
      },
      "timeout": 120000
    }
  }
}
```

`timeout` is omp's per-tool timeout in milliseconds; drop it for clients that do not use it.

## Security

- `DAGON_WALLET_SECRET_KEY` is optional. Without it the server never signs anything: it returns validated unsigned
  transactions for you to sign with your own wallet. With it, use a dedicated hot wallet holding only what you intend
  to spend; the key never leaves the process and is never echoed.
- `DAGON_TREASURY_WALLET` is the trust anchor for purchases: every transaction is checked byte-for-byte to pay exactly
  that treasury, so a compromised or spoofed gateway cannot redirect funds. The published Dagon treasury is `9rMdbu4KdLWH2nPXbzhm9HTKaibGZ2ckakQbW1wPh6KK`; take it from this README or <https://inference.dagon.so>,
  not from a tool result.
- Per-call, per-session and per-day USD caps and a daily SOL fee cap bound what any tool caller can spend.
- Purchases always credit the configured `DAGON_API_KEY`; a tool caller cannot redirect them to another account.

## Development

```sh
git clone https://github.com/inkwell-finance/dagon-mcp.git
cd dagon-mcp
npm ci
npm run check   # type-check
npm test        # tool tests against a mocked fetch; no network
npm run build   # compile to dist/
```

## License

MIT © Inkwell Finance, Inc. d/b/a Dagon
