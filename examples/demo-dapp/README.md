# solana-rpc-shield — wallet demo (devnet)

A minimal dApp that consumes the SDK **as a built package** (`file:../..` dependency —
exactly what `npm install solana-rpc-shield` gives a real consumer) and drives a
wallet-signed transfer through the full resilient pipeline.

## Run

> Step 1 is not optional: the `file:../..` dependency packs the SDK's `dist/` —
> installing here before building the root gives a confusing empty-package
> runtime error, not an install error.

```bash
# 1. build the SDK once at the repo root
cd ../.. && npm install && npm run build

# 2. install + start the demo
cd examples/demo-dapp
npm install
npm run dev          # open the printed localhost URL in a browser with Phantom/Solflare/Backpack
```

## What to look at

1. **Connect wallet** — Wallet Standard discovery is implemented inline (two window
   events); the bridge takes **sign-only** access. A wallet that can only
   `signAndSendTransaction` is rejected on principle: it would submit through its own
   single RPC and bypass the shield.
2. **Endpoint health panel** — one endpoint in the pool is intentionally dead
   (`http://127.0.0.1:9`). Watch its circuit OPEN while every call keeps succeeding
   through the healthy node. This is `getHealth()` rendered live.
3. **Send** — Phantom prompts **once**. The shield owns submission: dynamic routing,
   status polling, rebroadcast of the *same signed bytes* on timeout windows
   (`wallet {"type":"rebroadcast"...}` in the event log), `resignOnExpiry` off by default.
4. **Airdrop** — devnet faucet is heavily rate-limited; if it refuses, fund the shown
   address at <https://faucet.solana.com> and refresh the balance by re-connecting.
