// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// THE REAL ONE : the foundation's client, this mechanism, a real deployed
// payer account, and the facilitator in LIVE mode. A value moves on Starknet
// Sepolia, and the test reads the transaction back from the chain itself
// before it believes the receipt.
//
// Runs only when the operator provides, in the environment :
//   ZKPAY_STARKNET_RPC_URL          the node (sovereign, never a SaaS)
//   ZKPAY_STARKNET_SNCAST_ACCOUNTS  the sncast accounts file (0600, testnet)
//   ZKPAY_STARKNET_PAYER_ACCOUNT    the payer's account NAME in that file
//   ZKPAY_STARKNET_FEE_PAYER_ACCOUNT the fee payer's account NAME
// Skipped loudly otherwise. The keys are read by this process and by the
// facilitator process, from the file ; nobody prints them and no transcript
// carries them. Testnet only : the file format is plaintext and the facilitator
// itself refuses it for any chain but SN_SEPOLIA.
//
// Spends : the price (0.01 STRK, paid by the payer) plus the gas (paid by the
// fee payer). Sepolia spending was authorised by the founder on 2026-08-14.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, RpcProvider, hash } from "starknet";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactStarknetScheme } from "../src/index.js";

const RPC = process.env["ZKPAY_STARKNET_RPC_URL"];
const ACCOUNTS = process.env["ZKPAY_STARKNET_SNCAST_ACCOUNTS"];
const PAYER_NAME = process.env["ZKPAY_STARKNET_PAYER_ACCOUNT"];
const FEE_PAYER_NAME = process.env["ZKPAY_STARKNET_FEE_PAYER_ACCOUNT"];
const BIN =
  process.env["ZKPAY_FACILITATOR_BIN"] ??
  resolve(import.meta.dirname, "../../../target/debug/zkpay-facilitator");

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const PRICE_WEI = "10000000000000000"; // 0.01 STRK

const ready = Boolean(RPC && ACCOUNTS && PAYER_NAME && FEE_PAYER_NAME && existsSync(BIN));
if (!ready) {
  console.warn(
    "SKIPPED : the live Sepolia test needs ZKPAY_STARKNET_RPC_URL, ZKPAY_STARKNET_SNCAST_ACCOUNTS, " +
      "ZKPAY_STARKNET_PAYER_ACCOUNT, ZKPAY_STARKNET_FEE_PAYER_ACCOUNT and a facilitator binary " +
      "built with --features starknet-live. Nothing was measured.",
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("zkpay-facilitator did not answer /healthz within 30 s (check the live boot checks)");
}

describeIf("a value moves on Starknet Sepolia, paid by the foundation's client", () => {
  let child: ChildProcess;
  let base: string;
  let payer: SncastAccount;
  let feePayer: SncastAccount;
  let payTo: string;

  beforeAll(async () => {
    payer = sncast(PAYER_NAME as string);
    feePayer = sncast(FEE_PAYER_NAME as string);
    // The merchant is the fee payer itself : the scheme allows the executor to
    // equal payTo (merchant-sponsored settlement), and it keeps the test's
    // money inside accounts we hold.
    payTo = feePayer.address;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(
      BIN,
      [
        "--bind", `127.0.0.1:${port}`,
        "--history-journal", `/tmp/zkpay-x402-starknet-live-${port}.jsonl`,
        "--starknet-exact",
        "--starknet-chain", "live",
        "--starknet-pay-to", payTo,
        "--starknet-fee-payer", feePayer.address,
        "--starknet-amount", PRICE_WEI,
      ],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        stdio: "ignore",
        env: {
          ...process.env,
          ZKPAY_STARKNET_RPC_URL: RPC as string,
          ZKPAY_STARKNET_SNCAST_ACCOUNTS: ACCOUNTS as string,
          ZKPAY_STARKNET_SNCAST_ACCOUNT: FEE_PAYER_NAME as string,
        },
      },
    );
    await waitReady(base);
  }, 60_000);

  afterAll(() => {
    child?.kill();
  });

  it("pays 0.01 STRK, and the transaction is on the chain", async () => {
    const provider = new RpcProvider({ nodeUrl: RPC as string });
    const account = new Account({ provider, address: payer.address, signer: payer.private_key });

    const balanceBefore = BigInt(
      (await provider.callContract({
        contractAddress: STRK,
        entrypoint: "balance_of",
        calldata: [payTo],
      }))[0] as string,
    );

    const client = registerExactStarknetScheme(new x402Client(), { signer: account });
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(`${base}/v1/quote`);
    const body = (await response.json()) as { note?: string };
    expect(response.status, JSON.stringify(body)).toBe(200);

    const receipt = JSON.parse(
      Buffer.from(response.headers.get("payment-response") as string, "base64").toString("utf8"),
    ) as { success: boolean; transaction: string; network: string; payer: string; extra?: { mock?: boolean } };
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe("starknet:SN_SEPOLIA");
    expect(receipt.transaction.startsWith("0x")).toBe(true);
    expect(receipt.extra?.mock).toBeUndefined();

    // Believe the chain, not the receipt : the transaction exists, succeeded,
    // and carries the STRK Transfer from the payer to the merchant.
    const onchain = await provider.waitForTransaction(receipt.transaction);
    expect(onchain.isSuccess()).toBe(true);
    const transfer = hash.getSelectorFromName("Transfer");
    const events = (onchain as unknown as { events: { from_address: string; keys: string[]; data: string[] }[] }).events;
    const paid = events.find(
      (e) =>
        BigInt(e.from_address) === BigInt(STRK) &&
        BigInt(e.keys[0] ?? "0x0") === BigInt(transfer) &&
        BigInt(e.keys[1] ?? "0x0") === BigInt(payer.address) &&
        BigInt(e.keys[2] ?? "0x0") === BigInt(payTo) &&
        BigInt(e.data[0] ?? "0x0") === BigInt(PRICE_WEI),
    );
    expect(paid, `no Transfer(payer -> merchant, ${PRICE_WEI}) in ${JSON.stringify(events)}`).toBeTruthy();

    const balanceAfter = BigInt(
      (await provider.callContract({
        contractAddress: STRK,
        entrypoint: "balance_of",
        calldata: [payTo],
      }))[0] as string,
    );
    // The merchant received the price. (It also paid the gas as fee payer, so
    // the net change is price minus gas ; the Transfer above is the exact one.)
    expect(balanceAfter).not.toBe(balanceBefore);
    console.log(`SETTLED ON SEPOLIA : ${receipt.transaction}`);
  }, 180_000);
});
