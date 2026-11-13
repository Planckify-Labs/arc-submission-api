/**
 * Chainlink feeds behind the `ExchangeRate` rows the FX sync writes.
 *
 * Why pinned in code and not a dashboard-editable table: these addresses set
 * the price QRIS payments are quoted at. A feed address ops can edit is a feed
 * address someone can point at a contract they control. Same reasoning as
 * `CHAINLINK_FEEDS` in `strategies/targets/address-book/oracles.ts`: widening
 * this list is a reviewed diff.
 *
 * What is NOT pinned: which tokens get prices (that comes from the `Token`
 * table at runtime, see `derivePairs`) and RPC endpoints (from each chain's
 * `Blockchain` row, normally an rpc-proxy route). A token listed in the DB with
 * no feed here is skipped; adding its feed is the only code change needed.
 *
 * Order matters: per asset, the first feed that reads clean wins, so Arc comes
 * first and other chains are fallbacks. Consumers read the `ExchangeRate`
 * table, not the chain, so a price may come from any chain.
 *
 * Source: Chainlink's reference-data directory
 * (`reference-data-directory.vercel.app/feeds-<network>.json`), standard
 * (non-SVR) feeds only. Every read re-checks `description()` and `decimals()`
 * against the pin; `chainlink-feeds-drift.spec.ts` (DRIFT_CHECKS=1) checks
 * every pin live. Verified 2026-11-13.
 */

export type FeedAddress = `0x${string}`;

export interface ChainlinkFxFeedPin {
  /** Unique id, `<chain>:<ASSET>/USD`. */
  key: string;
  /** Upper-case asset priced in USD (matched against `Token.symbol`). */
  asset: string;
  chainId: number;
  address: FeedAddress;
  /** Exact on-chain `description()`; a mismatch fails the read. */
  description: string;
  decimals: number;
  /** Max seconds between updates Chainlink guarantees for this feed. */
  heartbeatSec: number;
  /**
   * Values outside this band are refused. Set on USD stablecoins so a depeg
   * or a broken feed never reprices payments.
   */
  band?: { min: number; max: number };
}

const USD_PEG = { min: 0.97, max: 1.03 } as const;
const DAY = 86_400;

/** Asset of the fiat leg used for `<token>→IDR`. */
export const IDR_ASSET = "IDR";

export const CHAINLINK_FX_FEEDS: readonly ChainlinkFxFeedPin[] = [
  // ── USD stablecoins ──
  {
    key: "arc:USDC/USD",
    asset: "USDC",
    chainId: 5042,
    address: "0x84EA90AC252Dc437031461836DB5164219147905",
    description: "USDC / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },
  {
    key: "base:USDC/USD",
    asset: "USDC",
    chainId: 8453,
    address: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
    description: "USDC / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },
  {
    key: "eth:USDC/USD",
    asset: "USDC",
    chainId: 1,
    address: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    description: "USDC / USD",
    decimals: 8,
    heartbeatSec: 82_800,
    band: USD_PEG,
  },

  {
    key: "arc:USDT/USD",
    asset: "USDT",
    chainId: 5042,
    address: "0x9F95c96324c07166B6C329B317c96DeD1dc14387",
    description: "USDT / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },
  {
    key: "base:USDT/USD",
    asset: "USDT",
    chainId: 8453,
    address: "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
    description: "USDT / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },
  {
    key: "eth:USDT/USD",
    asset: "USDT",
    chainId: 1,
    address: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    description: "USDT / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },

  // AUSD answers in 18 decimals.
  {
    key: "eth:AUSD/USD",
    asset: "AUSD",
    chainId: 1,
    address: "0xB00341502DfEA6Ced8A5786b4059d29dA5E4D1FD",
    description: "AUSD / USD",
    decimals: 18,
    heartbeatSec: DAY,
    band: USD_PEG,
  },
  {
    key: "eth:USDG/USD",
    asset: "USDG",
    chainId: 1,
    address: "0x14f0737d6b705259e521EA6E9E3506AC78dBd311",
    description: "USDG / USD",
    decimals: 8,
    heartbeatSec: DAY,
    band: USD_PEG,
  },

  // ── EUR stablecoin (no USD band: it tracks EUR/USD) ──
  {
    key: "arc:EURC/USD",
    asset: "EURC",
    chainId: 5042,
    address: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23",
    description: "EURC / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
  {
    key: "base:EURC/USD",
    asset: "EURC",
    chainId: 8453,
    address: "0xDAe398520e2B67cd3f27aeF9Cf14D93D927f8250",
    description: "EURC / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
  {
    key: "eth:EURC/USD",
    asset: "EURC",
    chainId: 1,
    address: "0x04F84020Fdf10d9ee64D1dcC2986EDF2F556DA11",
    description: "EURC / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },

  // ── Volatile assets (USD price history only; see derivePairs) ──
  {
    key: "arc:ETH/USD",
    asset: "ETH",
    chainId: 5042,
    address: "0x50FCDD99D6762D1C170DC6A9111db944AEE6D364",
    description: "ETH / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
  {
    key: "eth:ETH/USD",
    asset: "ETH",
    chainId: 1,
    address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    description: "ETH / USD",
    decimals: 8,
    heartbeatSec: 3_600,
  },
  {
    key: "arc:SOL/USD",
    asset: "SOL",
    chainId: 5042,
    address: "0x2d04D354f5fDaE3De723df475745B0a9B4edf90C",
    description: "SOL / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
  {
    key: "eth:SOL/USD",
    asset: "SOL",
    chainId: 1,
    address: "0x4ffC43a60e009B551865A93d232E33Fce9f01507",
    description: "SOL / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
  {
    key: "base:SUI/USD",
    asset: "SUI",
    chainId: 8453,
    address: "0x491a921c41d6a97C57426E0c0108a231cd6E5f60",
    description: "SUI / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },

  // ── Fiat leg. Arc has no IDR feed; Base updates hourly, Ethereum daily. ──
  {
    key: "base:IDR/USD",
    asset: IDR_ASSET,
    chainId: 8453,
    address: "0x05A6cF213EcC5501A11a08EBefA4A8a60313ef97",
    description: "IDR / USD",
    decimals: 8,
    heartbeatSec: 3_600,
  },
  {
    key: "eth:IDR/USD",
    asset: IDR_ASSET,
    chainId: 1,
    address: "0x91b99C9b75aF469a71eE1AB528e8da994A5D7030",
    description: "IDR / USD",
    decimals: 8,
    heartbeatSec: DAY,
  },
];

/** `ExchangeSource.name` and `ExchangeRate.provider` for rows written here. */
export const CHAINLINK_SOURCE_NAME = "Chainlink";
export const CHAINLINK_PROVIDER = "chainlink";
