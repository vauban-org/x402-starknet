// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// THE merchant test : a merchant who is NOT us, built with the foundation's
// own `@x402/express` middleware and its own `HTTPFacilitatorClient`, accepts
// a Starknet payment by pointing that client at the REAL `zkpay-facilitator`
// binary and registering the merchant half of this package. The payer is the
// foundation's client with the client half. Not one line of this merchant is
// ours beyond the mechanism ; its route, price and `payTo` are its own, and
// differ from the facilitator's own offer on purpose.
//
// REAL : the x402 v2 wire in all three legs (client <-> merchant, merchant <->
// facilitator `/supported`, `/verify`, `/settle`), the SNIP-12 hash as
// starknet.js computes it, the STARK-curve signature, the facilitator's eight
// rules run against requirements it did not write.
//
// SIMULATED : the chain (`--starknet-chain mock`). The receipt says so, and
// the test asserts that it does.
//
// The binary is found via ZKPAY_FACILITATOR_BIN, or at the workspace's
// target/debug path ; it must have been built with `--features starknet`.
// Skipped, loudly, otherwise.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Account, RpcProvider, ec } from "starknet";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware } from "@x402/express";
import { registerExactStarknetScheme } from "../src/index.js";
import { ExactStarknetServerScheme, decimalToAtomic, registerExactStarknetServerScheme } from "../src/server.js";

const BIN =
  process.env["ZKPAY_FACILITATOR_BIN"] ??
  resolve(import.meta.dirname, "../../../target/debug/zkpay-facilitator");

// A throwaway key, from a constant. Never funded, never on any chain.
const PRIVATE_KEY = "0x00feed0000face0000dead0000beef0000feed0000face0000dead0000beef05";
const PAYER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// The facilitator's OWN offer, which this merchant never uses.
const FACILITATOR_PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
// The merchant : a different address, a different price.
const MERCHANT = "0x0444444444444444444444444444444444444444444444444444444444444444";
const MERCHANT_PRICE = "0.005";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

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

async function waitReady(base: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("zkpay-facilitator did not answer /healthz within 15 s");
}

function decodeHeader(raw: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
}

const describeIf = existsSync(BIN) ? describe : describe.skip;
if (!existsSync(BIN)) {
  console.warn(
    `SKIPPED : no facilitator binary at ${BIN}. Build it with ` +
      `\`cargo build -p zkpay-facilitator --features starknet\` or set ZKPAY_FACILITATOR_BIN.`,
  );
}

describeIf("a stock @x402/express merchant accepts Starknet through our facilitator", () => {
  let facilitator: ChildProcess;
  let facilitatorBase: string;
  let merchant: Server;
  let merchantBase: string;

  beforeAll(async () => {
    const publicKey = ec.starkCurve.getStarkKey(PRIVATE_KEY);
    const port = await freePort();
    facilitatorBase = `http://127.0.0.1:${port}`;
    facilitator = spawn(
      BIN,
      [
        "--bind", `127.0.0.1:${port}`,
        "--history-journal", `/tmp/zkpay-x402-starknet-merchant-test-${port}.jsonl`,
        "--starknet-exact",
        "--starknet-chain", "mock",
        "--starknet-pay-to", FACILITATOR_PAY_TO,
        "--starknet-fee-payer", FEE_PAYER,
        "--starknet-mock-payer", `${PAYER}:${publicKey}:1000000000000000000000`,
      ],
      { cwd: resolve(import.meta.dirname, "../../.."), stdio: "ignore" },
    );
    await waitReady(facilitatorBase);

    // The merchant, exactly as the foundation's README shows it for any
    // network : one facilitator URL, one scheme registration, one route.
    const server = registerExactStarknetServerScheme(
      new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorBase })),
    );
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: {
              scheme: "exact",
              network: "starknet:SN_SEPOLIA",
              price: MERCHANT_PRICE,
              payTo: MERCHANT,
            },
            description: "Tomorrow's weather, from a merchant who is not the facilitator",
            mimeType: "application/json",
          },
        },
        server,
      ),
    );
    app.get("/weather", (_req, res) => {
      res.json({ weather: "sunny", merchant: MERCHANT });
    });
    const merchantPort = await freePort();
    merchantBase = `http://127.0.0.1:${merchantPort}`;
    merchant = createServer(app);
    await new Promise<void>((r) => merchant.listen(merchantPort, "127.0.0.1", r));
  }, 30_000);

  afterAll(async () => {
    facilitator?.kill();
    await new Promise<void>((r) => (merchant ? merchant.close(() => r()) : r()));
  });

  it("serves a 402 whose offer is the merchant's, with the facilitator's feePayer copied in", async () => {
    const res = await fetch(`${merchantBase}/weather`);
    expect(res.status).toBe(402);
    const raw = res.headers.get("payment-required");
    expect(raw, "the 402 must carry PAYMENT-REQUIRED").toBeTruthy();
    const doc = decodeHeader(raw as string) as {
      x402Version: number;
      accepts: Array<Record<string, unknown>>;
    };
    expect(doc.x402Version).toBe(2);
    const offer = doc.accepts.find((o) => o["scheme"] === "exact" && o["network"] === "starknet:SN_SEPOLIA");
    expect(offer, JSON.stringify(doc)).toBeTruthy();
    // The merchant's own terms, not the facilitator's.
    expect(offer?.["payTo"]).toBe(MERCHANT);
    expect(offer?.["amount"]).toBe(decimalToAtomic(MERCHANT_PRICE, 18));
    expect(BigInt(offer?.["asset"] as string)).toBe(BigInt(STRK));
    // The facilitator's submitter, copied from /supported and nowhere else.
    expect((offer?.["extra"] as { feePayer?: string })?.feePayer).toBe(FEE_PAYER);
  });

  it("is paid by the foundation's client with the client half, and the facilitator settles", async () => {
    const account = new Account({
      provider: new RpcProvider({ nodeUrl: "http://127.0.0.1:9" }),
      address: PAYER,
      signer: PRIVATE_KEY,
    });
    const client = registerExactStarknetScheme(new x402Client(), { signer: account });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    const response = await fetchWithPayment(`${merchantBase}/weather`);
    const body = (await response.json()) as { weather?: string; merchant?: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.weather).toBe("sunny");
    expect(body.merchant).toBe(MERCHANT);

    const raw = response.headers.get("payment-response");
    expect(raw, "the 200 must carry PAYMENT-RESPONSE").toBeTruthy();
    const receipt = decodeHeader(raw as string) as {
      success: boolean;
      network: string;
      payer?: string;
      transaction: string;
    };
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe("starknet:SN_SEPOLIA");
    expect(receipt.payer).toBe(PAYER);
    // Honest about the chain it did not touch.
    expect(receipt.transaction.startsWith("mock:")).toBe(true);
  });

  it("refuses a payer the chain does not know, through the merchant, in the protocol's words", async () => {
    const stranger = new Account({
      provider: new RpcProvider({ nodeUrl: "http://127.0.0.1:9" }),
      address: "0x0777777777777777777777777777777777777777777777777777777777777777",
      signer: "0x0000abc0000abc0000abc0000abc0000abc0000abc0000abc0000abc0000abc6",
    });
    const client = registerExactStarknetScheme(new x402Client(), { signer: stranger });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(`${merchantBase}/weather`);
    expect(response.status).toBe(402);
  });

  it("the facilitator API is at the root the stock client appends to, and /supported names the submitter", async () => {
    const res = await fetch(`${facilitatorBase}/supported`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { kinds: Array<{ scheme: string; network: string; extra?: { feePayer?: string } }> };
    const kind = doc.kinds.find((k) => k.scheme === "exact" && k.network === "starknet:SN_SEPOLIA");
    expect(kind?.extra?.feePayer).toBe(FEE_PAYER);
  });
});

describe("the merchant half, on its own", () => {
  const scheme = new ExactStarknetServerScheme();
  const kind = { x402Version: 2, scheme: "exact", network: "starknet:SN_SEPOLIA", extra: { feePayer: FEE_PAYER } };

  it("converts a STRK price on digits, never through a float", async () => {
    expect(decimalToAtomic("0.01", 18)).toBe("10000000000000000");
    expect(decimalToAtomic("1", 18)).toBe("1000000000000000000");
    expect(decimalToAtomic("0.000000000000000001", 18)).toBe("1");
    expect(decimalToAtomic("123.456", 6)).toBe("123456000");
    expect((await scheme.parsePrice("0.01 STRK", "starknet:SN_SEPOLIA")).amount).toBe("10000000000000000");
    expect((await scheme.parsePrice(0.01, "starknet:SN_SEPOLIA")).amount).toBe("10000000000000000");
    expect((await scheme.parsePrice("0.01", "starknet:SN_SEPOLIA")).asset).toBe(STRK);
  });

  it("passes an explicit { amount, asset } through untouched", async () => {
    const other = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
    expect(await scheme.parsePrice({ amount: "42", asset: other }, "starknet:SN_SEPOLIA")).toEqual({
      amount: "42",
      asset: other,
    });
  });

  it("refuses dollar prices, too many decimals, and networks the specification does not register", async () => {
    await expect(scheme.parsePrice("$0.10", "starknet:SN_SEPOLIA")).rejects.toThrow(/dollar prices are refused/);
    expect(() => decimalToAtomic("0.0000000000000000001", 18)).toThrow(/fractional digits/);
    await expect(scheme.parsePrice("0.01", "starknet:sepolia" as never)).rejects.toThrow(/not one the specification registers/);
  });

  it("copies the facilitator's feePayer and refuses a merchant override", async () => {
    const base = {
      scheme: "exact",
      network: "starknet:SN_SEPOLIA" as const,
      amount: "1",
      asset: STRK,
      payTo: MERCHANT,
      maxTimeoutSeconds: 300,
    };
    const enhanced = await scheme.enhancePaymentRequirements(base, kind, []);
    expect(enhanced.extra?.["feePayer"]).toBe(FEE_PAYER);
    await expect(
      scheme.enhancePaymentRequirements({ ...base, extra: { feePayer: MERCHANT } }, kind, []),
    ).rejects.toThrow(/must be the facilitator's own/);
    await expect(
      scheme.enhancePaymentRequirements(base, { ...kind, extra: {} }, []),
    ).rejects.toThrow(/names no extra.feePayer/);
    expect(scheme.validateFacilitatorSupport("starknet:SN_SEPOLIA", { ...kind, extra: {} }, [])).toMatch(
      /announces no extra.feePayer/,
    );
    expect(scheme.validateFacilitatorSupport("starknet:SN_SEPOLIA", kind, [])).toBeUndefined();
  });
});
