// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vauban Research <research@vauban.tech>
//
// The MERCHANT half of the registered x402 v2 `exact` scheme on Starknet, as
// a mechanism that plugs into `@x402/core`'s `x402ResourceServer`, and so into
// every middleware the foundation builds on it (`@x402/express`, `@x402/hono`,
// `@x402/next`, ...).
//
// What a merchant needs to accept Starknet with this : one facilitator URL
// (`https://demo.pay.vauban.tech/starknet` implements `/supported`, `/verify`,
// `/settle`) and this class registered for `starknet:SN_SEPOLIA`. Nothing
// else changes : routes, prices and `payTo` are declared the way the
// foundation's documentation shows for any other network.
//
// What this half does, and all it does : it turns a price into the scheme's
// `{ amount, asset }` and copies the facilitator's announced submitter
// (`extra.feePayer`, read from its `/supported` entry) into the requirements
// the client will sign against. The specification makes that copy mandatory
// (a client binds the SNIP-9 `Caller` to it) and makes the facilitator refuse
// any other value (rule 1) ; so this class never invents one and refuses a
// merchant-supplied override, which would only produce authorizations nobody
// present can submit.
//
// What it refuses : dollar prices. There is no stable asset in the default
// table, and converting "$0.10" into STRK at some rate would be a price the
// merchant never set. A merchant who prices in a token other than STRK gives
// `{ amount, asset }` explicitly, in atomic units, and the scheme passes it
// through untouched.

import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import type { x402ResourceServer } from "@x402/core/server";
import { DEFAULT_ASSETS, NETWORKS, SCHEME, type StarknetNetwork } from "./index.js";

/** Hex field element, the only shape a Starknet address or key takes on the wire. */
function isHexFelt(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

/** Compare two Starknet addresses as field elements, whatever their padding. */
function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Exact decimal to atomic units, with no floating point anywhere : "0.01"
 * with 18 decimals is the string "10000000000000000", computed on digits.
 * Exported so a merchant can check what a price becomes before serving it.
 */
export function decimalToAtomic(decimal: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) {
    throw new Error(`exact/starknet: "${decimal}" is not a plain decimal amount (digits, one optional point)`);
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(
      `exact/starknet: "${decimal}" has ${frac.length} fractional digits ; the asset has ${decimals}`,
    );
  }
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return atomic.toString();
}

export interface StarknetServerConfig {
  /**
   * Fallback `extra.feePayer` for a facilitator whose `/supported` entry
   * carries none. Only for a facilitator you operate yourself ; a public one
   * announces its submitter and this value is then REQUIRED to match it.
   */
  feePayer?: string;
}

/**
 * The merchant-side mechanism. Register it on an `x402ResourceServer` for the
 * Starknet networks, point the server's facilitator client at a facilitator
 * that implements the scheme, and every route priced on `starknet:*` becomes
 * payable by a client carrying the client half of this package.
 */
export class ExactStarknetServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  /** The scheme carries no asset-transfer method on the wire. */
  readonly defaultAssetTransferMethod = "default";
  /**
   * `authorization` is the x402 norm and what the specification describes :
   * verify before the handler, settle after it. `upfront` (settle first, then
   * serve) is also honest for this scheme, because the facilitator's `/settle`
   * re-verifies before broadcasting ; a merchant selling something it cannot
   * take back picks it per route with `extra.paymentFlow`.
   */
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"] as const, default: "authorization" as const },
  } as const;

  private readonly config: StarknetServerConfig;

  constructor(config: StarknetServerConfig = {}) {
    if (config.feePayer !== undefined && !isHexFelt(config.feePayer)) {
      throw new Error("exact/starknet: feePayer must be a hex Starknet address");
    }
    this.config = config;
  }

  private assertNetwork(network: Network): asserts network is StarknetNetwork {
    if (!(NETWORKS as readonly string[]).includes(network)) {
      throw new Error(
        `exact/starknet: network ${network} is not one the specification registers (${NETWORKS.join(", ")})`,
      );
    }
  }

  /** 18 for STRK, the one default asset ; undefined for anything else. */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    const table = DEFAULT_ASSETS[network as StarknetNetwork];
    return table?.find((entry) => sameAddress(entry.asset, asset))?.decimals;
  }

  /**
   * A price becomes `{ amount, asset }` :
   * - `{ amount, asset }` passes through, checked, in atomic units ;
   * - `"0.01"`, `"0.01 STRK"` or the number `0.01` is STRK, 18 decimals,
   *   converted on digits ;
   * - `"$…"` is refused : no stable asset is defaulted, and no rate is applied.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    this.assertNetwork(network);
    if (typeof price === "object" && price !== null) {
      const { amount, asset } = price as AssetAmount;
      if (!/^[0-9]+$/.test(String(amount))) {
        throw new Error("exact/starknet: an explicit amount must be a base-10 integer string, in atomic units");
      }
      if (!isHexFelt(asset)) {
        throw new Error("exact/starknet: an explicit asset must be a hex Starknet contract address");
      }
      return { amount: String(amount), asset, ...(price.extra ? { extra: price.extra } : {}) };
    }
    const text = typeof price === "number" ? String(price) : String(price).trim();
    if (text.startsWith("$")) {
      throw new Error(
        "exact/starknet: dollar prices are refused ; there is no default stable asset on Starknet here " +
          "and no rate would be applied. Price in STRK (\"0.01\") or give { amount, asset } in atomic units.",
      );
    }
    const strk = DEFAULT_ASSETS[network][0];
    if (!strk) throw new Error(`exact/starknet: no default asset on ${network}`);
    const withoutSymbol = text.replace(/\s*STRK$/i, "");
    return { amount: decimalToAtomic(withoutSymbol, strk.decimals), asset: strk.asset };
  }

  /**
   * The requirements a client signs against : the base ones, plus the
   * facilitator's `feePayer`, copied verbatim from its `/supported` entry.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    this.assertNetwork(paymentRequirements.network);
    const announced = supportedKind.extra?.["feePayer"];
    const feePayer = isHexFelt(announced) ? announced : this.config.feePayer;
    if (!isHexFelt(feePayer)) {
      throw new Error(
        `exact/starknet: the facilitator's /supported entry for ${supportedKind.network} names no extra.feePayer ; ` +
          "the specification requires one, and without it no client can bind a SNIP-9 Caller",
      );
    }
    const requested = paymentRequirements.extra?.["feePayer"];
    if (requested !== undefined && !(isHexFelt(requested) && sameAddress(requested, feePayer))) {
      throw new Error(
        "exact/starknet: extra.feePayer on a route must be the facilitator's own ; " +
          "any other value yields authorizations the facilitator refuses (rule 1) and nobody else can submit",
      );
    }
    return {
      ...paymentRequirements,
      extra: { ...(paymentRequirements.extra ?? {}), feePayer },
    };
  }

  /** A facilitator that announces no submitter cannot be used for this scheme. */
  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind, _ext: string[]): string | void {
    if (!(NETWORKS as readonly string[]).includes(network)) {
      return `exact/starknet: ${network} is not a Starknet network the specification registers`;
    }
    const announced = supportedKind.extra?.["feePayer"];
    if (!isHexFelt(announced) && !isHexFelt(this.config.feePayer)) {
      return `exact/starknet: the facilitator announces no extra.feePayer for ${network}`;
    }
    return undefined;
  }
}

/**
 * Register the merchant half for both Starknet networks the specification
 * names.
 *
 * ```ts
 * import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
 * import { paymentMiddleware } from "@x402/express";
 * import { registerExactStarknetServerScheme } from "@vauban-pay/x402-starknet/server";
 *
 * const server = registerExactStarknetServerScheme(
 *   new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://demo.pay.vauban.tech/starknet" })),
 * );
 * app.use(paymentMiddleware({
 *   "GET /weather": { accepts: { scheme: "exact", network: "starknet:SN_SEPOLIA", price: "0.01", payTo: "0x…" } },
 * }, server));
 * ```
 */
export function registerExactStarknetServerScheme(
  server: x402ResourceServer,
  config: StarknetServerConfig = {},
): x402ResourceServer {
  const scheme = new ExactStarknetServerScheme(config);
  for (const network of NETWORKS) server.register(network, scheme);
  return server;
}
