/**
 * Pinned single-canonical-vault ERC-4626 deployments (Family A, spec §4).
 *
 * These protocols expose exactly ONE savings vault per token per chain, so
 * there is nothing to disambiguate and no vault list to fetch — the address IS
 * the identity. Multi-vault Family-A protocols (Euler, Fluid, Gearbox,
 * Concrete, Venus wrappers) resolve from their own registries instead and are
 * admitted purely on `validateErc4626` passing (§12 Q1).
 *
 * See ./README.md before editing.
 */

import type { Address } from "../types";

/**
 * One pinned 4626 vault: the vault contract plus the underlying it must report
 * from `asset()`. The validator proves the pairing on-chain; the `asset` here
 * is what the resolver matches the DeFiLlama `underlyingTokens[0]` against, so
 * a pool for a different token can never pick up this vault.
 */
export interface PinnedVault {
  readonly vault: Address;
  readonly asset: Address;
  /**
   * The vault's own ticker.
   *
   * Used for logs and tests, and — ONLY when a book holds more than one vault
   * over the same asset — as an EXACT, case-insensitive discriminator against
   * the pool row's `symbol`/`poolMeta`. It is never a fuzzy match: substring
   * matching on a shared symbol is what mis-routed 25 Morpho pools (§11.6b),
   * and a book that cannot disambiguate exactly must refuse instead of
   * guessing.
   *
   * With one vault per asset this field is still not consulted at all.
   */
  readonly label: string;
}

/** chainId → the protocol's pinned vaults on that chain. */
export type PinnedVaultBook = Readonly<Record<number, readonly PinnedVault[]>>;

/**
 * Sky Savings / Spark savings. `sUSDS` is the Sky Savings Rate token and
 * `sDAI` the DSR token; Spark surfaces the SAME contracts (docs.spark.fi
 * "ERC-4626 representation of USDS/DAI"), so one book serves both resolvers
 * and the `project` slug only decides which resolver runs.
 */
export const SKY_SAVINGS_VAULTS: PinnedVaultBook = {
  1: [
    {
      vault: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
      asset: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", // USDS
      label: "sUSDS",
    },
    {
      vault: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
      label: "sDAI",
    },
    {
      // stUSDS — Sky's "Expert Mode" savings vault, and the SECOND vault in
      // this book over USDS. That is what the label discriminator above exists
      // for: `sUSDS` and `stUSDS` are both 4626 vaults for the same asset, so
      // the asset filter alone is ambiguous and would refuse BOTH — including
      // the ~$4.66B sUSDS pool.
      //
      // Address from Sky's OWN on-chain registry, which is as first-party as
      // provenance gets: the dss-chain-log at 0xdA0Ab1e0…, 515 entries,
      // `getAddress("STUSDS")` → this address. The same registry returns
      // `SUSDS` → 0xa3931d71… and `USDS` → 0xdC035D45…, both of which match
      // what this book and the pool row already carry — so the source is
      // cross-checked against constants that were reviewed independently.
      //
      // Verified on chain 2026-08-21: symbol() "stUSDS", name() "Staked USDS",
      // asset() = USDS (matching the pool's underlyingTokens[0]), totalAssets()
      // 199,876,037 USDS against DeFiLlama's $204.0M (~2%), and
      // maxDeposit(<ordinary address>) = 13,123,962 USDS — capped, but NOT the
      // hard zero that correctly refuses Maple and Morpho's V2 vaults.
      //
      // Exit: every lockup probe reverts — no cooldownDuration, no
      // withdrawEpochsTimelock, no ERC-7540 interface, no exit fee — so
      // readExitTerms reports `instant`. Per §11.3b that verdict rests on the
      // family allowlist rather than on proof, and Avant is the reason that is
      // not good enough on its own, so the round trip is EXECUTED on a fork.
      vault: "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9",
      asset: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", // USDS
      label: "stUSDS",
    },
  ],
  // Base and Arbitrum are deliberately ABSENT. Sky's L2 `sUSDS` is a bridged
  // token, not an ERC-4626: verified on chain 2026-08-19, Base
  // `0x5875eEE11Cf8398102FdAd704C9E96607675467a` answers `symbol()` = "sUSDS"
  // but REVERTS on `asset()`, `totalAssets()` and `convertToShares()`
  // (Arbitrum `0xdDb46999F8891663a8F2828d25298f70416d7610` behaves the same).
  // Conversion there goes through the PSM, so no `erc4626` target can ever
  // build. The Base entry used to sit here and simply never resolved — a pin
  // that cannot work reads as support we do not have, which is exactly what
  // this book is supposed to prevent (§12 Q7).
};

/**
 * Spark savings.
 *
 * Spark used to be nothing but a second front-end onto Sky's `sUSDS`/`sDAI`,
 * which is why it shared Sky's book. It is not that any more: Spark Vault V2
 * ships its own ERC-4626 vaults for USDC, USDT, ETH and PYUSD, and DeFiLlama's
 * `spark-savings` rows point at those (`app.spark.fi/savings/mainnet/spusdc`),
 * not at anything of Sky's. Sharing one book meant those pools had no vault to
 * match and all seven resolved to Manual.
 *
 * Addresses come from Spark's OWN registry — `sparkdotfi/spark-address-registry`,
 * `src/Ethereum.sol` on `master`, the `SPARK_VAULT_V2_*` constants — and every
 * one was then verified on chain (2026-08-21): `asset()`, `totalAssets()`,
 * `maxDeposit()` and `convertToShares()` all answer, and `symbol()` reads back
 * spUSDC / spUSDT / spETH / spPYUSD.
 *
 * **`sUSDC` (0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE) is deliberately
 * absent.** It is a real, working 4626 vault for USDC, but so is `spUSDC`, and
 * a book with two vaults for one asset makes `pinnedVaultResolver` ambiguous —
 * which is a refusal, so listing both would resolve FEWER pools than listing
 * the right one. DeFiLlama's link names `spusdc`, so that is the one pinned.
 *
 * **Sky's `sUSDS`/`sDAI` are NOT repeated here**, even though docs.spark.fi
 * surfaces them, for two reasons that agree: DeFiLlama publishes no
 * `spark-savings` row for either on Ethereum (they live under `sky-lending`,
 * which already resolves them), and duplicating a contract across two books
 * would break the address-book invariant that one address is claimed by one
 * protocol per chain. If such a row ever appears it resolves to Manual, which
 * is visible, rather than to a second claim on Sky's contract, which is not.
 */
export const SPARK_SAVINGS_VAULTS: PinnedVaultBook = {
  1: [
    {
      vault: "0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      label: "spUSDC",
    },
    {
      vault: "0xe2e7a17dFf93280dec073C995595155283e3C372",
      asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      label: "spUSDT",
    },
    {
      vault: "0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f",
      asset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      label: "spETH",
    },
    {
      vault: "0x80128DbB9f07b93DDE62A6daeadb69ED14a7D354",
      asset: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", // PYUSD
      label: "spPYUSD",
    },
  ],
  // Arbitrum and Base are absent for the same reason they are absent from
  // SKY_SAVINGS_VAULTS: those chains' `sUSDS` is a bridged token whose
  // `asset()` reverts, so no `erc4626` target can build there.
};

/**
 * Origin — the WRAPPED (non-rebasing) receipts are the ERC-4626 ones. `OUSD`
 * and `OETH` themselves rebase and are not 4626, so only the wrappers are
 * listed; a pool that names the rebasing token resolves to nothing → Manual.
 *
 * **Every Origin pool DeFiLlama publishes is currently Manual, and the
 * POOL-SIDE reason below is correct.** Checked 2026-08-21: `origin-ether` OETH
 * and Base `superOETHb` both carry `underlyingTokens: [0x0]` (native ETH), and
 * `origin-dollar` OUSD carries USDC. None of those is the asset of a wrapper
 * here, because the deposit Origin actually wants is a **Vault mint** —
 * `mint(asset, amount, minimumAmount)` on the OUSD/OETH Vault, which takes a
 * caller-supplied minimum-out and is therefore a different execution kind with
 * a slippage policy (§12 Q4), not an `erc4626` target.
 *
 * The wrapper pins stay because they are correct contracts and would match
 * immediately if a `wOETH`/`wOUSD` pool ever appears. They are not the sUSDS
 * case: those addresses work, they simply have no pool today.
 *
 * **This comment used to end "do not re-investigate", and that instruction was
 * load-bearing in the wrong direction.** The pool-side reasoning above was
 * right, but `wOUSD` ALSO had a book-side defect — it pinned OGV, Origin's
 * governance token — and the instruction is what kept anyone from looking.
 * Fixed 2026-08-21 (see the entry below). A conclusion about why something is
 * Manual is only as good as the constants it was reasoning about; verify the
 * addresses before trusting the explanation.
 */
export const ORIGIN_VAULTS: PinnedVaultBook = {
  1: [
    {
      // CORRECTED 2026-08-21 (security sign-off, finding 3). This previously
      // read 0x9c354503C38481a7A7a51629142963F98eCC12D0, which is not a vault
      // at all: it is OGV, Origin's GOVERNANCE token. On chain it answers
      // name() = "Origin DeFi Governance" and REVERTS on asset(), and Origin's
      // own registry lists it under a literal `// OGV` comment
      // (OriginProtocol/origin-dollar, contracts/utils/addresses.js).
      //
      // The real wrapper is WOUSDProxy, below, whose asset() is exactly the
      // OUSD address this entry already declared.
      // Source: OriginProtocol/ousd.com, src/constants/contractAddresses.ts.
      vault: "0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62",
      asset: "0x2A8e1E676Ec238d8A992307B495b45B3fEAa5e86", // OUSD
      label: "wOUSD",
    },
    {
      vault: "0xDcEe70654261AF21C44c093C300eD3Bb97b78192",
      asset: "0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3", // OETH
      label: "wOETH",
    },
  ],
};

/**
 * Avant Protocol — `savBTC` / `savUSD` / `savETH`, the staked (yield-bearing)
 * wrappers over Avant's own `avBTC` / `avUSD` / `avETH`.
 *
 * Was declared `withheld` with "no public vault-list endpoint found". There is
 * no endpoint because there is nothing to enumerate: Avant ships ONE staked
 * vault per asset, DeFiLlama publishes one row per vault (`avant-avbtc`,
 * `avant-avusd`, `avant-aveth` are three separate project slugs), and its own
 * adaptors name the vault as a constant. That is the textbook case for pinning
 * rather than discovering.
 *
 * Addresses transcribed from `yield-server/src/adaptors/avant-{avbtc,avusd,aveth}`
 * (read as documentation; the repo ships no LICENSE) and then VERIFIED ON CHAIN
 * 2026-08-21: each answers `symbol()` = savBTC / savUSD / savETH, `asset()` is
 * the matching av-token, and `totalAssets()` / `convertToShares()` /
 * `maxDeposit()` all respond with `maxDeposit` unbounded.
 *
 * **These pins are correct and the protocol is still WITHHELD** (see
 * protocols.ts). The cooldown is readable — `cooldownDuration()` returns 86400
 * and the contracts carry the Ethena `cooldownAssets` / `cooldownShares` /
 * `unstake` convention, so `readExitTerms` reports an honest `delayed` — but
 * readable is not the same as executable: while the cooldown is non-zero,
 * `withdraw`/`redeem` REVERT with `OperationNotAllowed()` (0xf50a3b52), which
 * a mainnet fork run found after every structural check had passed.
 *
 * They stay pinned anyway, for the same reason ORIGIN_VAULTS does: the
 * addresses are right, and deleting them would mean re-deriving them the day a
 * cooldown-aware exit lands.
 */
export const AVANT_VAULTS: PinnedVaultBook = {
  1: [
    {
      vault: "0xDA06eE2dACF9245Aa80072a4407deBDea0D7e341",
      asset: "0x9469470C9878bf3d6d0604831d9A3A366156f7EE", // avETH
      label: "savETH",
    },
  ],
  43114: [
    {
      vault: "0x649342c6bff544d82DF1B2bA3C93e0C22cDeBa84",
      asset: "0xfd2c2A98009d0cBed715882036e43d26C4289053", // avBTC
      label: "savBTC",
    },
    {
      vault: "0x06d47F3fb376649c3A9Dafe069B3D6E35572219E",
      asset: "0x24dE8771bC5DdB3362Db529Fc3358F2df3A0E346", // avUSD
      label: "savUSD",
    },
  ],
};

/**
 * 40 Acres — a small fixed set of ERC-4626 USDC vaults.
 *
 * Also previously `withheld` for a missing endpoint. DeFiLlama's own adaptor
 * calls `utils.getERC4626Info(address, ...)` on four hardcoded addresses, i.e.
 * the aggregator itself treats these as pinned 4626 vaults. Verified on chain
 * 2026-08-21: the Base vault is 4626 over USDC with `maxDeposit` unbounded, and
 * a bytecode scan finds `deposit`/`redeem`/`withdraw`/`maxRedeem` with **no**
 * request/queue/cooldown selectors, so `instant` is an honest exit verdict.
 *
 * **Avalanche is deliberately absent even though two vaults exist there.**
 * `0x124D00b1…` and `0xC0485C4b…` are BOTH USDC vaults on the same chain, and
 * `pinnedVaultResolver` requires exactly one match per (chain, asset) — two is
 * an ambiguity, and ambiguity is a refusal (§8.2). Listing them would resolve
 * nothing while looking like coverage. Splitting them needs an exact key
 * (DeFiLlama labels them `40avax-USDC-Vault` and `40avax-blackhole-USDC-Vault`,
 * but `poolMeta` is not what the pinned resolver matches on), so they stay
 * Manual until the resolver can disambiguate by label.
 *
 * Note the Base and Optimism addresses are different contracts: `0x08dCDBf7…`
 * ALSO exists on Base, as an empty vault (`totalAssets() == 0`) that DeFiLlama
 * publishes no row for. Pinning per chain keeps them apart — pin the Base
 * address on Base only, and the Optimism one on Optimism only.
 */
export const FORTY_ACRES_VAULTS: PinnedVaultBook = {
  10: [
    {
      vault: "0x08dCDBf7baDe91Ccd42CB2a4EA8e5D199d285957",
      asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC (native)
      label: "40op-USDC-Vault",
    },
  ],
  8453: [
    {
      vault: "0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      label: "40base-USDC-Vault",
    },
  ],
};

/**
 * Avantis — the `avUSDC` liquidity vault on Base. One vault, one asset, so it
 * pins rather than discovers.
 *
 * **Provenance (security sign-off finding 4, closed 2026-08-21).** This was
 * previously transcribed from DeFiLlama's `yield-server/src/adaptors/avantis`,
 * i.e. an aggregator, which ./README.md rule 1 does not accept. It now comes
 * from Avantis's OWN registry:
 *
 *   GET https://tx-builder.avantisfi.com/addresses
 *     → data.addresses.tranche = 0x944766f715b51967E56aFdE5f0Aa76cEaCc9E7f9
 *       (chainId 8453)
 *
 * That endpoint is authenticated rather than taken on trust: all EIGHT of its
 * sibling addresses (tradingRouter, tradingStorage, pairStorage, pairInfos,
 * priceAggregator, usdc, multicall, referral) match Avantis's published
 * `Avantis-Labs/avantis-trading-skill` → `contracts.md` table exactly. A second
 * endpoint, `GET /v2/lp/state`, independently returns the same `tranche`.
 *
 * Then tied to the chain: the vault's on-chain `totalAssets()` and
 * `totalSupply()` match that endpoint's reported values EXACTLY (18078157898262
 * / 13331490199376 at time of review), so the API demonstrably describes this
 * contract and not merely an address that looks plausible. `symbol()` = avUSDC,
 * `asset()` = Base USDC, `decimals()` = 6. It is an EIP-1967 proxy, so the
 * shape check was run against the implementation (0xbd1a1896…) too — plain
 * 4626, no request, queue or cooldown selectors.
 *
 * Avantis publishes no STATIC document listing the tranche (contracts.md covers
 * the trading contracts only, and notes vault internals live in a private
 * repo), so both documentary sources are endpoints of the same first-party
 * service. That is well above aggregator provenance but worth re-checking if
 * the address ever appears in a static Avantis doc.
 *
 * **Exit is instant but CONDITIONAL, and the card must not overstate it.**
 * `/v2/lp/state` reports `withdrawThreshold` — documented as "utilization
 * ceiling for withdrawals, 1e10-scaled; withdrawals that would push utilization
 * above it REVERT" — at 90%, against a current `utilizationRatio` of ~9.4%.
 * There is no lock or epoch (Avantis' SDK: "No lock/epoch in v2: withdrawals
 * are immediate, gated by utilization"), so `instant` is the right verdict
 * today, but a MAX withdraw can revert when the vault is heavily utilised
 * (§11.3b, §12 Q2).
 *
 * **What this vault IS matters more than its ABI.** It is the counterparty
 * side of a perps venue: depositors underwrite trader PnL, so the share price
 * can fall on trading losses in a way a lending vault's cannot. The 4626
 * machinery executes it correctly either way; whether it belongs in a
 * conservative tier is a scoring decision, not a resolver one.
 */
export const AVANTIS_VAULTS: PinnedVaultBook = {
  8453: [
    {
      vault: "0x944766f715b51967E56aFdE5f0Aa76cEaCc9E7f9",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      label: "avUSDC",
    },
  ],
};

// ── Aave v4 (hub-and-spoke) ─────────────────────────────────────────────────

/** One Aave v4 TokenizationSpoke: an ERC-4626 over one asset of one hub. */
export interface AaveV4TokenizationSpoke {
  readonly vault: Address;
  readonly asset: Address;
  /** The hub the spoke supplies to; proven on chain via `hub()` at resolve. */
  readonly hub: Address;
  /** The hub's name in Aave's book (CORE, PRIME, GLOBAL_DOLLAR, ...). */
  readonly hubName: string;
  readonly label: string;
}

export type AaveV4TokenizationBook = Readonly<
  Record<number, readonly AaveV4TokenizationSpoke[]>
>;

/**
 * Aave v4 TokenizationSpokes: Aave's own "ERC4626 compliant wrapper to
 * tokenize one listed asset of the connected Hub" (aave/aave-v4
 * src/spoke/TokenizationSpoke.sol). Depositing into one supplies to that hub
 * asset, so a v4 hub pool executes through the generic `erc4626` kind and
 * every ERC-4626 safety check, with no v4-specific call shape.
 *
 * Source: bgd-labs/aave-address-book src/AaveV4{Ethereum,Avalanche,Arc,Base}.sol
 * (`*_TOKENIZATION_SPOKE` and `*_HUB` constants). Verified on chain
 * 2026-10-26: every spoke's hub() equals the hub its constant names, and
 * asset() is the underlying recorded here. Added WITHOUT a human
 * countersignature under the owner's 2026-10-26 waiver (sign-off log
 * section 12). `hubName` is matched against a pool's poolMeta, which
 * DeFiLlama and the market API both set to the hub's name.
 */
export const AAVE_V4_TOKENIZATION_SPOKES: AaveV4TokenizationBook = {
  // Ethereum
  1: [
    {
      vault: "0x7320CF22Ac095bA2a2e0a652F77efB836c2E751b",
      asset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreWETH",
    }, // WETH
    {
      vault: "0xcb0E7dA9c635628f6d4827355AeCa75aB8d3560f",
      asset: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCorewstETH",
    }, // wstETH
    {
      vault: "0x559cEc2C840D9DBB18936Afc5E5341D78bfC7Cbe",
      asset: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreweETH",
    }, // weETH
    {
      vault: "0x45a04Ca1A5cbEeA4B44356c75EDd29b33eB2527a",
      asset: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCorersETH",
    }, // rsETH
    {
      vault: "0x5eC44a70F309854fe04d495cFE1B5dA63DD1cc73",
      asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreUSDT",
    }, // USDT
    {
      vault: "0x531E90a2376902DE8915789Fcc1075e3B0c153E7",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreUSDC",
    }, // USDC
    {
      vault: "0x58C14a5E061c9bC6926c5b853445290F296C2F7B",
      asset: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreGHO",
    }, // GHO
    {
      vault: "0xC8a125AE4275a78AADc53B46Ca10566Bc9B249E0",
      asset: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreRLUSD",
    }, // RLUSD
    {
      vault: "0xAC2435E3C25e8246870D33ce0a26988A46d5DB68",
      asset: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreUSDG",
    }, // USDG
    {
      vault: "0x2226749630775ee20230Ad65214fB339087eF30D",
      asset: "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCorefrxUSD",
    }, // frxUSD
    {
      vault: "0x6D9e2Cdd61CaF69af99b275704B6e272C41c6718",
      asset: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreEURC",
    }, // EURC
    {
      vault: "0x82A9CC4656784E55Ef2E78F704028B5E1Bfc1732",
      asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreWBTC",
    }, // WBTC
    {
      vault: "0x33B41B74366F55327d959FfF6D6b6fBc2853dbB1",
      asset: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCorecbBTC",
    }, // cbBTC
    {
      vault: "0x7961F140B570490849DB878AE222570ea838799d",
      asset: "0x8236a87084f8B84306f72007F36F2618A5634494",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreLBTC",
    }, // LBTC
    {
      vault: "0x4E712562fcb5337011398B6C630f55b60641cd5e",
      asset: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreXAUt",
    }, // XAUt
    {
      vault: "0x0A65197b16C5969F92672051c9C9C0C75B369135",
      asset: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreAAVE",
    }, // AAVE
    {
      vault: "0xE69C2045095C8Ab3E2a7d77de2328faE5baF797c",
      asset: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      hub: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
      hubName: "CORE",
      label: "waCoreLINK",
    }, // LINK
    {
      vault: "0x90774889c22D2F2Adf44da1f04C7c95542590df4",
      asset: "0x3de0ff76E8b528C092d47b9DaC775931cef80F49",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "aPlus-PT_sUSDE_7MAY2026",
    }, // PT-sUSDE-7MAY2026
    {
      vault: "0xdd2Eb78BF9e6aC5068B95aD2d451e8c9Af10ac81",
      asset: "0xAeBf0Bb9f57E89260d57f31AF34eB58657d96Ce0",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "aPlus-PT_USDE_7MAY2026",
    }, // PT-USDe-7MAY2026
    {
      vault: "0x24f8c062e1E0451736C1D6E023510DA262a41df4",
      asset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "waPlussUSDe",
    }, // sUSDe
    {
      vault: "0x502Cd81da6a8F1785eb2eEE72713B7388E16A854",
      asset: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "waPlusUSDe",
    }, // USDe
    {
      vault: "0xc94bdd83D2c7655C280655D60954e79E88D4F949",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "waPlusUSDC",
    }, // USDC
    {
      vault: "0xA54382db40EC602c0a173A08f9E86Ed40F9D4D10",
      asset: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "waPlusGHO",
    }, // GHO
    {
      vault: "0x80835EB50694EE0e519743f67e5401e6FD300006",
      asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      hub: "0x06002e9c4412CB7814a791eA3666D905871E536A",
      hubName: "PLUS",
      label: "waPlusUSDT",
    }, // USDT
    {
      vault: "0x2087513383330B961A3753B47627Bbf149F31c70",
      asset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimeWETH",
    }, // WETH
    {
      vault: "0x5AE3d87De89CA6Ce501e8317887F71EABED69E18",
      asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimeWBTC",
    }, // WBTC
    {
      vault: "0xD38098faf52D8E915EdED84fBF30F81C17906938",
      asset: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimecbBTC",
    }, // cbBTC
    {
      vault: "0xFCD3D3C69cd032DE0cc78fE529B7447D2fe7F666",
      asset: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimewstETH",
    }, // wstETH
    {
      vault: "0x486415fb1F8b062c89ED548f871cf64304AACb31",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimeUSDC",
    }, // USDC
    {
      vault: "0x46c588DD8453aC259c1f6a54b4C9A93C2aC3762D",
      asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimeUSDT",
    }, // USDT
    {
      vault: "0x900fD46d565d1ac8995928c0179052ec02a6D0E1",
      asset: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
      hub: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
      hubName: "PRIME",
      label: "waPrimeGHO",
    }, // GHO
    {
      vault: "0x7Df10B4A01350D2A1d95cFbE7c9207d7210A2663",
      asset: "0xc1906aeCf868749a2DeE203F59b904c0cf212140",
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarPT_USDG_24SEP2026",
    }, // PT-USDG-24SEP2026
    {
      vault: "0xaed7c529bD2878170B61C758DfAa215AC7a4FD07",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarUSDC",
    }, // USDC
    {
      vault: "0xa0e97e45C2f89003730E467Bd484fA3eEcE5B4Cf",
      asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarUSDT",
    }, // USDT
    {
      vault: "0x378B4a7c394E22bd562F66eB612165893533c124",
      asset: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarUSDG",
    }, // USDG
    {
      vault: "0x6493a23874b506D5Bb6038ea44aE9CC74cD00849",
      asset: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarPAXG",
    }, // PAXG
  ],
  // Arc
  5042: [
    {
      vault: "0x42EAB64310E1D1c66b4d8aF7C9C4ce253885eB83",
      asset: "0x3600000000000000000000000000000000000000",
      hub: "0x17288dfc86205301064577b98B02b81017e6F79C",
      hubName: "CORE",
      label: "waCoreUSDC",
    }, // USDC
    {
      vault: "0x5A10b1533C0f1f181DC8a428BF5Eb58B08fc8d2c",
      asset: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
      hub: "0x17288dfc86205301064577b98B02b81017e6F79C",
      hubName: "CORE",
      label: "waCoreEURC",
    }, // EURC
    {
      vault: "0x83D364DbAf4e7018E0b87dB3FaB3d1d8535a6F13",
      asset: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
      hub: "0x17288dfc86205301064577b98B02b81017e6F79C",
      hubName: "CORE",
      label: "waCorecirBTC",
    }, // cirBTC
    {
      vault: "0xe8B890fea6e1E3915A337eD3136487F2f4f7e59D",
      asset: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
      hub: "0x17288dfc86205301064577b98B02b81017e6F79C",
      hubName: "CORE",
      label: "waCoreWETH",
    }, // WETH
  ],
  // Base
  8453: [
    {
      vault: "0x7081CE7EB1282c53CF38EA9B622f6269cb8FeFDc",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      hub: "0xa4d5947Eb727A052bae69C593FfC84247EC9864E",
      hubName: "EQUITIES",
      label: "waEquitiesUSDC",
    }, // USDC
  ],
  // Avalanche
  43114: [
    {
      vault: "0x1604D602f8A05CBA2d8Ff5d14DE4C3498f15B6B4",
      asset: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreWAVAX",
    }, // WAVAX
    {
      vault: "0x7cd3Ccc737f442050a861EC6b00768AE96B2F58E",
      asset: "0x152b9d0FdC40C096757F570A51E494bd4b943E50",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreBTCb",
    }, // BTC.b
    {
      vault: "0x01D7f7B7CE2123192fECC20bd1caF3e4d9e4C10D",
      asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreUSDC",
    }, // USDC
    {
      vault: "0x2E4BA06fF97E10D09FA4F5a270e97301eae729A9",
      asset: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreUSDT",
    }, // USDt
    {
      vault: "0xF5c849468318c8D5670020fdb96ae135FED37070",
      asset: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreWETHe",
    }, // WETH.e
    {
      vault: "0x7b538a1840EAf2Ed92EEB67eE744AE627335e201",
      asset: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoreEURC",
    }, // EURC
    {
      vault: "0x6c27A7435040B7cC512319d5690BeEF234dfE76e",
      asset: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
      hub: "0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e",
      hubName: "CORE",
      label: "waCoresAVAX",
    }, // sAVAX
  ],
};
