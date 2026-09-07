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

## What it establishes, and what it does not

- The mechanism produces payloads a spec-conforming facilitator accepts. It is
  tested against the real `zkpay-facilitator` binary, driven by the
  foundation's own `@x402/fetch` client, with `starknet.js` doing the hashing
  and signing; that test lives in `test/`.
- That test settles against an **in-memory chain**. Every receipt it produces
  says so (`transaction: "mock:…"`, `extra.mock: true`). Nothing in this
  package moves value; the facilitator's chain adapter decides that.
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
