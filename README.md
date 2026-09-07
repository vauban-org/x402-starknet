# `@vauban-pay/x402-starknet`

The client half of the registered x402 v2 `exact` scheme on Starknet
(`x402-foundation/x402`, `specs/schemes/exact/scheme_exact_starknet.md`), as a
mechanism for `@x402/core`'s `x402Client`.

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

## License

Apache-2.0.
