# `@vauban-pay/x402-starknet`

Both halves of the registered x402 v2 `exact` scheme on Starknet
(`x402-foundation/x402`, `specs/schemes/exact/scheme_exact_starknet.md`): the
client half, as a mechanism for `@x402/core`'s `x402Client`, and the merchant
half (`@vauban-pay/x402-starknet/server`), as a mechanism for
`x402ResourceServer` and every `@x402/*` middleware built on it.

The payer signs a SNIP-9 v2 outside execution (SNIP-12 typed data, revision 1)
authorizing exactly one `transfer` from its own account; the facilitator submits
it and pays the gas. No approval, no client gas, replay protection by the
account's own single-use SNIP-9 nonce.

## Use

```ts
import { Account, RpcProvider } from "starknet";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactStarknetScheme } from "@vauban-pay/x402-starknet";

const account = new Account({ provider: new RpcProvider({ nodeUrl }), address, signer: privateKey });
const client = registerExactStarknetScheme(new x402Client(), { signer: account });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPayment("https://demo.pay.vauban.tech/v1/quote");
```

Any object with `address` and `signMessage(typedData)` works as the signer, so
a wallet adapter fits where the `Account` is.

## Accept it, as a merchant

A merchant built with the foundation's middleware accepts Starknet by pointing
its facilitator client at a facilitator that implements the scheme and
registering the merchant half. Routes, prices and `payTo` are declared the
way the foundation documents them for any other network:

```ts
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { registerExactStarknetServerScheme } from "@vauban-pay/x402-starknet/server";

const server = registerExactStarknetServerScheme(
  new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://demo.pay.vauban.tech/starknet" })),
);
const app = express();
app.use(paymentMiddleware({
  "GET /weather": {
    accepts: { scheme: "exact", network: "starknet:SN_SEPOLIA", price: "0.01", payTo: "0x…your account…" },
  },
}, server));
app.get("/weather", (_req, res) => res.json({ weather: "sunny" }));
```

`https://demo.pay.vauban.tech/starknet` implements `/supported`, `/verify` and
`/settle` for `exact` on `starknet:SN_SEPOLIA`, announces its submitter
(`extra.feePayer`) and pays the gas of every settlement it broadcasts. Testnet
only; its `/supported` says so by naming the network.

A price is STRK (`"0.01"`, `"0.01 STRK"` or `0.01`, converted on digits, 18
decimals) or an explicit `{ amount, asset }` in atomic units for any other
token. Dollar prices are refused: there is no default stable asset here and no
rate would be applied. The merchant half copies the facilitator's `feePayer`
into every requirement and refuses an override, because the specification
makes the facilitator reject any other value (rule 1).

`test/merchant-with-stock-express.test.ts` runs exactly this merchant, with a
different `payTo` and price than the facilitator's own offer, against the real
`zkpay-facilitator` binary, paid by the foundation's client with the client
half.

## It has paid for real

On 2026-09-07, this mechanism, driven by `@x402/fetch`, paid 0.01 STRK on
Starknet Sepolia to a live `zkpay-facilitator`:

```
tx    0x1b88b79ffaa84344d36fdab48e322a86d687a3eb4e9e2f45edae4c01b5b548d
block 14708171, SUCCEEDED, ACCEPTED_ON_L2
```

The test that produced it waits for the transaction on the chain and looks for
the `Transfer(payer -> merchant, price)` event before it believes the receipt
(`test/pays-on-sepolia.test.ts`). To our knowledge it is the first settlement
of the registered `exact`/Starknet scheme on a real chain with the
foundation's own client.

## What it establishes, and what it does not

- The mechanism produces payloads a spec-conforming facilitator accepts. It is
  tested against the real `zkpay-facilitator` binary, driven by the
  foundation's own `@x402/fetch` client, with `starknet.js` doing the hashing
  and signing; that test lives in `test/`.
- The hermetic test settles against an **in-memory chain** and every receipt
  it produces says so (`transaction: "mock:…"`, `extra.mock: true`). The live
  test above needs a node and two funded testnet accounts, and skips loudly
  without them. Nothing in this package moves value by itself; the
  facilitator's chain adapter decides that.
- STRK is the default asset on both networks. `@x402/core` refuses any other
  asset unless you allow it in `spendControls`; that is the client's spend cap
  doing its job, not a defect of this package.

## Why this package exists

As of 2026-09-07 the foundation's reference client for this scheme is an
unmerged pull request, and the only published Starknet client follows an
earlier, incompatible draft. A server that implements the specification had
nobody to be paid by. This is the missing half.

## Source, issues

This directory is mirrored to [github.com/vauban-org/x402-starknet](https://github.com/vauban-org/x402-starknet)
on every push from the Vauban Pay monorepo, which is where the facilitator
(`zkpay-facilitator`, Rust) lives. Issues and pull requests are welcome on the
mirror; the tests that need the facilitator binary or a funded Sepolia account
skip there and say so.

## License

Apache-2.0.
