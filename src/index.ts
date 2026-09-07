// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// The client half of the registered x402 v2 `exact` scheme on Starknet
// (`x402-foundation/x402` `specs/schemes/exact/scheme_exact_starknet.md`),
// as a mechanism that plugs into `@x402/core`'s `x402Client`.
//
// What a payment IS under this scheme: the payer signs a SNIP-9 v2
// `OutsideExecution` (SNIP-12 typed data, revision 1) authorizing exactly one
// `transfer` call from its own account contract, bound to the facilitator's
// announced submitter (`extra.feePayer`) as the SNIP-9 `Caller`. The
// facilitator submits it via `execute_from_outside_v2` and pays the gas. The
// payer never sends a transaction and never approves anything.
//
// Why this exists: as of 2026-09-07 the foundation's own reference client for
// this scheme is still an unmerged pull request, and the only published
// Starknet client follows an earlier, incompatible draft. A server that
// implements the spec has nobody to be paid by. This is the missing half.
//
// What this module refuses to do: it never picks a nonce for you that could
// collide (a random 251-bit felt from the platform CSPRNG), never signs for a
// network the requirements did not name, never widens the time window beyond
// what the server offered, and never touches a private key: signing is
// delegated to whatever `Account` starknet.js gives you, which is where a
// wallet lives.

import type { Account, TypedData } from "starknet";
import type { SchemeNetworkClient, PaymentRequirements } from "@x402/core/types";
import type { x402Client } from "@x402/core/client";

/** The scheme this mechanism implements. */
export const SCHEME = "exact";

/** CAIP-2 identifiers the specification registers, and nothing else. */
export const NETWORKS = ["starknet:SN_SEPOLIA", "starknet:SN_MAIN"] as const;
export type StarknetNetwork = (typeof NETWORKS)[number];

/** `sn_keccak("transfer")`, the one selector an `exact` payment may carry. */
export const TRANSFER_SELECTOR =
  "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";

/** SNIP-12 domain of a SNIP-9 v2 outside execution. */
const DOMAIN_NAME = "Account.execute_from_outside";

/**
 * The default asset per network : STRK, the network's own fee token, 18
 * decimals. `@x402/core`'s client refuses, by default, any offer whose asset
 * is neither a default of the mechanism nor allowed in its `spendControls` ;
 * that is a spend cap, not a bug, and this table is what makes a STRK offer
 * payable without the user configuring anything. Any other token stays behind
 * the user's explicit `spendControls.allowedAssets`, which is the point.
 */
export const DEFAULT_ASSETS: Record<StarknetNetwork, readonly { asset: string; decimals: number; symbol: string }[]> = {
  "starknet:SN_SEPOLIA": [
    {
      asset: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
      decimals: 18,
      symbol: "STRK",
    },
  ],
  "starknet:SN_MAIN": [
    {
      asset: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
      decimals: 18,
      symbol: "STRK",
    },
  ],
};

/** Compare two Starknet addresses as field elements, whatever their padding. */
function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * What the mechanism needs from you: an account that can sign SNIP-12 typed
 * data. Any starknet.js `Account` qualifies, and so does a wallet adapter that
 * exposes the same two members.
 */
export interface StarknetSigner {
  readonly address: string;
  signMessage(typedData: TypedData): Promise<unknown>;
}

export interface StarknetClientConfig {
  /** The payer. */
  signer: StarknetSigner | Account;
  /**
   * Seconds subtracted from the server's window when computing
   * `Execute Before`, so the authorization does not expire on the wire.
   * Default 5. The window is never widened.
   */
  clockSkewSeconds?: number;
  /** Test hook: a fixed nonce instead of a random one. Never use in production. */
  nonce?: string;
  /** Test hook: a fixed "now" (unix seconds). */
  now?: () => number;
}

/** What `extra` must carry on a Starknet `exact` offer, per the specification. */
interface StarknetExtra {
  feePayer: string;
}

function isHexFelt(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

function chainIdShortString(network: string): string {
  // The chain id is the Cairo short string of the network name
  // ("SN_SEPOLIA", "SN_MAIN"), as `starknet_chainId` returns it.
  const name = network.slice("starknet:".length);
  let hex = "0x";
  for (const ch of name) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return hex;
}

/** Random 251-bit felt, from the platform CSPRNG, as hex. */
function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  // Clear the top 5 bits so the value is below the STARK field prime.
  bytes[0] = (bytes[0] ?? 0) & 0x07;
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** u256 `amount` as the two felts Cairo's ABI expects: `[low, high]`. */
function u256Parts(amount: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return ["0x" + (amount & mask).toString(16), "0x" + (amount >> 128n).toString(16)];
}

/**
 * The SNIP-12 document a conforming client signs, built from the offer and
 * nothing else. Exported so a test, or a curious payer, can see exactly what
 * gets signed before it is signed.
 */
export function buildOutsideExecutionTypedData(args: {
  network: string;
  feePayer: string;
  asset: string;
  payTo: string;
  amount: bigint;
  nonce: string;
  executeAfter: bigint;
  executeBefore: bigint;
}): TypedData {
  const [low, high] = u256Parts(args.amount);
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      OutsideExecution: [
        { name: "Caller", type: "ContractAddress" },
        { name: "Nonce", type: "felt" },
        { name: "Execute After", type: "u128" },
        { name: "Execute Before", type: "u128" },
        { name: "Calls", type: "Call*" },
      ],
      Call: [
        { name: "To", type: "ContractAddress" },
        { name: "Selector", type: "selector" },
        { name: "Calldata", type: "felt*" },
      ],
    },
    primaryType: "OutsideExecution",
    domain: {
      name: DOMAIN_NAME,
      version: "2",
      chainId: chainIdShortString(args.network),
      revision: "1",
    },
    message: {
      Caller: args.feePayer,
      Nonce: args.nonce,
      "Execute After": args.executeAfter.toString(),
      "Execute Before": args.executeBefore.toString(),
      Calls: [
        {
          To: args.asset,
          Selector: TRANSFER_SELECTOR,
          Calldata: [args.payTo, low, high],
        },
      ],
    },
  };
}

/** Normalise whatever starknet.js returned into the `[r, s]` the wire wants. */
function signatureToArray(signature: unknown): string[] {
  if (Array.isArray(signature)) {
    return signature.map((s) => (typeof s === "bigint" ? "0x" + s.toString(16) : String(s)));
  }
  if (signature && typeof signature === "object" && "r" in signature && "s" in signature) {
    const { r, s } = signature as { r: bigint | string; s: bigint | string };
    return [r, s].map((v) => (typeof v === "bigint" ? "0x" + v.toString(16) : String(v)));
  }
  throw new Error("exact/starknet: the signer returned a signature of unknown shape");
}

/**
 * The mechanism. Register it on an `x402Client` for the Starknet networks and
 * the client will pay any `exact`/`starknet:*` offer it meets.
 */
export class ExactStarknetScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  private readonly config: StarknetClientConfig;

  constructor(config: StarknetClientConfig) {
    this.config = config;
  }

  /** The reverse lookup `@x402/core` uses for its spend caps. */
  findDefaultAsset = (asset: string, network: string) => {
    const table = DEFAULT_ASSETS[network as StarknetNetwork];
    return table?.find((entry) => sameAddress(entry.asset, asset));
  };

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<{ x402Version: number; payload: Record<string, unknown> }> {
    if (x402Version !== 2) {
      throw new Error(`exact/starknet: x402 version ${x402Version} is not supported (only 2)`);
    }
    if (requirements.scheme !== SCHEME) {
      throw new Error(`exact/starknet: scheme ${requirements.scheme} is not ${SCHEME}`);
    }
    if (!(NETWORKS as readonly string[]).includes(requirements.network)) {
      throw new Error(
        `exact/starknet: network ${requirements.network} is not one the specification registers (${NETWORKS.join(", ")})`,
      );
    }
    const extra = requirements.extra as Partial<StarknetExtra> | undefined;
    if (!extra || !isHexFelt(extra.feePayer)) {
      // The specification forbids advertising an offer without a submitter ;
      // an offer that lacks one is not one we can bind a Caller to.
      throw new Error("exact/starknet: the offer carries no extra.feePayer to bind as the SNIP-9 Caller");
    }
    if (!isHexFelt(requirements.asset) || !isHexFelt(requirements.payTo)) {
      throw new Error("exact/starknet: asset and payTo must be Starknet addresses");
    }
    if (!/^[0-9]+$/.test(requirements.amount)) {
      throw new Error("exact/starknet: amount must be a base-10 integer string");
    }
    const timeout = Number(requirements.maxTimeoutSeconds);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("exact/starknet: maxTimeoutSeconds must be positive");
    }

    const now = BigInt(Math.floor((this.config.now ?? (() => Date.now() / 1000))()));
    const skew = BigInt(this.config.clockSkewSeconds ?? 5);
    // `Execute After` is checked strictly (< block timestamp), so 1 is the
    // earliest value that is always satisfied ; `Execute Before` never exceeds
    // what the server offered.
    const executeAfter = 1n;
    const executeBefore = now + BigInt(timeout) - skew;
    if (executeBefore <= now) {
      throw new Error("exact/starknet: the offer's window is shorter than the clock skew margin");
    }

    const typedData = buildOutsideExecutionTypedData({
      network: requirements.network,
      feePayer: extra.feePayer,
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: BigInt(requirements.amount),
      nonce: this.config.nonce ?? randomNonce(),
      executeAfter,
      executeBefore,
    });

    const signature = signatureToArray(await this.config.signer.signMessage(typedData));

    return {
      x402Version,
      payload: {
        from: this.config.signer.address,
        outsideExecution: { typedData, signature },
      },
    };
  }
}

/**
 * Register the mechanism for both Starknet networks the specification names.
 *
 * ```ts
 * import { x402Client } from "@x402/core/client";
 * import { wrapFetchWithPayment } from "@x402/fetch";
 * import { registerExactStarknetScheme } from "@vauban-pay/x402-starknet";
 *
 * const client = registerExactStarknetScheme(new x402Client(), { signer: account });
 * const fetchWithPayment = wrapFetchWithPayment(fetch, client);
 * ```
 */
export function registerExactStarknetScheme(client: x402Client, config: StarknetClientConfig): x402Client {
  const scheme = new ExactStarknetScheme(config);
  for (const network of NETWORKS) client.register(network, scheme);
  return client;
}
