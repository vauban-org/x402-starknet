// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// THE REAL MERCHANT ONE : a merchant built with the foundation's
// `@x402/express`, running in this process with its OWN `payTo` (an address
// that is neither the facilitator's nor the payer's) and its own price, points
// its facilitator client at a PUBLIC facilitator implementing the scheme, and
// is paid by the foundation's client with the client half. The public
// facilitator verifies, settles and pays the gas ; a value moves on Starknet
// Sepolia from the payer to the merchant ; the test reads it back from the
// chain and checks the merchant's balance grew by exactly the price, because
// this merchant, unlike the facilitator's own offer, pays no gas.
//
// Runs only when the operator provides, in the environment :
//   ZKPAY_STARKNET_RPC_URL          the node (sovereign, never a SaaS)
//   ZKPAY_STARKNET_SNCAST_ACCOUNTS  the sncast accounts file (0600, testnet)
//   ZKPAY_STARKNET_PAYER_ACCOUNT    the payer's account NAME in that file
//   ZKPAY_FACILITATOR_URL           the public facilitator, e.g.
//                                   https://demo.pay.vauban.tech/starknet
//   ZKPAY_MERCHANT_PAY_TO           the merchant's address (any deployed or
//                                   undeployed address ; STRK accepts both)
// Skipped loudly otherwise. The payer's key is read by this process from the
// file ; nobody prints it. Testnet only.
//
// Spends : the price (0.005 STRK, paid by the payer) ; the gas is paid by the
// public facilitator's fee payer. Sepolia spending was authorised by the
// founder on 2026-08-14.

import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Account, RpcProvider, hash } from "starknet";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware } from "@x402/express";
import { registerExactStarknetScheme } from "../src/index.js";
import { registerExactStarknetServerScheme } from "../src/server.js";

const RPC = process.env["ZKPAY_STARKNET_RPC_URL"];
const ACCOUNTS = process.env["ZKPAY_STARKNET_SNCAST_ACCOUNTS"];
const PAYER_NAME = process.env["ZKPAY_STARKNET_PAYER_ACCOUNT"];
const PUBLIC_URL = process.env["ZKPAY_FACILITATOR_URL"];
const MERCHANT = process.env["ZKPAY_MERCHANT_PAY_TO"];

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const PRICE = "0.005";
const PRICE_WEI = 5_000_000_000_000_000n;

const ready = Boolean(RPC && ACCOUNTS && PAYER_NAME && PUBLIC_URL && MERCHANT);
if (!ready) {
  console.warn(
    "SKIPPED : the live merchant test needs ZKPAY_STARKNET_RPC_URL, ZKPAY_STARKNET_SNCAST_ACCOUNTS, " +
      "ZKPAY_STARKNET_PAYER_ACCOUNT, ZKPAY_FACILITATOR_URL and ZKPAY_MERCHANT_PAY_TO. Nothing was measured.",
  );
}
const describeIf = ready ? describe : describe.skip;

interface SncastAccount {
  address: string;
  private_key: string;
}

function sncast(name: string): SncastAccount {
  const file = JSON.parse(readFileSync(ACCOUNTS as string, "utf8")) as {
    "alpha-sepolia"?: Record<string, SncastAccount>;
  };
  const acct = file["alpha-sepolia"]?.[name];
  if (!acct) throw new Error(`no account ${name} under alpha-sepolia in the sncast file`);
  return acct;
}

async function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolveP(port));
    });
    s.on("error", reject);
  });
}

async function balanceOf(provider: RpcProvider, owner: string): Promise<bigint> {
  const out = await provider.callContract({ contractAddress: STRK, entrypoint: "balance_of", calldata: [owner] });
  return BigInt(out[0] as string);
}

describeIf("a stock merchant, paid through the public facilitator, receives exactly its price on Sepolia", () => {
  let merchant: Server;
  let merchantBase: string;
  let payer: SncastAccount;

  beforeAll(async () => {
    payer = sncast(PAYER_NAME as string);
    if (BigInt(MERCHANT as string) === BigInt(payer.address)) {
      throw new Error("the merchant must not be the payer : a self-transfer would prove nothing");
    }
    const facilitatorUrl = (PUBLIC_URL as string).replace(/\/$/, "");
    const server = registerExactStarknetServerScheme(
      new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })),
    );
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: { scheme: "exact", network: "starknet:SN_SEPOLIA", price: PRICE, payTo: MERCHANT as string },
            description: "A merchant who is not the facilitator, on Starknet Sepolia",
            mimeType: "application/json",
          },
        },
        server,
      ),
    );
    app.get("/weather", (_req, res) => {
      res.json({ weather: "sunny", merchant: MERCHANT });
    });
    const port = await freePort();
    merchantBase = `http://127.0.0.1:${port}`;
    merchant = createServer(app);
    await new Promise<void>((r) => merchant.listen(port, "127.0.0.1", r));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => (merchant ? merchant.close(() => r()) : r()));
  });

  it("serves a 402 with the merchant's own terms and the public facilitator's feePayer", async () => {
    const res = await fetch(`${merchantBase}/weather`);
    expect(res.status).toBe(402);
    const doc = JSON.parse(Buffer.from(res.headers.get("payment-required") as string, "base64").toString("utf8")) as {
      accepts: { scheme: string; network: string; payTo: string; amount: string; extra?: { feePayer?: string } }[];
    };
    const offer = doc.accepts.find((o) => o.scheme === "exact" && o.network === "starknet:SN_SEPOLIA");
    expect(offer, JSON.stringify(doc)).toBeTruthy();
    expect(BigInt(offer?.payTo as string)).toBe(BigInt(MERCHANT as string));
    expect(offer?.amount).toBe(PRICE_WEI.toString());
    // The submitter is the public facilitator's, read from ITS /supported.
    const supported = (await (await fetch(`${(PUBLIC_URL as string).replace(/\/$/, "")}/supported`)).json()) as {
      kinds: { scheme: string; network: string; extra?: { feePayer?: string } }[];
    };
    const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === "starknet:SN_SEPOLIA");
    expect(offer?.extra?.feePayer).toBe(kind?.extra?.feePayer);
  });

  it("is paid, and the merchant's STRK balance grows by exactly the price", async () => {
    const provider = new RpcProvider({ nodeUrl: RPC as string });
    const account = new Account({ provider, address: payer.address, signer: payer.private_key });
    const before = await balanceOf(provider, MERCHANT as string);

    const client = registerExactStarknetScheme(new x402Client(), { signer: account });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(`${merchantBase}/weather`);
    const body = (await response.json()) as { weather?: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.weather).toBe("sunny");

    const receipt = JSON.parse(
      Buffer.from(response.headers.get("payment-response") as string, "base64").toString("utf8"),
    ) as { success: boolean; transaction: string; network: string; payer?: string; extra?: { mock?: boolean } };
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe("starknet:SN_SEPOLIA");
    expect(receipt.transaction.startsWith("0x")).toBe(true);
    expect(receipt.extra?.mock).toBeUndefined();

    // Believe the chain, not the receipt.
    const onchain = await provider.waitForTransaction(receipt.transaction);
    expect(onchain.isSuccess()).toBe(true);
    const transfer = hash.getSelectorFromName("Transfer");
    const events = (onchain as unknown as { events: { from_address: string; keys: string[]; data: string[] }[] }).events;
    const paid = events.find(
      (e) =>
        BigInt(e.from_address) === BigInt(STRK) &&
        BigInt(e.keys[0] ?? "0x0") === BigInt(transfer) &&
        BigInt(e.keys[1] ?? "0x0") === BigInt(payer.address) &&
        BigInt(e.keys[2] ?? "0x0") === BigInt(MERCHANT as string) &&
        BigInt(e.data[0] ?? "0x0") === PRICE_WEI,
    );
    expect(paid, `no Transfer(payer -> merchant, ${PRICE_WEI}) in ${JSON.stringify(events)}`).toBeTruthy();

    // This merchant pays no gas : its balance moves by the price and nothing else.
    const after = await balanceOf(provider, MERCHANT as string);
    expect(after - before).toBe(PRICE_WEI);
    console.log(`MERCHANT SETTLED ON SEPOLIA : ${receipt.transaction} (facilitator ${PUBLIC_URL}, merchant ${MERCHANT})`);
  }, 240_000);
});
