/**
 * Pinned lending-family deployments (spec §12 Q7). See ./README.md before
 * editing — every constant here is a `tx.to` for user funds.
 *
 * Keyed by chainId, which comes from the DB-backed chain directory. A chain
 * absent from a family's map means that protocol is not available there and the
 * resolver fails closed to Manual — never a guess.
 */

import type { Address } from "../types";

/** A protocol's per-chain singleton (an Aave-style `Pool`, a Morpho singleton). */
export type SingletonBook = Readonly<Record<number, Address>>;

// ── Family B — Aave v3 and its forks (one `Pool` per chain) ────────────────
// Same `{ kind:"aave-v3", pool, asset }` target for every entry; only the Pool
// differs, and `validateAaveV3` proves the reserve is listed on it (§5.3b).

/** Canonical Aave v3 Pool per chain (aave-address-book). */
export const AAVE_V3_POOLS: SingletonBook = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Ethereum
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Optimism
  100: "0xb50201558B00496A145fE76f7424749556E326D8", // Gnosis
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Polygon
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Base
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Arbitrum
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Avalanche
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", // BNB Chain
  59144: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac", // Linea
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", // Scroll
  // Monad, added 2026-10-26 WITHOUT a human countersignature (owner waiver; see
  // docs/runbooks/defi-address-book-security-signoff.md, "Automated-evidence
  // pins"). Source: bgd-labs/aave-address-book src/AaveV3Monad.sol (POOL and
  // POOL_ADDRESSES_PROVIDER 0x34793Fb9935F7bB5E5aE920fb963F39063E7A615).
  // Verified on chain: the Pool's ADDRESSES_PROVIDER() is that provider, the
  // provider's getPool() is this Pool, getMarketId() is "Aave V3 Monad", and
  // all 11 aave-v3 Monad pools DeFiLlama lists have their asset as a reserve.
  143: "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef", // Monad
};

/**
 * SparkLend — an Aave-v3 fork (docs.spark.fi). Same Pool ABI, `spToken` in
 * place of the aToken, so it ships as a RESOLVER ONLY (§5.3b).
 */
export const SPARKLEND_POOLS: SingletonBook = {
  1: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987", // Ethereum
  100: "0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0", // Gnosis
};

/** Seamless — Aave-v3 fork on Base. */
export const SEAMLESS_POOLS: SingletonBook = {
  8453: "0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7",
};

/** ZeroLend — Aave-v3 fork; Linea is its main market. */
export const ZEROLEND_POOLS: SingletonBook = {
  59144: "0x2f9bB73a8e98793e26Cb2F6C4ad037BDf1C6B269",
};

/**
 * **Radiant was REMOVED 2026-08-21 (security sign-off, finding 2). Do not
 * re-add it.**
 *
 * Two independent reasons, either of which is disqualifying:
 *
 *  1. The address that used to sit here, `0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1`,
 *     is not Radiant's lending Pool. It REVERTS on `getReservesList()` and on
 *     `getReserveData(asset)` — the exact call `validateAaveV3` makes — so the
 *     family resolved nothing. Radiant's own docs name a different pool
 *     (`0xE23B4AE3624fB6f7cDEF29bC8EAD912f1Ede6886`, 15 reserves, unpaused).
 *     The pinned value matched only a block-explorer label, which
 *     ./README.md rule 1 forbids as a source.
 *  2. **Radiant is winding down.** After a ~$50M exploit in October 2024
 *     (attributed to a DPRK-linked group), its DAO announced a wind-down on
 *     2026-06-01: maintenance mode, no further development, borrow caps to
 *     zero, TVL down from >$300M to ~$2.2M, front-end committed only through
 *     end of 2026.
 *
 * Reason 2 is why this is a deletion rather than an address fix. Correcting
 * the constant would have taken a family that resolved nothing and made it
 * resolve into a protocol that is shutting down — the failure mode a
 * diff-only review walks straight into.
 */

/**
 * Avalon — Aave-v3 fork with a market per collateral/BTC-LST. Its Pool address
 * differs per market, so there is no single pinned Pool we can trust for a
 * DeFiLlama row: left EMPTY on purpose, which makes the resolver fail closed to
 * Manual until a per-market book is reviewed in. Documented rather than dropped
 * so the omission reads as a decision (§8.2).
 */
export const AVALON_POOLS: SingletonBook = {};

// ── Family C — Compound III (Comet). One market per base asset per chain ───
// `validateCompoundV3` reads `comet.baseToken()` and requires it to equal the
// pool's underlying, so a wrong entry fails closed instead of routing funds.

/** Every Comet market we recognise, grouped by chain (docs.compound.finance). */
export const COMET_MARKETS: Readonly<Record<number, readonly Address[]>> = {
  1: [
    "0xc3d688B66703497DAA19211EEdff47f25384cdc3", // cUSDCv3
    // CORRECTED 2026-08-21 (security sign-off, finding 1). This previously read
    // 0xa17581A9e3356D9Dce248e3A0B3a532E28D7F5A9, which diverges from the real
    // market at the 15th nibble and has NO CODE on mainnet, so `baseToken()`
    // reverted and Compound III WETH was never depositable in-app.
    //
    // The old comment claimed the checksum guard would catch a typo here. It
    // cannot: that wrong string is itself valid EIP-55, because it was
    // re-checksummed AFTER the mistake. `address-book.spec.ts` passed on it.
    // Source: compound-finance/comet deployments/mainnet/weth/roots.json,
    // corroborated by forge/script/marketupdates/helpers/MarketAddresses.sol.
    "0xA17581A9E3356d9A858b789D68B4d866e593aE94", // cWETHv3
    "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", // cUSDTv3
    // Three markets added 2026-08-21. `compound-finance/comet`'s own
    // `deployments/mainnet/` directory listing is the source (six mainnet
    // markets today: usdc, usds, usdt, wbtc, weth, wsteth — this book only had
    // three of them), each `roots.json`'s `comet` field, verified on chain:
    // `baseToken()` matches the named asset and `totalSupply()` is non-zero for
    // all three. They were resolving NOTHING — `CompoundV3Resolver` already
    // iterates every pinned Comet on the chain and validates `baseToken()`
    // against each, so this was purely a missing address, not a resolver gap.
    "0xe85Dc543813B8c2CFEaAc371517b925a166a9293", // cWBTCv3 — baseToken()=WBTC
    "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3", // cWstETHv3 — baseToken()=wstETH
    "0x5D409e56D886231aDAf00c8775665AD0f9897b56", // cUSDSv3 — baseToken()=USDS
  ],
  10: [
    "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", // cUSDCv3
    "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214", // cUSDTv3
    "0xE36A30D249f7761327fd973001A32010b521b6Fd", // cWETHv3
  ],
  137: [
    "0xF25212E676D1F7F89Cd72fFEe66158f541246445", // cUSDCv3 (USDC.e)
    "0xaeB318360f27748Acb200CE616E389A6C9409a07", // cUSDTv3
  ],
  8453: [
    "0xb125E6687d4313864e53df431d5425969c15Eb2F", // cUSDCv3
    "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // cUSDbCv3
    "0x46e6b214b524310239732D51387075E0e70970bf", // cWETHv3
    // Two markets added 2026-08-21, same source and same verification as the
    // Ethereum additions above. `compound-finance/comet`'s
    // `deployments/base/` lists five markets (aero, usdbc, usdc, usds, weth);
    // this book had three. Neither has a DeFiLlama pool yet as of this pin —
    // both markets are new — so this is forward provenance rather than an
    // immediate coverage gain: the resolver claims the pool the moment
    // DeFiLlama indexes it, with no further code change (§11.1).
    "0x784efeB622244d2348d4F2522f8860B96fbEcE89", // cAEROv3 — baseToken()=AERO
    "0x2c776041CCFe903071AF44aa147368a9c8EEA518", // cUSDSv3 — baseToken()=USDS
  ],
  42161: [
    "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // cUSDCv3 (native)
    "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", // cUSDCv3 (USDC.e)
    "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", // cWETHv3
    "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", // cUSDTv3
  ],
  534352: [
    "0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44", // cUSDCv3
  ],
};

// ── Family E — Morpho Blue singleton ───────────────────────────────────────
// One `Morpho` contract per chain; `supply`/`withdraw` take the full
// MarketParams struct (§3.1). Deterministic deploy → same address on most
// chains, but pinned per chain rather than assumed.

export const MORPHO_BLUE_SINGLETONS: SingletonBook = {
  1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Ethereum
  8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Base
};
