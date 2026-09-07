// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// THE test : the foundation's own client (`@x402/core` + `@x402/fetch`), with
// this mechanism registered and a starknet.js `Account` as the payer, pays the
// REAL `zkpay-facilitator` binary started with `--starknet-exact`.
//
// REAL : the x402 v2 wire format end to end (the 402, the offer selection, the
// PAYMENT-SIGNATURE, the PAYMENT-RESPONSE), the SNIP-12 hash as starknet.js
// computes it (the library a real wallet signs with), the STARK-curve
// signature, the facilitator's canonical reconstruction and its eight rules.
//
// SIMULATED : the chain (`--starknet-chain mock`). The receipt says so, and the
// test asserts that it does : a green run here can never be quoted as a value
// having moved on Starknet.
//
// The binary is found via ZKPAY_FACILITATOR_BIN, or at the workspace's
// target/debug path ; it must have been built with `--features starknet`.
// Skipped, loudly, if neither exists : a test that silently passes without its
// server is worse than none.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, RpcProvider, ec, hash } from "starknet";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactStarknetScheme, TRANSFER_SELECTOR } from "../src/index.js";

const BIN =
  process.env["ZKPAY_FACILITATOR_BIN"] ??
  resolve(import.meta.dirname, "../../../target/debug/zkpay-facilitator");

// A throwaway key, from a constant. Never funded, never on any chain.
const PRIVATE_KEY = "0x00feed0000face0000dead0000beef0000feed0000face0000dead0000beef03";
const PAYER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";

async function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const s = createServer();
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

const describeIf = existsSync(BIN) ? describe : describe.skip;
if (!existsSync(BIN)) {
  console.warn(
    `SKIPPED : no facilitator binary at ${BIN}. Build it with ` +
      `\`cargo build -p zkpay-facilitator --features starknet\` or set ZKPAY_FACILITATOR_BIN.`,
  );
}

describeIf("the foundation's client pays our facilitator with this mechanism", () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    const publicKey = ec.starkCurve.getStarkKey(PRIVATE_KEY);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(
      BIN,
      [
        "--bind", `127.0.0.1:${port}`,
        "--history-journal", `/tmp/zkpay-x402-starknet-test-${port}.jsonl`,
        "--starknet-exact",
        "--starknet-chain", "mock",
        "--starknet-pay-to", PAY_TO,
        "--starknet-fee-payer", FEE_PAYER,
        "--starknet-mock-payer", `${PAYER}:${publicKey}:1000000000000000000000`,
      ],
      { cwd: resolve(import.meta.dirname, "../../.."), stdio: "ignore" },
    );
    await waitReady(base);
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  it("reads the 402, signs a SNIP-9 authorization with starknet.js, and is served", async () => {
    // The payer : a stock starknet.js Account. No RPC is ever called for a
    // signature, so the provider URL is a placeholder that is never reached.
    const account = new Account({
      provider: new RpcProvider({ nodeUrl: "http://127.0.0.1:9" }),
      address: PAYER,
      signer: PRIVATE_KEY,
    });

    const client = registerExactStarknetScheme(new x402Client(), { signer: account });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    const response = await fetchWithPayment(`${base}/v1/quote`);
    const body = (await response.json()) as { note?: string };
    expect(response.status, JSON.stringify(body)).toBe(200);

    // The receipt, on the header the specification names, base64 of JSON.
    const raw = response.headers.get("payment-response");
    expect(raw).toBeTruthy();
    const receipt = JSON.parse(Buffer.from(raw as string, "base64").toString("utf8")) as {
      success: boolean;
      network: string;
      payer: string;
      transaction: string;
      extra?: { mock?: boolean };
    };
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe("starknet:SN_SEPOLIA");
    expect(receipt.payer).toBe(PAYER);
    // Honest about the chain it did not touch.
    expect(receipt.transaction.startsWith("mock:")).toBe(true);
    expect(receipt.extra?.mock).toBe(true);
    // And the good says what was and was not verified.
    expect(body.note).toContain("NO STARK proof");
  });

  it("refuses a payer whose account the chain does not know", async () => {
    const stranger = new Account({
      provider: new RpcProvider({ nodeUrl: "http://127.0.0.1:9" }),
      address: "0x0777777777777777777777777777777777777777777777777777777777777777",
      signer: "0x0000abc0000abc0000abc0000abc0000abc0000abc0000abc0000abc0000abc4",
    });
    const client = registerExactStarknetScheme(new x402Client(), { signer: stranger });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(`${base}/v1/quote`);
    expect(response.status).toBe(402);
    const raw = response.headers.get("payment-response");
    expect(raw).toBeTruthy();
    const refusal = JSON.parse(Buffer.from(raw as string, "base64").toString("utf8")) as {
      success: boolean;
      errorReason?: string;
    };
    expect(refusal.success).toBe(false);
    expect(refusal.errorReason).toBeTruthy();
  });
});

// A sanity check that costs nothing and catches a wrong selector constant : the
// literal we sign must be sn_keccak("transfer") as starknet.js computes it.
describe("constants", () => {
  it("TRANSFER_SELECTOR is sn_keccak('transfer')", () => {
    expect(BigInt(TRANSFER_SELECTOR)).toBe(BigInt(hash.getSelectorFromName("transfer")));
  });
});
