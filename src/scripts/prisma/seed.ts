import {
  PrismaClient,
  ApiKeyType,
  ApiKeyStatus,
  UserRole,
  AuthProvider,
  ChannelKind,
} from "@generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as argon2 from "argon2";
import {
  createPublicClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { readContract } from "viem/actions";
import { SignJWT } from "jose";
import { encryptAccountNumber } from "../../payout/account-number-crypto";
import { DUITKU_CHANNEL_CODES } from "../../payout/duitku-channels";
import { FLIP_CHANNEL_CODES } from "../../payout/flip-channels";
import { XENDIT_CHANNEL_CODES } from "../../payout/xendit-channels";
import {
  DAPP_CATEGORY_SEED,
  DAPP_SEED,
  DAPP_PROMOTION_SEED,
  type DappCategoryKey,
} from "./dapps-data";

// Aave V3 ABI fragments — single source of truth for shapes is
// https://aave.com/docs/aave-v3/smart-contracts and
// `@bgd-labs/aave-address-book`. We start from the already-seeded Pool
// address (SmartContract `aave_v3_pool`) and resolve everything else —
// PoolAddressesProvider → PoolDataProvider → reserves → aTokens — via
// on-chain reads. No hand-typed testnet token coordinates anywhere.
const POOL_ABI = [
  {
    name: "ADDRESSES_PROVIDER",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  // Returns ReserveDataLegacy (Aave V3 standard). We only consume
  // currentLiquidityRate (supply APY in RAY-format), so the tuple
  // shape stays minimal — viem accepts the abbreviated outputs as
  // long as the function selector and prefix types match.
  {
    name: "getReserveData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
] as const;

const ERC20_TOTAL_SUPPLY_ABI = [
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Aave V3 returns rates in RAY (1e27). Supply APR is the annualized linear
// rate; APY is computed with per-second compounding (per Aave docs).
// https://aave.com/docs/developers/smart-contracts/pool#getreservedata
const SECONDS_PER_YEAR = 31_536_000n;
const RAY = 10n ** 27n;
function rayApyFromLiquidityRate(currentLiquidityRate: bigint): number {
  const ratePerSecond =
    Number(currentLiquidityRate) / Number(RAY) / Number(SECONDS_PER_YEAR);
  const apy = (1 + ratePerSecond) ** Number(SECONDS_PER_YEAR) - 1;
  return apy;
}

// Mobile adapter slug per testnet chain — must match the slug registered
// in `services/defi/adapters/aaveV3.ts` for `defi_deposit` to route.
const TESTNET_SLUG_BY_CHAIN: Record<number, string> = {
  11155111: "aave-v3-sepolia",
  84532: "aave-v3-base-sepolia",
  421614: "aave-v3-arbitrum-sepolia",
};

const POOL_ADDRESSES_PROVIDER_ABI = [
  {
    name: "getPoolDataProvider",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AAVE_DATA_PROVIDER_ABI = [
  {
    name: "getAllReservesTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "symbol", type: "string" },
          { name: "tokenAddress", type: "address" },
        ],
      },
    ],
  },
  {
    name: "getReserveTokensAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
] as const;

interface AaveTestnetDeployment {
  chainName: string;
  chainId: number;
  // Symbols we care about — Aave testnets expose ~12 faucet reserves and
  // we only want the stablecoins surfaced in the asset explorer. Extend
  // here when a new strategy adapter needs a new underlying.
  symbolAllowlist: string[];
}

const AAVE_TESTNETS: AaveTestnetDeployment[] = [
  {
    chainName: "Ethereum Sepolia",
    chainId: 11155111,
    symbolAllowlist: ["USDC"],
  },
  { chainName: "Base Sepolia", chainId: 84532, symbolAllowlist: ["USDC"] },
  { chainName: "Arbitrum Sepolia", chainId: 421614, symbolAllowlist: ["USDC"] },
];

interface VCGamersProduct {
  key: string;
  name: string;
  image_url: string;
  description?: string;
  is_voucher: boolean;
  is_active: boolean;
  forms?: Array<{
    key: string;
    type: string;
    alias: string;
    options?: string[];
  }>;
}

interface VCGamersVariant {
  key: string;
  variation_name: string;
  brand_name: string;
  price: number;
  is_active: boolean;
  sla: number;
  is_new: boolean;
}

const CACHE_DIR = path.join(process.cwd(), "data", "vendor-cache");

const cacheHelpers = {
  ensureCacheDir: (): void => {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  },

  getCacheFilePath: (filename: string): string => {
    return path.join(CACHE_DIR, `${filename}.json`);
  },

  loadFromCache: <T>(filename: string): T | null => {
    try {
      const filePath = cacheHelpers.getCacheFilePath(filename);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf8");
        console.log(`📁 Loading cached data from: ${filename}.json`);
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn(`⚠️ Error loading cache file ${filename}:`, error);
    }
    return null;
  },

  saveToCache: <T>(filename: string, data: T): void => {
    try {
      cacheHelpers.ensureCacheDir();
      const filePath = cacheHelpers.getCacheFilePath(filename);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`💾 Saved data to cache: ${filename}.json`);
    } catch (error) {
      console.error(`❌ Error saving cache file ${filename}:`, error);
    }
  },

  clearCache: (): void => {
    try {
      if (fs.existsSync(CACHE_DIR)) {
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
          if (file.endsWith(".json")) {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          }
        }
        console.log(`🗑️ Cleared cache directory: ${CACHE_DIR}`);
      }
    } catch (error) {
      console.error(`❌ Error clearing cache:`, error);
    }
  },

  getCacheInfo: (): void => {
    try {
      if (fs.existsSync(CACHE_DIR)) {
        const files = fs
          .readdirSync(CACHE_DIR)
          .filter((f) => f.endsWith(".json"));
        console.log(`📊 Cache directory: ${CACHE_DIR}`);
        console.log(`📁 Cached files: ${files.length}`);
        files.forEach((file) => {
          const filePath = path.join(CACHE_DIR, file);
          const stats = fs.statSync(filePath);
          console.log(
            `   - ${file} (${(stats.size / 1024).toFixed(2)} KB, modified: ${stats.mtime.toISOString()})`,
          );
        });
      } else {
        console.log(`📁 No cache directory found`);
      }
    } catch (error) {
      console.error(`❌ Error reading cache info:`, error);
    }
  },
};

const vcGamersAPI = {
  createSignature: (params: string): string => {
    const secret = "8aa3a704a9c2af43c636df2e59828777";
    const hmac = crypto
      .createHmac("sha512", secret)
      .update(params)
      .digest("hex");
    return Buffer.from(hmac).toString("base64");
  },

  getProducts: async (): Promise<{
    statusCode: number;
    data?: VCGamersProduct[];
  }> => {
    const cachedData = cacheHelpers.loadFromCache<{
      statusCode: number;
      data?: VCGamersProduct[];
    }>("vcgamers-products");

    if (cachedData) {
      console.log("🎯 Using cached VCGamers products data");
      return cachedData;
    }

    console.log("🌐 Fetching VCGamers products from API...");
    try {
      const paramsSignature = "8aa3a704a9c2af43c636df2e59828777" + "brand";
      const signature = vcGamersAPI.createSignature(paramsSignature);
      const URL_BRAND = `https://mitra-api.vcgamers.com/v2/public/brands?sign=${signature}`;

      const fetchResponse = await fetch(URL_BRAND, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization:
            "Bearer 4d5855d626b5558e155ce6eddb7f370e7749f2e6fee891556e879d46cadb276e8c7a25a4b841efb5972e6d3d9aa2f201bb4d",
        },
      });

      const response = await fetchResponse.json();
      console.log("VCGamers API response:", response);

      if (response.code !== 200) {
        return {
          statusCode: 400,
        };
      }

      const result = {
        statusCode: 200,
        data: response?.data,
      };

      cacheHelpers.saveToCache("vcgamers-products", result);

      return result;
    } catch (err) {
      console.error("Error fetching VCGamers products:", err);
      return {
        statusCode: 500,
      };
    }
  },

  getProductVariants: async (
    brandKey: string,
  ): Promise<{
    statusCode: number;
    data?: VCGamersVariant[];
  }> => {
    const cacheKey = `vcgamers-variants-${brandKey}`;
    const cachedData = cacheHelpers.loadFromCache<{
      statusCode: number;
      data?: VCGamersVariant[];
    }>(cacheKey);

    if (cachedData) {
      console.log(`🎯 Using cached VCGamers variants for ${brandKey}`);
      return cachedData;
    }

    console.log(`🌐 Fetching VCGamers variants for ${brandKey} from API...`);
    try {
      const paramsSignature =
        "8aa3a704a9c2af43c636df2e59828777" + "variation" + brandKey;
      const signature = vcGamersAPI.createSignature(paramsSignature);
      const URL_VARIATION = `https://mitra-api.vcgamers.com/v2/public/variations?brand_key=${brandKey}&sign=${signature}`;

      const fetchResponse = await fetch(URL_VARIATION, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization:
            "Bearer 4d5855d626b5558e155ce6eddb7f370e7749f2e6fee891556e879d46cadb276e8c7a25a4b841efb5972e6d3d9aa2f201bb4d",
        },
      });

      const response = await fetchResponse.json();
      console.log(`VCGamers variants for ${brandKey}:`, response);

      if (response.code !== 200) {
        return {
          statusCode: 400,
        };
      }

      const result = {
        statusCode: 200,
        data: response?.data,
      };

      cacheHelpers.saveToCache(cacheKey, result);

      return result;
    } catch (err) {
      console.error(`Error fetching VCGamers variants for ${brandKey}:`, err);
      return {
        statusCode: 500,
      };
    }
  },
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

function generateApiKey(keyType: string): string {
  // Static API keys for consistent seeding
  const staticKeys = {
    "smart-contract":
      "tk_smart_contract_api_key_12345678901234567890123456789012",
    "mobile-app": "tk_mobile_app_api_key_12345678901234567890123456789012345",
    "web-app": "tk_web_app_api_key_123456789012345678901234567890123456",
    "third-party": "tk_third_party_api_key_12345678901234567890123456789012",
    internal: "tk_internal_api_key_123456789012345678901234567890123456",
    admin: "tk_admin_api_key_1234567890123456789012345678901234567890",
  };

  return (
    staticKeys[keyType] ||
    `tk_${keyType}_static_key_123456789012345678901234567890`
  );
}

async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password);
}

async function seedApiKeys() {
  console.log("🌱 Seeding API keys...");

  const apiKeys = [
    {
      id: "smart-contract-api-key",
      name: "Smart Contract API Key",
      description:
        "API key for smart contract interactions and blockchain operations",
      keyValue: generateApiKey("smart-contract"),
      type: ApiKeyType.SMART_CONTRACT,
      status: ApiKeyStatus.ACTIVE,
      permissions: [
        "blockchains:read",
        "tokens:read",
        "smart-contracts:read",
        "transactions:read",
      ],
      rateLimit: 1000,
      metadata: {
        environment: "production",
        ipRestrictions: [],
        allowedOrigins: ["*"],
      },
    },
    {
      id: "mobile-app-api-key",
      name: "Mobile App API Key",
      description: "API key for TakumiPay mobile application",
      keyValue: generateApiKey("mobile-app"),
      type: ApiKeyType.MOBILE_APP,
      status: ApiKeyStatus.ACTIVE,
      permissions: [
        "products:read",
        "purchases:create",
        "tokens:read",
        "blockchains:read",
        "regions:read",
      ],
      rateLimit: 500,
      metadata: {
        environment: "production",
        platform: "mobile",
        version: "1.0.0",
      },
    },
    {
      id: "web-app-api-key",
      name: "Web App API Key",
      description: "API key for TakumiPay web application",
      keyValue: generateApiKey("web-app"),
      type: ApiKeyType.WEB_APP,
      status: ApiKeyStatus.ACTIVE,
      permissions: [
        "products:read",
        "purchases:create",
        "tokens:read",
        "blockchains:read",
        "smart-contracts:read",
        "regions:read",
      ],
      rateLimit: 300,
      metadata: {
        environment: "production",
        platform: "web",
        allowedOrigins: ["https://takumipay.xyz", "https://app.takumipay.xyz"],
      },
    },
    {
      id: "third-party-api-key",
      name: "Third Party Integration",
      description: "API key for third-party integrations and partners",
      keyValue: generateApiKey("third-party"),
      type: ApiKeyType.THIRD_PARTY,
      status: ApiKeyStatus.ACTIVE,
      permissions: ["products:read", "tokens:read", "blockchains:read"],
      rateLimit: 100,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      metadata: {
        partner: "example-partner",
        contact: "partner@example.com",
      },
    },
    {
      id: "internal-api-key",
      name: "Internal Services",
      description: "API key for internal microservices communication",
      keyValue: generateApiKey("internal"),
      type: ApiKeyType.INTERNAL,
      status: ApiKeyStatus.ACTIVE,
      permissions: [
        "products:read",
        "products:write",
        "tokens:read",
        "tokens:write",
        "blockchains:read",
        "blockchains:write",
        "smart-contracts:read",
        "smart-contracts:write",
        "transactions:read",
        "transactions:write",
        "users:read",
        "vendors:read",
      ],
      rateLimit: 2000,
      metadata: {
        service: "internal-microservices",
        environment: "production",
      },
    },
    {
      id: "admin-api-key",
      name: "Admin Dashboard",
      description: "API key for admin dashboard and management operations",
      keyValue: generateApiKey("admin"),
      type: ApiKeyType.ADMIN,
      status: ApiKeyStatus.ACTIVE,
      permissions: ["*"],
      rateLimit: 5000,
      metadata: {
        role: "admin",
        environment: "production",
        ipRestrictions: ["10.0.0.0/8", "192.168.0.0/16"],
      },
    },
  ];

  for (const apiKeyData of apiKeys) {
    try {
      const apiKey = await prisma.apiKey.upsert({
        where: { id: apiKeyData.id },
        update: {
          name: apiKeyData.name,
          description: apiKeyData.description,
          type: apiKeyData.type,
          status: apiKeyData.status,
          permissions: apiKeyData.permissions,
          rateLimit: apiKeyData.rateLimit,
          expiresAt: apiKeyData.expiresAt,
          metadata: apiKeyData.metadata,
        },
        create: apiKeyData,
      });

      console.log(`✅ Created/Updated API key: ${apiKey.name}`);
      console.log(`   Key: ${apiKey.keyValue}`);
      console.log(`   Type: ${apiKey.type}`);
      console.log(`   Rate Limit: ${apiKey.rateLimit} req/min`);
      console.log("");
    } catch (error) {
      console.error(`❌ Error creating API key ${apiKeyData.name}:`, error);
    }
  }

  console.log("🎉 API keys seeding completed!");
}

async function seedAdminUsers() {
  console.log("🌱 Seeding admin users...");

  const adminUsers = [
    {
      id: "admin-user-1",
      email: "admin@takumipay.xyz",
      password: await hashPassword("Admin123!"),
      name: "System Admin",
      username: "admin",
      authProvider: AuthProvider.ADMIN_CREDENTIALS,
      role: UserRole.ADMIN,
      permissions: {
        users: ["read", "write"],
        products: ["read", "write"],
        transactions: ["read"],
      },
    },
    {
      id: "super-admin-user",
      email: "superadmin@takumipay.xyz",
      password: await hashPassword("SuperAdmin123!"),
      name: "Super Administrator",
      username: "superadmin",
      authProvider: AuthProvider.ADMIN_CREDENTIALS,
      role: UserRole.SUPER_ADMIN,
      permissions: {
        "*": ["*"],
      },
    },
  ];

  for (const adminData of adminUsers) {
    try {
      const admin = await prisma.user.upsert({
        where: { id: adminData.id },
        update: {
          email: adminData.email,
          password: adminData.password,
          name: adminData.name,
          username: adminData.username,
          role: adminData.role,
          permissions: adminData.permissions,
        },
        create: adminData,
      });

      console.log(`✅ Created/Updated admin user: ${admin.name}`);
      console.log(`   Email: ${admin.email}`);
      console.log(`   Role: ${admin.role}`);
      console.log("");
    } catch (error) {
      console.error(`❌ Error creating admin user ${adminData.name}:`, error);
    }
  }
}

async function main() {
  console.log("🌱 Starting TakumiPay database seeding...");
  console.log("");

  console.log("📊 Cache Status:");
  cacheHelpers.getCacheInfo();
  console.log("");

  // Uncomment the line below to clear cache and force fresh API calls
  // cacheHelpers.clearCache();

  const regions = await Promise.all([
    prisma.region.upsert({
      where: { code: "ID" },
      update: {},
      create: {
        code: "ID",
        name: "Indonesia",
        currencyCode: "IDR",
        isActive: true,
        taxRate: 11,
        supportEmail: "support-id@takumipay.xyz",
        supportPhone: "+62123456789",
      },
    }),
    prisma.region.upsert({
      where: { code: "SG" },
      update: {},
      create: {
        code: "SG",
        name: "Singapore",
        currencyCode: "SGD",
        isActive: true,
        taxRate: 7,
        supportEmail: "support-sg@takumipay.xyz",
        supportPhone: "+6587654321",
      },
    }),
  ]);

  const blockchains = await Promise.all([
    prisma.blockchain.upsert({
      where: { chainId: 1 },
      update: {
        rpcUrl: "/evm/1",
      },
      create: {
        name: "Ethereum",
        chainId: 1,
        rpcUrl: "/evm/1",
        blockExplorer: "https://etherscan.io",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    prisma.blockchain.upsert({
      where: { chainId: 137 },
      update: {
        rpcUrl: "/evm/137",
      },
      create: {
        name: "Polygon",
        chainId: 137,
        rpcUrl: "/evm/137",
        blockExplorer: "https://polygonscan.com",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    prisma.blockchain.upsert({
      where: { chainId: 11155111 },
      update: {
        rpcUrl: "/evm/11155111",
        blockExplorer: "https://sepolia.etherscan.io",
      },
      create: {
        name: "Ethereum Sepolia",
        chainId: 11155111,
        rpcUrl: "/evm/11155111",
        blockExplorer: "https://sepolia.etherscan.io",
        type: "EVM",
        isActive: true,
        isTestnet: true,
      },
    }),
    prisma.blockchain.upsert({
      where: { chainId: 84532 },
      update: {
        rpcUrl: "/evm/84532",
        // Was "Base", which shadowed mainnet 8453 in every by-name lookup:
        // DeFiLlama's "Base" matched THIS testnet row, so every Base DeFi pool
        // silently degraded to Manual. Set in `update` as well as `create` so
        // re-running the seed repairs an already-seeded database.
        name: "Base Sepolia",
      },
      create: {
        name: "Base Sepolia",
        chainId: 84532,
        rpcUrl: "/evm/84532",
        blockExplorer: "https://sepolia.basescan.org",
        type: "EVM",
        isActive: true,
        isTestnet: true,
      },
    }),
    prisma.blockchain.upsert({
      where: { chainId: 421614 },
      update: {
        rpcUrl: "/evm/421614",
      },
      create: {
        name: "Arbitrum Sepolia",
        chainId: 421614,
        rpcUrl: "/evm/421614",
        blockExplorer: "https://sepolia.arbiscan.io",
        type: "EVM",
        isActive: true,
        isTestnet: true,
      },
    }),
    prisma.blockchain.upsert({
      where: { chainId: 42161 },
      update: {
        rpcUrl: "/evm/42161",
      },
      create: {
        name: "Arbitrum",
        chainId: 42161,
        rpcUrl: "/evm/42161",
        blockExplorer: "https://arbiscan.io",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // BSC — keyed by chainId 56 (evmChain()). Named "BSC", not "BNB Smart
    // Chain": DeFiLlama's own pool `chain` field says "BSC" (confirmed live
    // in OpportunityCache 2026-08-22), and chain-directory.ts's `byName`
    // lookup normalises on the row's bare `name` — matching the external
    // catalog directly avoids needing a `STRATEGIES_CHAIN_ALIASES` entry, the
    // same reasoning the "Base" (not "Base Mainnet") row already documents.
    // Unblocks the Venus/Benqi/Aave-v3 BSC resolvers, which were already
    // pinned and drift-verified but never ran because no chain row existed
    // (see docs/runbooks/defi-manual-reasons-reference.md §5).
    prisma.blockchain.upsert({
      where: { chainId: 56 },
      update: {
        rpcUrl: "/evm/56",
      },
      create: {
        name: "BSC",
        chainId: 56,
        rpcUrl: "/evm/56",
        blockExplorer: "https://bscscan.com",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Avalanche C-Chain — keyed by chainId 43114 (evmChain()). Same
    // seed-driven-DeFi rationale as BSC above; DeFiLlama's `chain` field is
    // "Avalanche", matching this row's bare name.
    prisma.blockchain.upsert({
      where: { chainId: 43114 },
      update: {
        rpcUrl: "/evm/43114",
      },
      create: {
        name: "Avalanche",
        chainId: 43114,
        rpcUrl: "/evm/43114",
        blockExplorer: "https://snowtrace.io",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Solana mainnet — no EIP-155 chainId; keyed by chainSlug (cluster name).
    // `solanaCluster` maps to the sentinel chain IDs used by the intents
    // service (-101 mainnet, -102 devnet).
    prisma.blockchain.upsert({
      where: { chainSlug: "solana-mainnet" },
      update: {
        rpcUrl: "/solana/mainnet",
        solanaCluster: "mainnet-beta",
      },
      create: {
        name: "Solana",
        chainSlug: "solana-mainnet",
        rpcUrl: "/solana/mainnet",
        blockExplorer: "https://explorer.solana.com",
        type: "SVM",
        isActive: true,
        isTestnet: false,
        solanaCluster: "mainnet-beta",
      },
    }),
    prisma.blockchain.upsert({
      where: { chainSlug: "solana-devnet" },
      update: {
        rpcUrl: "/solana/devnet",
        solanaCluster: "devnet",
      },
      create: {
        name: "Solana Devnet",
        chainSlug: "solana-devnet",
        rpcUrl: "/solana/devnet",
        blockExplorer: "https://explorer.solana.com?cluster=devnet",
        type: "SVM",
        isActive: true,
        isTestnet: true,
        solanaCluster: "devnet",
      },
    }),
    // Arc Testnet — UMKM USDC payout settlement chain (spec §7 / task 26).
    // Appended at the end of the array so existing `blockchains[N]`
    // references don't shift. `isTestnet` stays true for the life of
    // this row; when Arc mainnet launches (§12 Q1), add a SEPARATE
    // seed entry with the mainnet chainId / rpcUrl / blockExplorer
    // and `isTestnet: false`, plus a paired Token entry at the mainnet
    // USDC contract. To retire this testnet row from user-facing
    // lists, flip `isActive = false` (never `isTestnet`). No schema
    // changes required for the mainnet cut-over.
    prisma.blockchain.upsert({
      where: { chainId: 5042002 },
      update: {
        rpcUrl: "/evm/5042002",
        blockExplorer: "https://testnet.arcscan.app",
        // Keep x402 metadata in sync on re-seed so drift between envs always
        // converges to the values below (§7.1). Gateway wallet/minter
        // contract addresses live in SmartContract, seeded separately below
        // — no Paymaster on Arc (USDC=gas natively), so no "paymaster" row.
        metadata: {
          x402DomainName: "GatewayWalletBatched",
          x402DomainVersion: "1",
          x402FacilitatorUrl:
            "https://gateway-api-testnet.circle.com/gateway/v1/x402/settle",
        },
        // Bundler URL is server-only; Arc doesn't need one (USDC=gas → no
        // UserOps, no bundler). Explicit `null` converges drift on re-seed
        // so an ops-set URL on Arc (which would be a mistake) gets cleared.
        // Other chains intentionally don't appear in this seed's update
        // branch so ops-set URLs SURVIVE a re-seed — task 37 pattern.
        bundlerUrl: null,
      },
      create: {
        name: "Arc Testnet",
        chainId: 5042002,
        rpcUrl: "/evm/5042002",
        blockExplorer: "https://testnet.arcscan.app",
        type: "EVM",
        isActive: true,
        isTestnet: true,
        // x402 metadata (spec §7.1 Insert 1) — Gateway wallet/minter contract
        // addresses are seeded as SmartContract rows below, not here.
        metadata: {
          x402DomainName: "GatewayWalletBatched",
          x402DomainVersion: "1",
          x402FacilitatorUrl:
            "https://gateway-api-testnet.circle.com/gateway/v1/x402/settle",
        },
        bundlerUrl: null, // Arc has no bundler; see task 37 + §7.1.
      },
    }),
    // Arc Mainnet — UMKM USDC payout settlement chain & Tower Exchange swaps (spec §7 / §12).
    // EVM chain 5042, native currency USDC.
    // rpcUrl is the rpc-proxy route like every other chain — the proxy owns
    // the Alchemy key and the publicnode/drpc fallbacks for /evm/5042.
    prisma.blockchain.upsert({
      where: { chainId: 5042 },
      update: {
        rpcUrl: "/evm/5042",
        blockExplorer: "https://explorer.arc.io",
      },
      create: {
        name: "Arc",
        chainId: 5042,
        rpcUrl: "/evm/5042",
        blockExplorer: "https://explorer.arc.io",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Monad mainnet — sourced from staging-api.takumiaiwallet.xyz /blockchains.
    // EVM chain 143, native currency MON. No Gateway / Paymaster / x402 on
    // Monad — those fields stay null. Appended last to keep existing
    // Monad — keyed by chainId 143 (resolved via evmChain()).
    prisma.blockchain.upsert({
      where: { chainId: 143 },
      update: {
        rpcUrl: "/evm/143",
        blockExplorer: "https://monadvision.com",
      },
      create: {
        name: "Monad",
        chainId: 143,
        rpcUrl: "/evm/143",
        blockExplorer: "https://monadvision.com",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Monad testnet — EVM chain 10143. Added for the Monad Metropolis 2026
    // QRIS merchant-spend leg (mobile-app/docs/monad-metropolis-2026-spec.md
    // §6.6): the `takumi_pay` contract and an open-mint AUSD stand-in live
    // here, see the SmartContract / token rows below. The remittance leg is
    // on mainnet 143 above. rpc-proxy's seed carries the matching
    // `/evm/10143` upstream (Alchemy `monad-testnet` + public fallback).
    prisma.blockchain.upsert({
      where: { chainId: 10143 },
      update: {
        rpcUrl: "/evm/10143",
        blockExplorer: "https://testnet.monadvision.com",
        name: "Monad Testnet",
      },
      create: {
        name: "Monad Testnet",
        chainId: 10143,
        rpcUrl: "/evm/10143",
        blockExplorer: "https://testnet.monadvision.com",
        type: "EVM",
        isActive: true,
        isTestnet: true,
      },
    }),
    // Robinhood Chain testnet — an Arbitrum Orbit L2 (EIP-155 chainId 46630).
    // Added for the Arbitrum Open House 2026 hackathon. rpc-proxy routes it
    // (Alchemy `robinhood-testnet`, public fallback) since 2026-10-01.
    prisma.blockchain.upsert({
      where: { chainId: 46630 },
      update: {
        rpcUrl: "/evm/46630",
        blockExplorer: "https://explorer.testnet.chain.robinhood.com",
        name: "Robinhood Testnet",
      },
      create: {
        name: "Robinhood Testnet",
        chainId: 46630,
        rpcUrl: "/evm/46630",
        blockExplorer: "https://explorer.testnet.chain.robinhood.com",
        type: "EVM",
        isActive: true,
        isTestnet: true,
        minConfirmations: 1,
      },
    }),
    // Robinhood Chain mainnet (Arbitrum Orbit L2, EIP-155 chainId 4663, live
    // since 2026-07-01), routed via rpc-proxy (Alchemy `robinhood-mainnet`,
    // public fallback; see rpc-proxy/src/db/seed.ts). No takumi_pay deployment on this chain yet, so no SmartContract row and
    // its tokens are not payment-enabled.
    prisma.blockchain.upsert({
      where: { chainId: 4663 },
      update: {
        rpcUrl: "/evm/4663",
        blockExplorer: "https://robinhoodchain.blockscout.com",
        name: "Robinhood",
      },
      create: {
        name: "Robinhood",
        chainId: 4663,
        rpcUrl: "/evm/4663",
        blockExplorer: "https://robinhoodchain.blockscout.com",
        type: "EVM",
        isActive: true,
        isTestnet: false,
        minConfirmations: 1,
      },
    }),
    // Sui mainnet — keyed by chainSlug (no EIP-155 chainId, same posture
    // as Solana). Public Mysten fullnode for v1; swap in Alchemy/Triton
    // when traffic warrants. Keyed by chainSlug (slugChain()).
    // See docs/sui-chain-support-spec.md §3.8.
    prisma.blockchain.upsert({
      where: { chainSlug: "sui-mainnet" },
      update: {
        rpcUrl: "/sui/mainnet",
        blockExplorer: "https://suivision.xyz",
      },
      create: {
        name: "Sui",
        chainSlug: "sui-mainnet",
        rpcUrl: "/sui/mainnet",
        blockExplorer: "https://suivision.xyz",
        type: "MOVE_VM",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Sui testnet — keyed by chainSlug (slugChain()).
    prisma.blockchain.upsert({
      where: { chainSlug: "sui-testnet" },
      update: {
        rpcUrl: "/sui/testnet",
        blockExplorer: "https://testnet.suivision.xyz",
      },
      create: {
        name: "Sui Testnet",
        chainSlug: "sui-testnet",
        rpcUrl: "/sui/testnet",
        blockExplorer: "https://testnet.suivision.xyz",
        type: "MOVE_VM",
        isActive: true,
        isTestnet: true,
      },
    }),
    // Stellar mainnet (pubnet) — keyed by chainSlug (no EIP-155 chainId,
    // same posture as Solana/Sui). `rpcUrl` carries whatever endpoint this
    // API actually calls for this chain — on Stellar rows that's Soroban
    // RPC, not Horizon (see `Blockchain.type`'s schema comment). Which
    // upstream `/stellar/mainnet` actually lands on is rpc-proxy's call now
    // (it currently fronts Horizon, since no verified public Soroban mainnet
    // RPC has been chosen and there is no mainnet `takumi_pay` deployment
    // yet); retargeting it is a change over there, not here.
    //
    // `rpcUrl` is in `update` as well as `create` so pre-cutover rows holding
    // an absolute URL actually converge on the route — the invariant the
    // schema comment states.
    prisma.blockchain.upsert({
      where: { chainSlug: "stellar-mainnet" },
      update: {
        rpcUrl: "/stellar/mainnet",
        blockExplorer: "https://stellar.expert/explorer/public",
      },
      create: {
        name: "Stellar",
        chainSlug: "stellar-mainnet",
        rpcUrl: "/stellar/mainnet",
        blockExplorer: "https://stellar.expert/explorer/public",
        type: "STELLAR",
        isActive: true,
        isTestnet: false,
      },
    }),
    // Stellar testnet — keyed by chainSlug (slugChain()). `rpcUrl` is the
    // Soroban RPC endpoint this API calls for `takumi_pay` contract reads —
    // the contract address itself is NOT stored here, see the "takumi_pay"
    // SmartContract row below (deployed from ../contract/stellar,
    // ../contract/stellar/deployments/testnet/v1.json).
    prisma.blockchain.upsert({
      where: { chainSlug: "stellar-testnet" },
      update: {
        rpcUrl: "/stellar/testnet",
        blockExplorer: "https://stellar.expert/explorer/testnet",
      },
      create: {
        name: "Stellar Testnet",
        chainSlug: "stellar-testnet",
        rpcUrl: "/stellar/testnet",
        blockExplorer: "https://stellar.expert/explorer/testnet",
        type: "STELLAR",
        isActive: true,
        isTestnet: true,
      },
    }),
    // Base — keyed by chainId 8453 (evmChain()).
    prisma.blockchain.upsert({
      where: { chainId: 8453 },
      update: {
        rpcUrl: "/evm/8453",
        // "Base", not "Base Mainnet": external catalogs (DeFiLlama) and the
        // other mainnet rows here (Ethereum, Arbitrum, Polygon) all use the
        // bare name, and the by-name index is how a pool finds its chain.
        name: "Base",
      },
      create: {
        name: "Base",
        chainId: 8453,
        rpcUrl: "/evm/8453",
        blockExplorer: "https://basescan.org",
        type: "EVM",
        isActive: true,
        isTestnet: false,
      },
    }),
  ]);

  // Stable chain lookups — resolve rows by their canonical chainId /
  // chainSlug instead of array position. Positional `blockchains[N]` refs
  // silently drift whenever a row is inserted above them: that is exactly
  // how the native-token block below ended up attaching the "Arbitrum"
  // tokens to Arbitrum Sepolia and skipping Base Mainnet / Holesky / Arbitrum
  // mainnet entirely (their rows were appended after the refs were written).
  // New token entries MUST use these helpers, never `blockchains[N]`.
  const chainByEvmId = new Map<number, (typeof blockchains)[number]>();
  const chainBySlug = new Map<string, (typeof blockchains)[number]>();
  for (const b of blockchains) {
    if (typeof b.chainId === "number") chainByEvmId.set(b.chainId, b);
    if (b.chainSlug) chainBySlug.set(b.chainSlug, b);
  }
  const evmChain = (chainId: number) => {
    const row = chainByEvmId.get(chainId);
    if (!row) throw new Error(`seed: no blockchain row for chainId ${chainId}`);
    return row;
  };
  const slugChain = (chainSlug: string) => {
    const row = chainBySlug.get(chainSlug);
    if (!row)
      throw new Error(`seed: no blockchain row for chainSlug ${chainSlug}`);
    return row;
  };

  // Remove stale generic entry superseded by morpho-steakhouse-usdc-ethereum (same address).
  await prisma.smartContract.deleteMany({
    where: { id: "morpho-vault-ethereum" },
  });

  await Promise.all([
    // takumi_pay (EVM TakumiWallet contract) on Polygon — PLACEHOLDER address,
    // not a real deployment (contract/evm has no Polygon deployment record).
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment" },
      update: {},
      create: {
        id: "smart-contract-payment",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(137).id, // Polygon
        address: "0x1234567890123456789012345678901234567890",
        isActive: true,
      },
    }),
    // takumi_pay on Ethereum Sepolia
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-sepolia" },
      update: {},
      create: {
        id: "smart-contract-payment-sepolia",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(11155111).id, // Ethereum Sepolia
        address: "0xf64BA8EEBD3f9e268bC1989Af0dde77ab2418779",
        isActive: true,
      },
    }),
    // takumi_pay on Base Sepolia — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/84532.json. USDC allowlisted as a payment
    // token and a 1000 USDC sweep cap applied on-chain; matches the
    // Arc-testnet row below in converging `address` on re-seed rather than
    // using `update: {}`, since the previous address here
    // (0x479B0843C3e0627f36551660506dEd5b349Fa968) was a stale copy-paste of
    // the Arbitrum One mainnet proxy, not a real Base Sepolia deployment.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-base" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x999887c7365E6a344600Ea8Ba360ff7Df581aCF5",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-base",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(84532).id, // Base Sepolia
        address: "0x999887c7365E6a344600Ea8Ba360ff7Df581aCF5",
        isActive: true,
      },
    }),
    // takumi_pay on Arbitrum One — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/42161.json (Arbitrum Open House 2026).
    // USDG and USDC allowlisted with a 1000-unit sweep cap each and a 24h
    // withdrawal delay. The previous address here (0x479B…a968) was a
    // predicted CREATE address that turned out to be Monad mainnet's proxy,
    // not an Arbitrum deployment, so this row converges `address` on re-seed.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-arbitrum" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0xdE981573883294dfD35A7F0F399DB7e439E1f56B",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-arbitrum",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(42161).id, // Arbitrum One
        address: "0xdE981573883294dfD35A7F0F399DB7e439E1f56B",
        isActive: true,
      },
    }),
    // takumi_pay on Arbitrum Sepolia — see
    // ../contract/evm/deployments/421614.json. USDC and Paxos testnet USDG
    // allowlisted; createTransaction / depositPoints exercised live with both.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-arbitrum-sepolia" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x2469Bd87e809772f491af0E7847fbf7B62c388ae",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-arbitrum-sepolia",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(421614).id, // Arbitrum Sepolia
        address: "0x2469Bd87e809772f491af0E7847fbf7B62c388ae",
        isActive: true,
      },
    }),
    // takumi_pay on Robinhood Chain testnet (Arbitrum Orbit) — see
    // ../contract/evm/deployments/46630.json. Paxos testnet USDG allowlisted;
    // createTransaction, depositPoints and processMerchantPayment all
    // exercised live. Same address as Monad mainnet: same deployer key at the
    // same nonce on a fresh chain, a genuine CREATE match.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-robinhood-testnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x479B0843C3e0627f36551660506dEd5b349Fa968",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-robinhood-testnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(46630).id, // Robinhood Chain testnet
        address: "0x479B0843C3e0627f36551660506dEd5b349Fa968",
        isActive: true,
      },
    }),
    // takumi_pay on Arc Testnet — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/5042002.json. Verified on arcscan and
    // exercised live end-to-end (createTransaction, depositPoints,
    // processMerchantPayment, both sweeps) against real testnet USDC.
    //
    // Unlike the payment rows above, this one converges `address` on re-seed
    // rather than using `update: {}`. The deployment record is the source of
    // truth and the contract is not upgrade-compatible with any earlier proxy,
    // so an env holding a stale address must be corrected, not preserved.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-arc-testnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-arc-testnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(5042002).id, // Arc Testnet
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
    }),
    // takumi_pay on Monad Testnet — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/10143.json (deployed 2026-09-16 for the
    // Monad Metropolis QRIS-spend leg). MockAUSD allowlisted as the payment
    // token with a 1000 AUSD sweep cap applied on-chain. The address is the
    // SAME as Arc testnet's: the same deployer key started from nonce 0 on
    // both chains, so it is a genuine CREATE match, not a copy-paste (the
    // deployment record documents this). Converges `address` on re-seed,
    // same as the Arc row.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-monad-testnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-monad-testnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(10143).id, // Monad Testnet
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
    }),
    // takumi_pay on Monad mainnet — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/143.json (deployed 2026-09-19). This is
    // the REAL Agora AUSD leg (mobile-app/docs/monad-metropolis-2026-spec.md
    // §2), not the MockAUSD stand-in used on Monad testnet. Same deployer key
    // as the testnet contract, already funded on mainnet, hence the address
    // collision with the Arbitrum mainnet / Arbitrum Sepolia rows above — a
    // genuine CREATE match (same nonce sequence), not a copy-paste; see the
    // deployment record's `todo.addressCollision`. Converges `address` on
    // re-seed, same as the Arc/Monad-testnet rows.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-monad-mainnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x479B0843C3e0627f36551660506dEd5b349Fa968",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-monad-mainnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(143).id, // Monad mainnet
        address: "0x479B0843C3e0627f36551660506dEd5b349Fa968",
        isActive: true,
      },
    }),
    // takumi_pay on Arc mainnet — TakumiPay 2.1.0 behind a UUPS proxy, see
    // ../contract/evm/deployments/5042.json (deployed 2026-10-01). Native USDC
    // is aliased to its 6-decimal ERC-20 view and is the only allowlisted
    // token, with a 1000 USDC sweep cap and a 24h withdrawal delay. The
    // address is the SAME as Arc testnet's / Monad testnet's: same deployer key
    // at the same nonce on a fresh chain, a genuine CREATE match. Converges
    // `address` on re-seed, same as the other takumi_pay rows.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-arc-mainnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
      create: {
        id: "smart-contract-payment-arc-mainnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: evmChain(5042).id, // Arc mainnet
        address: "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee",
        isActive: true,
      },
    }),
    // takumi_pay on Solana Devnet — Anchor program deployed via `anchor deploy`.
    // `name` is a stable machine key here, not a display label — every
    // chain's takumi_pay contract/program uses the same "takumi_pay" name so
    // BlockchainVerificationService can look it up by (blockchainId, name)
    // without per-chain-family branching. (Renamed from "TakumiPay Solana";
    // nothing else in the codebase read that string.)
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-solana-devnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "6CCTEtYrk8unNhjYQ7npiLUf1iKQQJU88JSYn8EJLNYy",
      },
      create: {
        id: "smart-contract-payment-solana-devnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: slugChain("solana-devnet").id, // Solana Devnet
        address: "6CCTEtYrk8unNhjYQ7npiLUf1iKQQJU88JSYn8EJLNYy",
        isActive: true,
      },
    }),
    // takumi_pay on Stellar Testnet — Soroban contract deployed from
    // ../contract/stellar, see
    // ../contract/stellar/deployments/testnet/v2.json.
    prisma.smartContract.upsert({
      where: { id: "smart-contract-payment-stellar-testnet" },
      update: {
        name: "takumi_pay",
        type: "payment",
        address: "CCLFTLVPHOKKDZYTMGU6UNXKFEN6VF3QVYEAJNULGIC7ZXTETAIPKKRZ",
      },
      create: {
        id: "smart-contract-payment-stellar-testnet",
        name: "takumi_pay",
        type: "payment",
        blockchainId: slugChain("stellar-testnet").id,
        address: "CCLFTLVPHOKKDZYTMGU6UNXKFEN6VF3QVYEAJNULGIC7ZXTETAIPKKRZ",
        isActive: true,
      },
    }),
    // Circle Gateway wallet/minter contracts on Arc — SmartContract, not
    // scalar Blockchain columns (see the schema comment on
    // Blockchain.metadata). The x402 EIP-712 verifying contract is the same
    // address as gateway_wallet by protocol design, so no separate
    // "x402_verifying" row is needed — buildX402() falls back to
    // gateway_wallet when x402_verifying is absent.
    // Keyed on (blockchainId, address) rather than a fixed id: the
    // 20260712053000_gateway_contracts_and_x402_metadata migration already
    // auto-created this row (with a random uuid id) from the pre-existing
    // Blockchain.gatewayWalletContract column on any cloud env seeded before
    // this script carried Circle Gateway contracts. Upserting on `id` would
    // miss that row and collide with the (blockchainId, address) unique
    // constraint trying to INSERT a duplicate.
    prisma.smartContract.upsert({
      where: {
        blockchainId_address: {
          blockchainId: evmChain(5042002).id,
          address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        },
      },
      update: { name: "gateway_wallet", type: "gateway", isActive: true },
      create: {
        id: "smart-contract-gateway-wallet-arc-testnet",
        name: "gateway_wallet",
        type: "gateway",
        blockchainId: evmChain(5042002).id,
        address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: {
        blockchainId_address: {
          blockchainId: evmChain(5042002).id,
          address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
        },
      },
      update: { name: "gateway_minter", type: "gateway", isActive: true },
      create: {
        id: "smart-contract-gateway-minter-arc-testnet",
        name: "gateway_minter",
        type: "gateway",
        blockchainId: evmChain(5042002).id,
        address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
        isActive: true,
      },
    }),
    // ─────────────────────── Aave V3 Pool (mainnet) ──────────────────────
    // Sources: aave.com/docs/aave-v3/smart-contracts/pool +
    //          @bgd-labs/aave-address-book.
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-ethereum" },
      update: {
        address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      },
      create: {
        id: "aave-v3-pool-ethereum",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(1).id, // Ethereum
        address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-data-provider-ethereum" },
      update: {},
      create: {
        id: "aave-v3-data-provider-ethereum",
        name: "aave_v3_data_provider",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-base" },
      update: {},
      create: {
        id: "aave-v3-pool-base",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(8453).id, // Base Mainnet
        address: "0xA238Dd80C259a72e81d7e4674A983a59f1ad673e",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-data-provider-base" },
      update: {},
      create: {
        id: "aave-v3-data-provider-base",
        name: "aave_v3_data_provider",
        type: "protocol",
        blockchainId: evmChain(8453).id,
        address: "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-arbitrum" },
      update: {},
      create: {
        id: "aave-v3-pool-arbitrum",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(42161).id, // Arbitrum Mainnet (index 7 — see §5 of seed block)
        address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-data-provider-arbitrum" },
      update: {},
      create: {
        id: "aave-v3-data-provider-arbitrum",
        name: "aave_v3_data_provider",
        type: "protocol",
        blockchainId: evmChain(42161).id,
        address: "0x7F23D86Ee20D869112572136221e173428DD740B",
        isActive: true,
      },
    }),
    // ─────────────── Aave V3 Pool (testnet) ────────────────────────────
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-sepolia" },
      update: {},
      create: {
        id: "aave-v3-pool-sepolia",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(11155111).id, // Ethereum Sepolia
        address: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-base-sepolia" },
      update: {},
      create: {
        id: "aave-v3-pool-base-sepolia",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(84532).id, // Base Sepolia
        address: "0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "aave-v3-pool-arbitrum-sepolia" },
      update: {},
      create: {
        id: "aave-v3-pool-arbitrum-sepolia",
        name: "aave_v3_pool",
        type: "protocol",
        blockchainId: evmChain(421614).id, // Arb Sepolia
        address: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
        isActive: true,
      },
    }),
    // ───── Sui Intent Engine — intent_receipt audit-log package (§10) ─────
    // On-chain audit-log Move package. The mobile app resolves this Package ID
    // from the API (never hardcoded) via the active `intent_receipt` row on the
    // Sui blockchain. Source: contract/sui/deployed.json (testnet publish).
    // `update` carries the address so a re-seed after a package rotation moves
    // the pointer in place (one stable row, no duplicates).
    prisma.smartContract.upsert({
      where: { id: "intent-receipt-sui-testnet" },
      // Resolve the Sui Testnet row by chainSlug — index refs drift as
      // blockchains are appended (blockchains[11] is Monad, not Sui). `update`
      // carries blockchainId/address so a re-seed corrects/rotates in place.
      update: {
        name: "intent_receipt",
        type: "protocol",
        blockchainId: blockchains.find((b) => b.chainSlug === "sui-testnet")!
          .id,
        address:
          "0x0bea3f1e47e213a95dc3d47148ace7047310e2d14dbc10dcb9eda6226a4ba301",
        isActive: true,
      },
      create: {
        id: "intent-receipt-sui-testnet",
        name: "intent_receipt",
        type: "protocol",
        blockchainId: blockchains.find((b) => b.chainSlug === "sui-testnet")!
          .id,
        address:
          "0x0bea3f1e47e213a95dc3d47148ace7047310e2d14dbc10dcb9eda6226a4ba301",
        isActive: true,
      },
    }),
    // Mainnet counterpart — same package, sui-mainnet chain.
    // Source: contract/sui/deployments/mainnet/v1.json
    prisma.smartContract.upsert({
      where: { id: "intent-receipt-sui-mainnet" },
      update: {
        name: "intent_receipt",
        type: "protocol",
        blockchainId: blockchains.find((b) => b.chainSlug === "sui-mainnet")!
          .id,
        address:
          "0x68e6de85ba7178056ca70c4900e9cb3d87838248d83334a1b8e16ffd8dcb0f03",
        isActive: true,
      },
      create: {
        id: "intent-receipt-sui-mainnet",
        name: "intent_receipt",
        type: "protocol",
        blockchainId: blockchains.find((b) => b.chainSlug === "sui-mainnet")!
          .id,
        address:
          "0x68e6de85ba7178056ca70c4900e9cb3d87838248d83334a1b8e16ffd8dcb0f03",
        isActive: true,
      },
    }),
    // ────────────────────────── Lido ───────────────────────────────────
    // Source: docs.lido.fi/contracts/lido-locator
    prisma.smartContract.upsert({
      where: { id: "lido-steth-ethereum" },
      update: {},
      create: {
        id: "lido-steth-ethereum",
        name: "lido_steth",
        type: "protocol",
        blockchainId: evmChain(1).id, // Ethereum
        address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "lido-wsteth-ethereum" },
      update: {},
      create: {
        id: "lido-wsteth-ethereum",
        name: "lido_wsteth",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "lido-withdrawal-queue-ethereum" },
      update: {},
      create: {
        id: "lido-withdrawal-queue-ethereum",
        name: "lido_withdrawal_queue",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
        isActive: true,
      },
    }),
    // ─────────────────────── Curve 3pool ───────────────────────────────
    prisma.smartContract.upsert({
      where: { id: "curve-3pool-ethereum" },
      update: {},
      create: {
        id: "curve-3pool-ethereum",
        name: "curve_3pool",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "curve-3pool-lp-ethereum" },
      update: {},
      create: {
        id: "curve-3pool-lp-ethereum",
        name: "curve_3pool_lp",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490",
        isActive: true,
      },
    }),
    // ─────────────────────── Morpho Vaults ────────────────────────────
    // Source: docs.morpho.org. The default seeded vault is Steakhouse
    // USDC (ETH). Add additional rows per curated vault as needed.
    prisma.smartContract.upsert({
      where: { id: "morpho-steakhouse-usdc-ethereum" },
      update: {},
      create: {
        id: "morpho-steakhouse-usdc-ethereum",
        name: "morpho_steakhouse_usdc",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "morpho-flagship-usdc-base" },
      update: {},
      create: {
        id: "morpho-flagship-usdc-base",
        name: "morpho_flagship_usdc",
        type: "protocol",
        blockchainId: evmChain(8453).id, // Base Mainnet
        address: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
        isActive: true,
      },
    }),
    // ─────────────────────── Yearn V3 ─────────────────────────────────
    // Source: docs.yearn.fi. yvUSDC v3 + ERC-4626 router.
    prisma.smartContract.upsert({
      where: { id: "yearn-router-ethereum" },
      update: {},
      create: {
        id: "yearn-router-ethereum",
        name: "yearn_router",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x1112dbCF805682e828606f74AB717abf4b4FD8DE",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "yearn-v3-usdc-ethereum" },
      update: {},
      create: {
        id: "yearn-v3-usdc-ethereum",
        name: "yearn_v3_usdc",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
        isActive: true,
      },
    }),
    // ───────────────────── EigenLayer ────────────────────────────────
    // Source: docs.eigencloud.xyz/eigenlayer/developers/concepts/
    //         eigenlayer-contracts/deployed-contracts
    prisma.smartContract.upsert({
      where: { id: "eigenlayer-strategy-manager-ethereum" },
      update: {},
      create: {
        id: "eigenlayer-strategy-manager-ethereum",
        name: "eigenlayer_strategy_manager",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "eigenlayer-delegation-manager-ethereum" },
      update: {},
      create: {
        id: "eigenlayer-delegation-manager-ethereum",
        name: "eigenlayer_delegation_manager",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "eigenlayer-steth-strategy-ethereum" },
      update: {},
      create: {
        id: "eigenlayer-steth-strategy-ethereum",
        name: "eigenlayer_steth_strategy",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x93c4b944D05dfe6df7645A86cd2206016c51564D",
        isActive: true,
      },
    }),
    // ───────────────────────── Ethena ────────────────────────────────
    // Source: docs.ethena.fi/solution-design/staking-usde
    prisma.smartContract.upsert({
      where: { id: "ethena-susde-ethereum" },
      update: {},
      create: {
        id: "ethena-susde-ethereum",
        name: "ethena_susde",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "ethena-usde-ethereum" },
      update: {},
      create: {
        id: "ethena-usde-ethereum",
        name: "ethena_usde",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
        isActive: true,
      },
    }),
    // ───────────────────────── GMX V2 ────────────────────────────────
    // Source: docs.gmx.io/docs/api/contracts-v2 (Arbitrum)
    prisma.smartContract.upsert({
      where: { id: "gmx-v2-exchange-router-arbitrum" },
      update: {},
      create: {
        id: "gmx-v2-exchange-router-arbitrum",
        name: "gmx_v2_exchange_router",
        type: "protocol",
        blockchainId: evmChain(42161).id, // Arbitrum Mainnet
        address: "0xb7a9C9D9D7c0e8Db8Df0DCe9eDDFc83AC0a3f74D",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "gmx-v2-deposit-vault-arbitrum" },
      update: {},
      create: {
        id: "gmx-v2-deposit-vault-arbitrum",
        name: "gmx_v2_deposit_vault",
        type: "protocol",
        blockchainId: evmChain(42161).id,
        address: "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "gmx-v2-withdrawal-vault-arbitrum" },
      update: {},
      create: {
        id: "gmx-v2-withdrawal-vault-arbitrum",
        name: "gmx_v2_withdrawal_vault",
        type: "protocol",
        blockchainId: evmChain(42161).id,
        address: "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55",
        isActive: true,
      },
    }),
    // ───────────────────── Maple syrupUSDC ───────────────────────────
    // Address resolves through chain.smartContracts in the adapter.
    // Ops should verify the canonical Maple pool address against
    // syrup.fi / maple.finance before mainnet enablement.
    prisma.smartContract.upsert({
      where: { id: "maple-syrup-usdc-ethereum" },
      update: {},
      create: {
        id: "maple-syrup-usdc-ethereum",
        name: "maple_syrup_usdc",
        type: "protocol",
        blockchainId: evmChain(1).id,
        address: "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b",
        isActive: true,
      },
    }),
    // Solana program coordinates ride as a tagged-string column on
    // Blockchain; they're recorded here as a SmartContract row keyed
    // to Solana mainnet for completeness even though SPL programs
    // don't need a per-pool registry entry. Read by SolanaJito adapter
    // via JITO constants in services/defi/constants/addresses.ts.
    prisma.smartContract.upsert({
      where: { id: "spl-stake-pool-program" },
      update: {},
      create: {
        id: "spl-stake-pool-program",
        name: "spl_stake_pool_program",
        type: "protocol",
        blockchainId: slugChain("solana-mainnet").id, // Solana mainnet
        address: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "jito-stake-pool" },
      update: {},
      create: {
        id: "jito-stake-pool",
        name: "jito_stake_pool",
        type: "protocol",
        blockchainId: slugChain("solana-mainnet").id,
        address: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
        isActive: true,
      },
    }),
    prisma.smartContract.upsert({
      where: { id: "jito-sol-mint" },
      update: {},
      create: {
        id: "jito-sol-mint",
        name: "jito_sol_mint",
        type: "protocol",
        blockchainId: slugChain("solana-mainnet").id,
        address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
        isActive: true,
      },
    }),
  ]);

  // ERC20 Stablecoin tokens
  const tokens = await Promise.all([
    // USDC on Ethereum
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(1).id,
          contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: evmChain(1).id, // Ethereum
        contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // USDT on Ethereum
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(1).id,
          contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        },
      },
      update: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        blockchainId: evmChain(1).id, // Ethereum
        contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // USDT on Ethereum Sepolia
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(11155111).id,
          contractAddress: "0xA6ffC6d992F4C6e173836035Aebb8AF3dBBB15cd",
        },
      },
      update: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        blockchainId: evmChain(11155111).id, // Ethereum Sepolia
        contractAddress: "0xA6ffC6d992F4C6e173836035Aebb8AF3dBBB15cd",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // IDRX on Base
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(84532).id,
          contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
        },
      },
      update: {
        name: "IDRX Stablecoin",
        symbol: "IDRX",
        decimals: 2,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/26732.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "IDR",
      },
      create: {
        name: "IDRX Stablecoin",
        symbol: "IDRX",
        decimals: 2,
        blockchainId: evmChain(84532).id, // Base
        contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/26732.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "IDR",
      },
    }),
    // USDC on Base Sepolia — Circle's official testnet USDC, confirmed
    // on-chain (symbol/decimals read via cast, not assumed). Allowlisted as
    // a payment token on the takumi_pay proxy above.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(84532).id,
          contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: evmChain(84532).id, // Base Sepolia
        contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // USDT on Arbitrum (mainnet) — contract `0xFd08…` is Arbitrum One USDT.
    // Previously pointed at blockchains[5] (Arbitrum Sepolia) due to index
    // drift; resolved by chainId so it always lands on Arbitrum mainnet.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(42161).id,
          contractAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        },
      },
      update: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "Tether USD",
        symbol: "USDT",
        decimals: 6,
        blockchainId: evmChain(42161).id, // Arbitrum mainnet
        contractAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/825.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // USDC on Sui mainnet — Circle-issued. CoinType is stored in
    // `contractAddress` (same column-reuse pattern Solana uses for SPL
    // mints). Mobile `SuiWalletKit.getTokenBalance` passes this string
    // verbatim to `client.getBalance({ owner, coinType })`.
    // See docs/sui-chain-support-spec.md §3.8.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: slugChain("sui-mainnet").id, // Sui mainnet
          contractAddress:
            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: slugChain("sui-mainnet").id, // Sui mainnet
        contractAddress:
          "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
  ]);

  // Native currency tokens
  await Promise.all([
    // ETH on Ethereum
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(1).id,
          contractAddress: "0x0000000000000000000000000000000000000000",
        },
      },
      update: {
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        logoUrl:
          "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(1).id, // Ethereum
        contractAddress: "0x0000000000000000000000000000000000000000",
        logoUrl:
          "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // MATIC on Polygon
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(137).id,
          contractAddress: "0x1230000000000000000000000000000000000000",
        },
      },
      update: {
        name: "Polygon",
        symbol: "MATIC",
        decimals: 18,
        logoUrl:
          "https://assets.coingecko.com/coins/images/4713/small/matic-token-icon.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Polygon",
        symbol: "MATIC",
        decimals: 18,
        blockchainId: evmChain(137).id, // Polygon
        contractAddress: "0x1230000000000000000000000000000000000000",
        logoUrl:
          "https://assets.coingecko.com/coins/images/4713/small/matic-token-icon.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Base
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(84532).id,
          contractAddress: "0x0000000000000000000000000000000000000001",
        },
      },
      update: {
        name: "Base",
        symbol: "ETH",
        decimals: 18,
        logoUrl: "https://avatars.githubusercontent.com/u/108554348?s=200&v=4",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Base",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(84532).id, // Base
        contractAddress: "0x0000000000000000000000000000000000000001",
        logoUrl: "https://avatars.githubusercontent.com/u/108554348?s=200&v=4",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // Sepolia Ether on Ethereum Sepolia
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(11155111).id,
          contractAddress: "0x0000000000000000000000000000000000000002",
        },
      },
      update: {
        name: "Sepolia Ether",
        symbol: "ETH",
        decimals: 18,
        logoUrl:
          "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Sepolia Ether",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(11155111).id, // Ethereum Sepolia
        contractAddress: "0x0000000000000000000000000000000000000002",
        logoUrl:
          "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Arbitrum Sepolia (testnet). logoUrl is the Arbitrum brand mark
    // (used as the chain icon in the mobile chain selector).
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(421614).id,
          contractAddress: "0x0000000000000000000000000000000000000004",
        },
      },
      update: {
        name: "Arbitrum Sepolia",
        symbol: "ETH",
        decimals: 18,
        logoUrl: "https://cryptologos.cc/logos/arbitrum-arb-logo.png?v=040",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Arbitrum Sepolia",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(421614).id, // Arbitrum Sepolia
        contractAddress: "0x0000000000000000000000000000000000000004",
        logoUrl: "https://cryptologos.cc/logos/arbitrum-arb-logo.png?v=040",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Robinhood Chain testnet. Without a native-currency row the chain
    // has no icon app-wide (the mobile chain icon is this row's logoUrl), so
    // like the Arbitrum rows logoUrl is the chain's own brand mark — CoinGecko's
    // `robinhood` asset-platform image — not the ETH logo.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(46630).id,
          contractAddress: "0x0000000000000000000000000000000000000004",
        },
      },
      update: {
        name: "Robinhood Testnet",
        symbol: "ETH",
        decimals: 18,
        logoUrl:
          "https://coin-images.coingecko.com/asset_platforms/images/102132299/small/robinhood.png?1782921203",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Robinhood Testnet",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(46630).id, // Robinhood Chain testnet
        contractAddress: "0x0000000000000000000000000000000000000004",
        logoUrl:
          "https://coin-images.coingecko.com/asset_platforms/images/102132299/small/robinhood.png?1782921203",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Robinhood Chain mainnet — chain icon, same convention as above.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(4663).id,
          contractAddress: "0x0000000000000000000000000000000000000004",
        },
      },
      update: {
        name: "Robinhood",
        symbol: "ETH",
        decimals: 18,
        logoUrl:
          "https://coin-images.coingecko.com/asset_platforms/images/102132299/small/robinhood.png?1782921203",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Robinhood",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(4663).id, // Robinhood Chain mainnet
        contractAddress: "0x0000000000000000000000000000000000000004",
        logoUrl:
          "https://coin-images.coingecko.com/asset_platforms/images/102132299/small/robinhood.png?1782921203",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Arbitrum (mainnet). Previously missing — the single "Arbitrum"
    // entry above had drifted onto the Sepolia row, leaving mainnet without a
    // native token (placeholder icon + "N/A" symbol app-wide).
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(42161).id,
          contractAddress: "0x0000000000000000000000000000000000000004",
        },
      },
      update: {
        name: "Arbitrum",
        symbol: "ETH",
        decimals: 18,
        logoUrl: "https://cryptologos.cc/logos/arbitrum-arb-logo.png?v=040",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Arbitrum",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(42161).id, // Arbitrum mainnet
        contractAddress: "0x0000000000000000000000000000000000000004",
        logoUrl: "https://cryptologos.cc/logos/arbitrum-arb-logo.png?v=040",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // ETH on Base Mainnet. Previously missing — Base Mainnet was appended at
    // blockchains[14] with no paired native token. logoUrl is the Base brand
    // mark (matches the Base Sepolia row, used as the chain icon).
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(8453).id,
          contractAddress: "0x0000000000000000000000000000000000000000",
        },
      },
      update: {
        name: "Base",
        symbol: "ETH",
        decimals: 18,
        logoUrl: "https://avatars.githubusercontent.com/u/108554348?s=200&v=4",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Base",
        symbol: "ETH",
        decimals: 18,
        blockchainId: evmChain(8453).id, // Base Mainnet
        contractAddress: "0x0000000000000000000000000000000000000000",
        logoUrl: "https://avatars.githubusercontent.com/u/108554348?s=200&v=4",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // SOL on Solana mainnet — identified by the canonical Wrapped SOL mint
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: slugChain("solana-mainnet").id,
          contractAddress: "So11111111111111111111111111111111111111112",
        },
      },
      update: {
        name: "Solana",
        symbol: "SOL",
        decimals: 9,
        logoUrl:
          "https://assets.coingecko.com/coins/images/4128/small/solana.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Solana",
        symbol: "SOL",
        decimals: 9,
        blockchainId: slugChain("solana-mainnet").id, // Solana mainnet
        contractAddress: "So11111111111111111111111111111111111111112",
        logoUrl:
          "https://assets.coingecko.com/coins/images/4128/small/solana.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // SOL on Solana Devnet — same canonical Wrapped SOL mint across clusters
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: slugChain("solana-devnet").id,
          contractAddress: "So11111111111111111111111111111111111111112",
        },
      },
      update: {
        name: "Solana Devnet",
        symbol: "SOL",
        decimals: 9,
        logoUrl:
          "https://assets.coingecko.com/coins/images/4128/small/solana.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
      create: {
        name: "Solana Devnet",
        symbol: "SOL",
        decimals: 9,
        blockchainId: slugChain("solana-devnet").id, // Solana Devnet
        contractAddress: "So11111111111111111111111111111111111111112",
        logoUrl:
          "https://assets.coingecko.com/coins/images/4128/small/solana.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    }),
    // Mock USDC on Solana Devnet — deployed via devnet-setup.ts for merchant payment testing
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: slugChain("solana-devnet").id,
          contractAddress: "4qFejVSp46Q4SZCGDrXbkFJC1qw5uo1JBnbXLnKZurey",
        },
      },
      update: {
        name: "USD Coin (Devnet)",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        isPaymentEnabled: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin (Devnet)",
        symbol: "USDC",
        decimals: 6,
        blockchainId: slugChain("solana-devnet").id, // Solana Devnet
        contractAddress: "4qFejVSp46Q4SZCGDrXbkFJC1qw5uo1JBnbXLnKZurey",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isActive: true,
        isPaymentEnabled: true,
        peggedCurrency: "USD",
      },
    }),
    // USDC-SPL on Solana Mainnet — canonical Circle USDC mint
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: slugChain("solana-mainnet").id,
          contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: slugChain("solana-mainnet").id, // Solana Mainnet
        contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        logoUrl:
          "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
        isStablecoin: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // USDC on Arc Testnet — spec §7, task 26. On Arc the native coin and
    // this ERC-20 are two views of ONE balance: 18 decimals via
    // eth_getBalance, 6 decimals via balanceOf. Verified live on the proxy,
    // which holds 1900000 and 1.9e18 simultaneously — the same $1.90 twice.
    //
    // This row is keyed by `contractAddress`, so it describes the ERC-20
    // view and `decimals` MUST be that contract's own: decimals() at
    // 0x3600…0000 returns 6. It previously said 18, which is the native
    // view's scale — reading a balanceOf result at 18dp under-reports by
    // 1e12. 6 is also the scale everything else already speaks: intent
    // amounts are USDC micros, `pay-merchant.tsx` hardcodes
    // USDC_DECIMALS = 6, and the Stellar quote builder scales by
    // 10^(tokenRow.decimals - 6), so an EVM builder mirroring it would
    // inflate every Arc amount by 1e12.
    //
    // `isNativeCurrency` is FALSE here, and that is the whole trick. Arc's
    // native view gets its own row below (`contractAddress: null`, 18
    // decimals), exactly like every other chain models native separately
    // from its ERC-20s. One row cannot carry both scales, and nothing in the
    // app needs it to: consumers already pick the row that matches the view
    // they are in — `buildChainConfigFromBlockchain` takes the native-flagged
    // row for gas, `getTokenBalance` takes this one for balanceOf.
    //
    // This is the row merchant payments must use, hence `isPaymentEnabled`.
    // The contract rejects address(0) on Arc (`NativeDisabledOnAliasChain`),
    // so a quote built from the native row would be unpayable.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042002).id, // Arc Testnet
          contractAddress: "0x3600000000000000000000000000000000000000",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: evmChain(5042002).id, // Arc Testnet
        contractAddress: "0x3600000000000000000000000000000000000000",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042).id, // Arc Mainnet
          contractAddress: "0x3600000000000000000000000000000000000000",
        },
      },
      update: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: true,
        isActive: true,
        peggedCurrency: "USD",
      },
      create: {
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        blockchainId: evmChain(5042).id, // Arc Mainnet
        contractAddress: "0x3600000000000000000000000000000000000000",
        logoUrl:
          "https://static.alchemyapi.io/images/assets/3408.png",
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    }),
    // EURC on Arc (Circle-issued; matches App Kit's pin). The catalogue row is
    // what vouches for the exact address (swap spec §8.4 L1) and keeps it in
    // the Tower co-marketing lane. Verified on-chain 2026-10-01: EURC, 6 dec.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042).id, // Arc Mainnet
          contractAddress: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
        },
      },
      update: {
        name: "EURC",
        symbol: "EURC",
        decimals: 6,
        logoUrl: "https://static.alchemyapi.io/images/assets/20641.png",
        isStablecoin: true,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: "EUR",
      },
      create: {
        blockchainId: evmChain(5042).id, // Arc Mainnet
        contractAddress: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
        name: "EURC",
        symbol: "EURC",
        decimals: 6,
        logoUrl: "https://static.alchemyapi.io/images/assets/20641.png",
        isStablecoin: true,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: "EUR",
      },
    }),
    // cirBTC on Arc (Circle-issued; App Kit pins it internally but does not
    // export it, so this row is our only vouch for the address). Verified
    // on-chain 2026-10-01: "Circle Wrapped Bitcoin", cirBTC, 8 dec. Alchemy has
    // no cirBTC image, so this is the Bitcoin logo LI.FI serves for it (Trust
    // Wallet's): an icon is the asset's face, not the deployment's.
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042).id, // Arc Mainnet
          contractAddress: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
        },
      },
      update: {
        name: "Circle Wrapped Bitcoin",
        symbol: "cirBTC",
        decimals: 8,
        logoUrl:
          "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
        isStablecoin: false,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: null,
      },
      create: {
        blockchainId: evmChain(5042).id, // Arc Mainnet
        contractAddress: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
        name: "Circle Wrapped Bitcoin",
        symbol: "cirBTC",
        decimals: 8,
        logoUrl:
          "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
        isStablecoin: false,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: null,
      },
    }),
    // EURC and cirBTC on Arc TESTNET: the same vouch the mainnet rows give,
    // so the Add funds picker and the agent offer them there too (LI.FI
    // lists only USDC/EURC on 5042002 and does not know cirBTC at all).
    // Addresses are Circle's own pins (App Kit's chain defs for EURC, its
    // built-in token registry for cirBTC), verified on-chain 2026-10-09:
    // EURC "EURC" 6 dec; cirBTC "Circle Wrapped Bitcoin" 8 dec. Tower quotes
    // USDC -> cirBTC on 5042002 (live-checked the same day).
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042002).id, // Arc Testnet
          contractAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
        },
      },
      update: {
        name: "EURC",
        symbol: "EURC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/20641.png",
        isStablecoin: true,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: "EUR",
      },
      create: {
        blockchainId: evmChain(5042002).id, // Arc Testnet
        contractAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
        name: "EURC",
        symbol: "EURC",
        decimals: 6,
        logoUrl:
          "https://static.alchemyapi.io/images/assets/20641.png",
        isStablecoin: true,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: "EUR",
      },
    }),
    prisma.token.upsert({
      where: {
        blockchainId_contractAddress: {
          blockchainId: evmChain(5042002).id, // Arc Testnet
          contractAddress: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
        },
      },
      update: {
        name: "Circle Wrapped Bitcoin",
        symbol: "cirBTC",
        decimals: 8,
        logoUrl:
          "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
        isStablecoin: false,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: null,
      },
      create: {
        blockchainId: evmChain(5042002).id, // Arc Testnet
        contractAddress: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
        name: "Circle Wrapped Bitcoin",
        symbol: "cirBTC",
        decimals: 8,
        logoUrl:
          "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
        isStablecoin: false,
        isNativeCurrency: false,
        // Swappable and vouched-for, NOT cleared for payment flows.
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: null,
      },
    }),
  ]);

  // Native USDC on Arc — the second view of the SAME balance the ERC-20 row
  // above describes. On Arc the gas coin is USDC itself: `eth_getBalance`
  // returns 18-decimal wei, `balanceOf(0x3600…)` returns 6-decimal micros,
  // and both name one pot of money (verified live on the proxy: 1.9e18 and
  // 1900000 held at the same instant).
  //
  // Two rows, not one. That is not a workaround — it is the shape every other
  // chain already uses (a native row plus its ERC-20 rows); Arc is merely the
  // first where both happen to describe the same asset. It keeps `decimals`
  // honest per view, so no consumer needs an Arc special case: mobile's
  // `buildChainConfigFromBlockchain` picks the native-flagged row for gas
  // precision and gets 18, while `getTokenBalance` uses the ERC-20 row and
  // gets 6.
  //
  // `isPaymentEnabled` is deliberately false: merchant payments must go via
  // the ERC-20 row, because the contract refuses address(0) on this chain
  // (`NativeDisabledOnAliasChain`).
  //
  // Find-then-write rather than a compound upsert, for the same reason MON
  // below uses it — Postgres treats each NULL `contractAddress` as distinct,
  // so the (blockchainId, contractAddress) unique cannot match this row.
  const existingArcNativeToken = await prisma.token.findFirst({
    where: {
      blockchainId: evmChain(5042002).id,
      isNativeCurrency: true,
    },
  });
  const arcNativeUsdc = {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 18,
    logoUrl:
      "https://pbs.twimg.com/profile_images/1955238194443849732/sHyVRItm_400x400.jpg",
    isStablecoin: true,
    isNativeCurrency: true,
    isPaymentEnabled: false,
    isActive: true,
    peggedCurrency: "USD",
  };
  if (existingArcNativeToken) {
    await prisma.token.update({
      where: { id: existingArcNativeToken.id },
      data: arcNativeUsdc,
    });
  } else {
    await prisma.token.create({
      data: {
        ...arcNativeUsdc,
        blockchainId: evmChain(5042002).id, // Arc Testnet
        contractAddress: null,
      },
    });
  }

  // Native USDC on Arc Mainnet (5042)
  const existingArcMainnetNativeToken = await prisma.token.findFirst({
    where: {
      blockchainId: evmChain(5042).id,
      isNativeCurrency: true,
    },
  });
  if (existingArcMainnetNativeToken) {
    await prisma.token.update({
      where: { id: existingArcMainnetNativeToken.id },
      data: arcNativeUsdc,
    });
  } else {
    await prisma.token.create({
      data: {
        ...arcNativeUsdc,
        blockchainId: evmChain(5042).id, // Arc Mainnet
        contractAddress: null,
      },
    });
  }

  // MON on Monad — native currency, no contract address (mirrors staging).
  // The compound-unique upsert path can't be used here because Postgres
  // allows multiple null contractAddress rows per blockchain, so we identify
  // the row by (blockchainId, isNativeCurrency) instead. Idempotent on re-seed.
  const existingMonToken = await prisma.token.findFirst({
    where: {
      blockchainId: evmChain(143).id,
      isNativeCurrency: true,
    },
  });
  if (existingMonToken) {
    await prisma.token.update({
      where: { id: existingMonToken.id },
      data: {
        name: "Monad",
        symbol: "MON",
        decimals: 18,
        logoUrl: "https://files.svgcdn.io/token-branded/monad.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    });
  } else {
    await prisma.token.create({
      data: {
        name: "Monad",
        symbol: "MON",
        decimals: 18,
        blockchainId: evmChain(143).id, // Monad
        contractAddress: null,
        logoUrl: "https://files.svgcdn.io/token-branded/monad.png",
        isStablecoin: false,
        isNativeCurrency: true,
        isActive: true,
      },
    });
  }

  // AUSD (Agora) on Monad mainnet — Monad Metropolis 2026 remittance leg
  // (mobile-app/docs/monad-metropolis-2026-spec.md §2). Address from Agora's
  // contract-deployments doc; decimals / symbol / name NOT taken from docs
  // (Agora never states decimals) but read on-chain via eth_call 2026-09-14:
  // decimals()=6, symbol()="AUSD", name()="AUSD", non-empty eth_getCode.
  // Logo URL verified live (HTTP 200, image/svg+xml); the app's token
  // logo component renders SVG and raster alike. This one row is what
  // makes AUSD appear in get_wallet_assets, the send-screen token picker and
  // the agent's send_token tool — no other backend change needed.
  //
  // `isPaymentEnabled: true` — flipped 2026-09-19 once takumi_pay was
  // actually deployed to Monad mainnet (deployments/143.json,
  // smart-contract-payment-monad-mainnet above) and AUSD was allowlisted +
  // sweep-capped on-chain (postDeployConfig in that record). This flag plus
  // the SmartContract row are the only server-side gates for point deposits.
  await prisma.token.upsert({
    where: {
      blockchainId_contractAddress: {
        blockchainId: evmChain(143).id,
        contractAddress: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
      },
    },
    update: {
      name: "AUSD",
      symbol: "AUSD",
      decimals: 6,
      logoUrl: "https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg",
      isStablecoin: true,
      isNativeCurrency: false,
      isPaymentEnabled: true,
      isActive: true,
      peggedCurrency: "USD",
    },
    create: {
      name: "AUSD",
      symbol: "AUSD",
      decimals: 6,
      blockchainId: evmChain(143).id, // Monad
      contractAddress: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
      logoUrl: "https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg",
      isStablecoin: true,
      isNativeCurrency: false,
      isPaymentEnabled: true,
      isActive: true,
      peggedCurrency: "USD",
    },
  });

  // MON on Monad Testnet — native currency, same (blockchainId,
  // isNativeCurrency) identification as mainnet MON above.
  const existingMonTestnetToken = await prisma.token.findFirst({
    where: {
      blockchainId: evmChain(10143).id,
      isNativeCurrency: true,
    },
  });
  const monTestnetData = {
    name: "Monad",
    symbol: "MON",
    decimals: 18,
    logoUrl: "https://files.svgcdn.io/token-branded/monad.png",
    isStablecoin: false,
    isNativeCurrency: true,
    isActive: true,
  };
  if (existingMonTestnetToken) {
    await prisma.token.update({
      where: { id: existingMonTestnetToken.id },
      data: monTestnetData,
    });
  } else {
    await prisma.token.create({
      data: {
        ...monTestnetData,
        blockchainId: evmChain(10143).id, // Monad Testnet
        contractAddress: null,
      },
    });
  }

  // AUSD stand-in on Monad Testnet — OUR OWN open-mint 6-decimal ERC-20
  // (../contract/evm/src/MockAUSD.sol, deployments/10143.json), NOT Agora's
  // testnet AUSD. Agora's testnet token (0xa9012a…22dC) has a permissioned
  // mint and no faucet (verified on-chain 2026-09-16, spec §6.6 step 2), so
  // it cannot fund a demo wallet. The QRIS rail is token-agnostic; the real
  // AUSD is exercised on mainnet. If Agora hands out testnet AUSD, swap this
  // address — zero code change. decimals()=6 read back via cast post-deploy.
  //
  // `isPaymentEnabled` — this is the row merchant (QRIS) payments on Monad
  // testnet must use, same posture as Arc testnet's USDC ERC-20 row: the
  // token is allowlisted on the `takumi_pay` contract with a sweep cap set,
  // so a quote built from it is payable. The mainnet AUSD row above stays
  // payment-disabled on purpose (FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET /
  // backend-signer rotation, spec §6.6).
  await prisma.token.upsert({
    where: {
      blockchainId_contractAddress: {
        blockchainId: evmChain(10143).id,
        contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
      },
    },
    update: {
      name: "AUSD",
      symbol: "AUSD",
      decimals: 6,
      logoUrl: "https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg",
      isStablecoin: true,
      isNativeCurrency: false,
      isPaymentEnabled: true,
      isActive: true,
      peggedCurrency: "USD",
    },
    create: {
      name: "AUSD",
      symbol: "AUSD",
      decimals: 6,
      blockchainId: evmChain(10143).id, // Monad Testnet
      contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
      logoUrl: "https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg",
      isStablecoin: true,
      isNativeCurrency: false,
      isPaymentEnabled: true,
      isActive: true,
      peggedCurrency: "USD",
    },
  });

  // USDG (Paxos Global Dollar) and USDC for the Arbitrum Open House 2026
  // hackathon. Addresses from docs.paxos.com/guides/stablecoin/usdg/{mainnet,
  // testnet} and Circle; symbol()/decimals() read on-chain (6 for all).
  // USDG logo is CoinGecko's `global-dollar` image (same token on every chain).
  // `isPaymentEnabled: true` because each token is allowlisted + sweep-capped
  // on the matching takumi_pay deployment (deployments/42161, 421614, 46630).
  for (const [chainId, name, symbol, contractAddress, logoUrl] of [
    [42161, "Global Dollar", "USDG", "0x004B506865409877C9fA29bfb1ebA929984B9bbC", "https://coin-images.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111"],
    [42161, "USD Coin", "USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "https://static.alchemyapi.io/images/assets/3408.png"],
    [421614, "Global Dollar", "USDG", "0xFFC95faa3d63Cde504a05B567C600B78C0b41892", "https://coin-images.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111"],
    [46630, "Global Dollar", "USDG", "0x7E955252E15c84f5768B83c41a71F9eba181802F", "https://coin-images.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111"],
  ] as const) {
    const blockchainId = evmChain(chainId).id;
    await prisma.token.upsert({
      where: { blockchainId_contractAddress: { blockchainId, contractAddress } },
      update: { isPaymentEnabled: true, isActive: true, isStablecoin: true, logoUrl },
      create: {
        name,
        symbol,
        decimals: 6,
        blockchainId,
        contractAddress,
        logoUrl,
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: true,
        isActive: true,
        peggedCurrency: "USD",
      },
    });
  }

  // USDG on Robinhood Chain mainnet. Address from CoinGecko's `global-dollar`
  // `robinhood` platform entry; symbol() "USDG" and decimals() 6 read on-chain
  // 2026-10-01. Not payment-enabled: takumi_pay is not deployed on chain 4663.
  {
    const blockchainId = evmChain(4663).id;
    const contractAddress = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    const logoUrl =
      "https://coin-images.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111";
    await prisma.token.upsert({
      where: { blockchainId_contractAddress: { blockchainId, contractAddress } },
      update: { isActive: true, isStablecoin: true, logoUrl },
      create: {
        name: "Global Dollar",
        symbol: "USDG",
        decimals: 6,
        blockchainId,
        contractAddress,
        logoUrl,
        isStablecoin: true,
        isNativeCurrency: false,
        isPaymentEnabled: false,
        isActive: true,
        peggedCurrency: "USD",
      },
    });
  }

  // BNB on BSC / AVAX on Avalanche — native currencies, no contract address.
  // Same (blockchainId, isNativeCurrency) identification as MON on Monad
  // above, for the same reason (Postgres allows multiple null-contractAddress
  // rows per blockchain, so the compound-unique upsert path can't target
  // this row). logoUrl/symbol/decimals verified against CoinGecko's own API
  // (`/coins/binancecoin`, `/coins/avalanche-2`) 2026-08-22, not guessed.
  for (const [chainId, name, symbol, logoUrl] of [
    [
      56,
      "BNB",
      "BNB",
      "https://coin-images.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
    ],
    [
      43114,
      "Avalanche",
      "AVAX",
      "https://coin-images.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png",
    ],
  ] as const) {
    const nativeBlockchainId = evmChain(chainId).id;
    const existingNative = await prisma.token.findFirst({
      where: { blockchainId: nativeBlockchainId, isNativeCurrency: true },
    });
    const data = {
      name,
      symbol,
      decimals: 18,
      logoUrl,
      isStablecoin: false,
      isNativeCurrency: true,
      isActive: true,
    };
    if (existingNative) {
      await prisma.token.update({ where: { id: existingNative.id }, data });
    } else {
      await prisma.token.create({
        data: { ...data, blockchainId: nativeBlockchainId, contractAddress: null },
      });
    }
  }

  // SUI native currency rows — `0x2::sui::SUI` is the canonical CoinType.
  // Mirrors how Solana stores Wrapped SOL (`So11…112`) on the native row:
  // mobile `SuiWalletKit.getTokenBalance` can pass this string verbatim.
  // Decimals: 9 (1 SUI = 10⁹ MIST). One row per network.
  for (const [slug, label] of [
    ["sui-mainnet", "Sui"],
    ["sui-testnet", "Sui Testnet"],
  ] as const) {
    const suiChainId = slugChain(slug).id;
    const existing = await prisma.token.findFirst({
      where: {
        blockchainId: suiChainId,
        isNativeCurrency: true,
      },
    });
    if (existing) {
      await prisma.token.update({
        where: { id: existing.id },
        data: {
          name: label,
          symbol: "SUI",
          decimals: 9,
          logoUrl: "https://cryptologos.cc/logos/sui-sui-logo.png",
          isStablecoin: false,
          isNativeCurrency: true,
          isActive: true,
        },
      });
    } else {
      await prisma.token.create({
        data: {
          name: label,
          symbol: "SUI",
          decimals: 9,
          blockchainId: suiChainId,
          contractAddress: "0x2::sui::SUI",
          logoUrl: "https://cryptologos.cc/logos/sui-sui-logo.png",
          isStablecoin: false,
          isNativeCurrency: true,
          isActive: true,
        },
      });
    }
  }

  // Stellar native currency (XLM) rows — no compound CODE:ISSUER for the
  // native asset (Asset.native() has no issuer), so `contractAddress` is
  // null here, same convention Monad's native row uses above. Decimals:
  // 7 (1 XLM = 10^7 stroops — see docs/stellar-chain-support-spec.md §3.8;
  // NOT 18/9/6 like EVM/Sui/USDC-elsewhere — this is the single easiest
  // transcription bug to make when copy-pasting a native-token seed row).
  // One row per network.
  for (const [slug, label] of [
    ["stellar-mainnet", "Stellar Lumens"],
    ["stellar-testnet", "Stellar Lumens (Testnet)"],
  ] as const) {
    const stellarChainId = slugChain(slug).id;
    const existing = await prisma.token.findFirst({
      where: {
        blockchainId: stellarChainId,
        isNativeCurrency: true,
      },
    });
    if (existing) {
      await prisma.token.update({
        where: { id: existing.id },
        data: {
          name: label,
          symbol: "XLM",
          decimals: 7,
          logoUrl: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
          isStablecoin: false,
          isNativeCurrency: true,
          isActive: true,
        },
      });
    } else {
      await prisma.token.create({
        data: {
          name: label,
          symbol: "XLM",
          decimals: 7,
          blockchainId: stellarChainId,
          contractAddress: null,
          logoUrl: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
          isStablecoin: false,
          isNativeCurrency: true,
          isActive: true,
        },
      });
    }
  }

  // Stellar USDC rows — `contractAddress` is the compound
  // `"{CODE}:{ISSUER}"` string (docs/stellar-chain-support-spec.md §3.7),
  // reusing the existing `contractAddress` column exactly like Solana
  // (mint address) and Sui (CoinType) already do. Decimals: 7 — every
  // Stellar asset uses the ledger's 7-decimal fixed point, NOT the 6
  // decimals USDC uses on EVM/Solana/Sui. Issuer addresses verified
  // against Circle's own USDC-on-Stellar docs, cross-checked against
  // stellar.expert / stellarchain.io (spec §3.7) — re-verify against
  // Circle's live docs at deploy time regardless, since issuer
  // addresses can rotate.
  for (const [slug, label, issuer, isPaymentEnabled] of [
    [
      "stellar-mainnet",
      "USD Coin",
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      // No mainnet takumi_pay deployment yet (see the Blockchain seed
      // comment above) — not payment-enabled until that lands.
      false,
    ],
    [
      "stellar-testnet",
      "USD Coin (Testnet)",
      // Self-issued demo asset (../contract/stellar/deployments/testnet/usdc-test-asset.json),
      // NOT Circle's official testnet USDC — that issuer's faucet is outside our
      // control, so takumi_pay's demo flow mints unlimited balances from this one instead.
      "GB427BU6PWBPJYNIN4RXN4432VBSZPHYYJXGOFOVYR63BUMXLM6P2RPV",
      // Live takumi_pay v2 deployment on Stellar testnet
      // (deployments/testnet/v2.json) enforces an on-chain AllowedPaymentToken
      // allowlist across create_transaction, process_merchant_payment, AND
      // deposit_points — this SAC is registered via add_allowed_payment_token
      // (see deployments/testnet/usdc-test-asset.json). Payment eligibility is
      // still gated here too via isPaymentEnabled.
      true,
    ],
  ] as const) {
    const stellarChainId = slugChain(slug).id;
    const contractAddress = `USDC:${issuer}`;
    const existing = await prisma.token.findFirst({
      where: {
        blockchainId: stellarChainId,
        contractAddress,
      },
    });
    if (existing) {
      await prisma.token.update({
        where: { id: existing.id },
        data: {
          name: label,
          symbol: "USDC",
          decimals: 7,
          logoUrl: "https://static.alchemyapi.io/images/assets/3408.png",
          isStablecoin: true,
          isNativeCurrency: false,
          isActive: true,
          isPaymentEnabled,
          peggedCurrency: "USD",
        },
      });
    } else {
      await prisma.token.create({
        data: {
          name: label,
          symbol: "USDC",
          decimals: 7,
          blockchainId: stellarChainId,
          contractAddress,
          logoUrl: "https://static.alchemyapi.io/images/assets/3408.png",
          isStablecoin: true,
          isNativeCurrency: false,
          isActive: true,
          isPaymentEnabled,
          peggedCurrency: "USD",
        },
      });
    }
  }

  // ────────────────── Aave V3 testnet tokens ────────────────────────────
  // For each Aave testnet deployment we have a Pool entry seeded above,
  // discover the underlying reserves + aToken addresses on-chain via the
  // PoolDataProvider. Surfaces USDC + aUSDC rows in the wallet asset
  // explorer without hand-typing any testnet token coordinates.
  //
  // Failure mode: if the testnet RPC is unreachable, we log and skip —
  // the seed must not block on a flaky public faucet. Re-running the
  // seed once RPC is back will fill the missing rows (upsert is
  // idempotent).
  for (const deployment of AAVE_TESTNETS) {
    const blockchain = await prisma.blockchain.findUnique({
      where: { chainId: deployment.chainId },
      include: {
        SmartContract: { where: { name: "aave_v3_pool", isActive: true } },
      },
    });
    if (!blockchain) {
      console.warn(
        `[aave-tokens] skipping ${deployment.chainName}: Blockchain row missing — seed it before this block`,
      );
      continue;
    }
    const poolEntry = blockchain.SmartContract[0];
    if (!poolEntry) {
      console.warn(
        `[aave-tokens] skipping ${deployment.chainName}: no aave_v3_pool SmartContract row — seed it before this block`,
      );
      continue;
    }
    const poolAddress = poolEntry.address as Address;

    const client = createPublicClient({
      transport: http(blockchain.rpcUrl),
    }) as unknown as PublicClient;

    // Resolve the data provider on-chain so we never hand-type a testnet
    // address. Pool → PoolAddressesProvider → PoolDataProvider.
    let dataProvider: Address;
    try {
      const addressesProvider = (await readContract(client, {
        address: poolAddress,
        abi: POOL_ABI,
        functionName: "ADDRESSES_PROVIDER",
      })) as Address;
      dataProvider = (await readContract(client, {
        address: addressesProvider,
        abi: POOL_ADDRESSES_PROVIDER_ABI,
        functionName: "getPoolDataProvider",
      })) as Address;
    } catch (err) {
      console.warn(
        `[aave-tokens] ${deployment.chainName}: data provider resolution failed — ${(err as Error).message}. Skipping.`,
      );
      continue;
    }

    let reserves: readonly { symbol: string; tokenAddress: Address }[] = [];
    try {
      reserves = (await readContract(client, {
        address: dataProvider,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getAllReservesTokens",
      })) as readonly { symbol: string; tokenAddress: Address }[];
    } catch (err) {
      console.warn(
        `[aave-tokens] ${deployment.chainName}: getAllReservesTokens failed — ${(err as Error).message}. Skipping.`,
      );
      continue;
    }

    for (const reserve of reserves) {
      if (!deployment.symbolAllowlist.includes(reserve.symbol)) continue;

      let aToken: Hex = "0x0000000000000000000000000000000000000000";
      try {
        const [aTokenAddress] = (await readContract(client, {
          address: dataProvider,
          abi: AAVE_DATA_PROVIDER_ABI,
          functionName: "getReserveTokensAddresses",
          args: [reserve.tokenAddress],
        })) as readonly [Hex, Hex, Hex];
        aToken = aTokenAddress;
      } catch (err) {
        console.warn(
          `[aave-tokens] ${deployment.chainName}: getReserveTokensAddresses(${reserve.symbol}) failed — ${(err as Error).message}`,
        );
        continue;
      }

      let underlyingDecimals = 6;
      try {
        underlyingDecimals = await readContract(client, {
          address: reserve.tokenAddress,
          abi: erc20Abi,
          functionName: "decimals",
        });
      } catch {
        // Fallback to 6 (USDC standard).
      }

      // Underlying ERC-20 (e.g. testnet USDC). Asset explorer reads this
      // by `(blockchainId, contractAddress)` so the agent's USDC → contract
      // resolution works without any per-chain hardcode in mobile.
      await prisma.token.upsert({
        where: {
          blockchainId_contractAddress: {
            blockchainId: blockchain.id,
            contractAddress: reserve.tokenAddress.toLowerCase(),
          },
        },
        update: {
          name: `${reserve.symbol} (${deployment.chainName})`,
          symbol: reserve.symbol,
          decimals: underlyingDecimals,
          logoUrl:
            reserve.symbol === "USDC"
              ? "https://static.alchemyapi.io/images/assets/3408.png"
              : reserve.symbol === "USDT"
                ? "https://static.alchemyapi.io/images/assets/825.png"
                : null,
          isStablecoin: reserve.symbol === "USDC" || reserve.symbol === "USDT",
          isActive: true,
          peggedCurrency: reserve.symbol === "USDC" ? "USD" : null,
        },
        create: {
          name: `${reserve.symbol} (${deployment.chainName})`,
          symbol: reserve.symbol,
          decimals: underlyingDecimals,
          blockchainId: blockchain.id,
          contractAddress: reserve.tokenAddress.toLowerCase(),
          logoUrl:
            reserve.symbol === "USDC"
              ? "https://static.alchemyapi.io/images/assets/3408.png"
              : reserve.symbol === "USDT"
                ? "https://static.alchemyapi.io/images/assets/825.png"
                : null,
          isStablecoin: reserve.symbol === "USDC" || reserve.symbol === "USDT",
          isActive: true,
          peggedCurrency: reserve.symbol === "USDC" ? "USD" : null,
        },
      });

      // aToken receipt (e.g. aUSDC). Optional for the deposit flow itself,
      // surfaced here so the user can see their interest-bearing balance
      // in the wallet asset explorer alongside the underlying.
      if (aToken && aToken !== "0x0000000000000000000000000000000000000000") {
        await prisma.token.upsert({
          where: {
            blockchainId_contractAddress: {
              blockchainId: blockchain.id,
              contractAddress: aToken.toLowerCase(),
            },
          },
          update: {
            name: `Aave V3 ${reserve.symbol} (${deployment.chainName})`,
            symbol: `a${reserve.symbol}`,
            decimals: underlyingDecimals,
            logoUrl:
              "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xBcca60bB61934080951369a648Fb03DF4F96263C/logo.png",
            isStablecoin:
              reserve.symbol === "USDC" || reserve.symbol === "USDT",
            isActive: true,
            peggedCurrency: reserve.symbol === "USDC" ? "USD" : null,
          },
          create: {
            name: `Aave V3 ${reserve.symbol} (${deployment.chainName})`,
            symbol: `a${reserve.symbol}`,
            decimals: underlyingDecimals,
            blockchainId: blockchain.id,
            contractAddress: aToken.toLowerCase(),
            logoUrl:
              "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xBcca60bB61934080951369a648Fb03DF4F96263C/logo.png",
            isStablecoin:
              reserve.symbol === "USDC" || reserve.symbol === "USDT",
            isActive: true,
            peggedCurrency: reserve.symbol === "USDC" ? "USD" : null,
          },
        });
      }

      console.log(
        `[aave-tokens] ${deployment.chainName}: seeded ${reserve.symbol} (${reserve.tokenAddress}) and a${reserve.symbol} (${aToken})`,
      );

      // ── Live OpportunityCache row ────────────────────────────────────
      // DeFiLlama doesn't index testnet pools, so the production scoring
      // worker leaves testnet wallets with an empty list. We populate
      // OpportunityCache here from live on-chain reads so the same code
      // path that serves mainnet opportunities also surfaces testnet
      // ones. APY + TVL are real; `apyStddev30d` and `tvl7dDelta` stay 0
      // because we have no history on testnet — these are honest empty
      // values, not synthetic stubs.
      const slug = TESTNET_SLUG_BY_CHAIN[deployment.chainId];
      if (!slug) continue;

      let apy = 0;
      try {
        const reserveData = (await readContract(client, {
          address: poolAddress,
          abi: POOL_ABI,
          functionName: "getReserveData",
          args: [reserve.tokenAddress],
        })) as { currentLiquidityRate: bigint };
        apy = rayApyFromLiquidityRate(reserveData.currentLiquidityRate);
      } catch (err) {
        console.warn(
          `[aave-tokens] ${deployment.chainName}: getReserveData(${reserve.symbol}) failed — ${(err as Error).message}`,
        );
      }

      let tvlUnderlying = 0;
      try {
        const totalSupply = (await readContract(client, {
          address: aToken,
          abi: ERC20_TOTAL_SUPPLY_ABI,
          functionName: "totalSupply",
        })) as bigint;
        tvlUnderlying = Number(totalSupply) / 10 ** underlyingDecimals;
      } catch (err) {
        console.warn(
          `[aave-tokens] ${deployment.chainName}: aToken.totalSupply(${reserve.symbol}) failed — ${(err as Error).message}`,
        );
      }

      const poolId = `aave-v3-${deployment.chainId}-${reserve.tokenAddress.toLowerCase()}`;
      const assetContract = reserve.tokenAddress.toLowerCase();
      await prisma.opportunityCache.upsert({
        where: { poolId },
        update: {
          protocolSlug: slug,
          chainId: deployment.chainId,
          namespace: "eip155",
          assetSymbol: reserve.symbol,
          assetContract,
          apy,
          apy7dAvg: apy,
          apyStddev30d: 0,
          tvlUsd: tvlUnderlying, // USDC ≈ $1, underlying units == USD on testnet
          tvl7dDelta: 0,
          ilExposure: false,
          score: 90, // Aave V3 = Conservative tier per spec §8
          tier: "conservative",
          raw: {
            source: "on-chain",
            pool: poolAddress,
            asset: reserve.tokenAddress,
            aToken,
            apyDecimal: apy,
          },
          scoredAt: new Date(),
        },
        create: {
          poolId,
          protocolSlug: slug,
          chainId: deployment.chainId,
          namespace: "eip155",
          assetSymbol: reserve.symbol,
          assetContract,
          apy,
          apy7dAvg: apy,
          apyStddev30d: 0,
          tvlUsd: tvlUnderlying,
          tvl7dDelta: 0,
          ilExposure: false,
          score: 90,
          tier: "conservative",
          raw: {
            source: "on-chain",
            pool: poolAddress,
            asset: reserve.tokenAddress,
            aToken,
            apyDecimal: apy,
          },
          scoredAt: new Date(),
        },
      });
      console.log(
        `[aave-opportunities] ${deployment.chainName}: ${slug} ${reserve.symbol} APY=${(apy * 100).toFixed(2)}% TVL=${tvlUnderlying.toFixed(2)}`,
      );
    }
  }

  const exchangeSource = await prisma.exchangeSource.upsert({
    where: { name: "CoinGecko" },
    update: {},
    create: {
      name: "CoinGecko",
      description: "CoinGecko API for crypto prices",
      apiEndpoint: "https://api.coingecko.com/api/v3",
      updateInterval: 3600,
      priority: 1,
      isActive: true,
      lastUpdated: new Date(),
    },
  });

  const seedExchangeRates: Array<{
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    region: string;
    markup: number;
  }> = [
    {
      fromCurrency: "USDT",
      toCurrency: "IDR",
      rate: 15700,
      region: "ID",
      markup: 1.5,
    },
    {
      fromCurrency: "USDC",
      toCurrency: "SGD",
      rate: 1.35,
      region: "SG",
      markup: 1,
    },
    {
      fromCurrency: "IDRX",
      toCurrency: "IDR",
      rate: 1,
      region: "ID",
      markup: 0,
    },
    // UMKM USDC → IDR payout (spec §6.6 FX prerequisites, task 26).
    // Rate ≈ mid-market early-2026 (USDC ≈ USD, USD/IDR ~16,200-16,300).
    // `markup: 1.5` absorbs drift per §12 Q10 — no live FX cron in v1,
    // ops re-runs `pnpm prisma db seed` to tune. TODO: wire a scheduled
    // refresh (Wise / OpenExchangeRates / Chainlink) post-v1.
    {
      fromCurrency: "USDC",
      toCurrency: "IDR",
      rate: 16234.5,
      region: "ID",
      markup: 1.5,
    },
    // AUSD → IDR (Monad Metropolis 2026, mobile-app/docs/monad-metropolis-2026-spec.md
    // §6.6). AUSD is a USD-pegged stablecoin (6 dec, verified on-chain), so this
    // uses the live USD/IDR spot rate, not a separate crypto quote — same
    // convention as the USDC row above. Rate is the mid-market USD/IDR spot
    // fetched 2026-09-16 (open.er-api.com: 17,688.13; frankfurter.app: 17,697 —
    // averaged and rounded). `markup: 1.5` matches the USDC row; re-run the
    // seed to refresh once a live FX cron exists (same TODO as above).
    {
      fromCurrency: "AUSD",
      toCurrency: "IDR",
      rate: 17690,
      region: "ID",
      markup: 1.5,
    },
    // USDG (Paxos Global Dollar) → IDR. The on-chain rail keys the FX
    // snapshot on the payer's token symbol, so without this row USDG intents
    // fail with 503 FX_UNAVAILABLE. USD-pegged, so same USD/IDR spot and
    // markup as the AUSD row above.
    {
      fromCurrency: "USDG",
      toCurrency: "IDR",
      rate: 17690,
      region: "ID",
      markup: 1.5,
    },
  ];

  await Promise.all(
    seedExchangeRates.map(async (r) => {
      const existing = await prisma.exchangeRate.findFirst({
        where: {
          fromCurrency: r.fromCurrency,
          toCurrency: r.toCurrency,
          region: r.region,
          sourceProviderId: exchangeSource.id,
          isActive: true,
        },
      });
      if (existing) return;
      await prisma.exchangeRate.create({
        data: {
          fromCurrency: r.fromCurrency,
          toCurrency: r.toCurrency,
          rate: r.rate,
          sourceProviderId: exchangeSource.id,
          region: r.region,
          markup: r.markup,
          isActive: true,
        },
      });
    }),
  );

  // Canonical payout channels (spec §6.6 `channels`, task 26).
  // Composite PK = (channelCode, country). Upsert → idempotent, ops
  // re-runs `pnpm prisma db seed` to tune fees/limits. country-keyed
  // (not namespace-keyed) so future MY/TH/VN expansion is data-only.
  // Per-provider codes + fees live in `ProviderChannel` (two rows per
  // channel: xendit + duitku). Canonical `Channel` rows hold only the
  // merchant-facing catalog (label, kind, icon, priority).
  // DUITKU_CHANNEL_CODES below mirrors research §2.7 (duitku_payout_provider_research.md).
  // Duitku wire-codes come from `DUITKU_CHANNEL_CODES` (src/payout/duitku-channels.ts)
  // — single source of truth for both the seed and any future admin tooling.
  // Channels without a Duitku mapping just skip the duitku ProviderChannel row.
  const seedChannels: Array<{
    channelCode: string;
    country: string;
    label: string;
    kind: ChannelKind;
    accountFormat: string;
    priority: number;
    iconUrl: string | null;
    minAmountIdr: number;
    maxAmountIdr: number;
    feeIdr: number;
  }> = [
    {
      channelCode: "GOPAY",
      country: "ID",
      label: "GoPay",
      kind: ChannelKind.ewallet,
      accountFormat: "phone_id",
      priority: 10,
      iconUrl: "https://assets.takumipay.xyz/channels/gopay.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 20_000_000,
      feeIdr: 2500,
    },
    {
      channelCode: "OVO",
      country: "ID",
      label: "OVO",
      kind: ChannelKind.ewallet,
      accountFormat: "phone_id",
      priority: 11,
      iconUrl: "https://assets.takumipay.xyz/channels/ovo.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 10_000_000,
      feeIdr: 2500,
    },
    {
      channelCode: "DANA",
      country: "ID",
      label: "DANA",
      kind: ChannelKind.ewallet,
      accountFormat: "phone_id",
      priority: 12,
      iconUrl: "https://assets.takumipay.xyz/channels/dana.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 10_000_000,
      feeIdr: 2500,
    },
    {
      channelCode: "SHOPEEPAY",
      country: "ID",
      label: "ShopeePay",
      kind: ChannelKind.ewallet,
      accountFormat: "phone_id",
      priority: 13,
      iconUrl: "https://assets.takumipay.xyz/channels/shopeepay.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 10_000_000,
      feeIdr: 2500,
    },
    {
      channelCode: "BCA",
      country: "ID",
      label: "BCA",
      kind: ChannelKind.bank,
      accountFormat: "digits:10",
      priority: 20,
      iconUrl: "https://assets.takumipay.xyz/channels/bca.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 50_000_000,
      feeIdr: 5000,
    },
    {
      channelCode: "MANDIRI",
      country: "ID",
      label: "Mandiri",
      kind: ChannelKind.bank,
      accountFormat: "digits:13",
      priority: 21,
      iconUrl: "https://assets.takumipay.xyz/channels/mandiri.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 50_000_000,
      feeIdr: 5000,
    },
    {
      channelCode: "BNI",
      country: "ID",
      label: "BNI",
      kind: ChannelKind.bank,
      accountFormat: "digits:10",
      priority: 22,
      iconUrl: "https://assets.takumipay.xyz/channels/bni.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 50_000_000,
      feeIdr: 5000,
    },
    {
      channelCode: "BRI",
      country: "ID",
      label: "BRI",
      kind: ChannelKind.bank,
      accountFormat: "digits:15",
      priority: 23,
      iconUrl: "https://assets.takumipay.xyz/channels/bri.png",
      minAmountIdr: 10_000,
      maxAmountIdr: 50_000_000,
      feeIdr: 5000,
    },
  ];

  for (const ch of seedChannels) {
    await prisma.channel.upsert({
      where: {
        channelCode_country: {
          channelCode: ch.channelCode,
          country: ch.country,
        },
      },
      update: {
        label: ch.label,
        kind: ch.kind,
        accountFormat: ch.accountFormat,
        priority: ch.priority,
        iconUrl: ch.iconUrl,
        isActive: true,
      },
      create: {
        channelCode: ch.channelCode,
        country: ch.country,
        label: ch.label,
        kind: ch.kind,
        accountFormat: ch.accountFormat,
        priority: ch.priority,
        iconUrl: ch.iconUrl,
        isActive: true,
      },
    });

    // Xendit provider mapping — wire-code resolved from `XENDIT_CHANNEL_CODES`.
    // Xendit's Payouts API uses country-prefixed codes (ID_OVO, ID_BCA, …);
    // the bare canonical code is for the Payment Methods (collection) API
    // and is rejected by `/v2/payouts` with "Channel code is not supported".
    const xenditCode = XENDIT_CHANNEL_CODES[ch.channelCode];
    if (xenditCode) {
      await prisma.providerChannel.upsert({
        where: {
          channelCode_country_provider: {
            channelCode: ch.channelCode,
            country: ch.country,
            provider: "xendit",
          },
        },
        update: {
          providerChannelCode: xenditCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
        create: {
          channelCode: ch.channelCode,
          country: ch.country,
          provider: "xendit",
          providerChannelCode: xenditCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
      });
    } else {
      console.warn(
        `seed: no Xendit channel code for canonical "${ch.channelCode}"; skipping xendit ProviderChannel row.`,
      );
    }

    // Duitku provider mapping — wire-code resolved from the shared
    // `DUITKU_CHANNEL_CODES` table (research §2.7). Channels without a
    // Duitku equivalent (e.g. future non-IDR channels) just skip.
    // Dev-default fees mirror Xendit; ops can tune in prod via admin tooling.
    const duitkuCode = DUITKU_CHANNEL_CODES[ch.channelCode];
    if (duitkuCode) {
      await prisma.providerChannel.upsert({
        where: {
          channelCode_country_provider: {
            channelCode: ch.channelCode,
            country: ch.country,
            provider: "duitku",
          },
        },
        update: {
          providerChannelCode: duitkuCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
        create: {
          channelCode: ch.channelCode,
          country: ch.country,
          provider: "duitku",
          providerChannelCode: duitkuCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
      });
    } else {
      // Task 11 rule: skip with a warn when no Duitku mapping exists —
      // don't implicitly create a stub.
      console.warn(
        `seed: no Duitku channel code for canonical "${ch.channelCode}"; skipping duitku ProviderChannel row.`,
      );
    }

    // Flip provider mapping — wire-code resolved from the shared
    // `FLIP_CHANNEL_CODES` table (flip_payout_provider_spec.md §4.7).
    const flipCode = FLIP_CHANNEL_CODES[ch.channelCode];
    if (flipCode) {
      await prisma.providerChannel.upsert({
        where: {
          channelCode_country_provider: {
            channelCode: ch.channelCode,
            country: ch.country,
            provider: "flip",
          },
        },
        update: {
          providerChannelCode: flipCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
        create: {
          channelCode: ch.channelCode,
          country: ch.country,
          provider: "flip",
          providerChannelCode: flipCode,
          minAmountIdr: ch.minAmountIdr,
          maxAmountIdr: ch.maxAmountIdr,
          feeIdr: ch.feeIdr,
          isActive: true,
        },
      });
    } else {
      console.warn(
        `seed: no Flip channel code for canonical "${ch.channelCode}"; skipping flip ProviderChannel row.`,
      );
    }
  }

  const users = await Promise.all([
    prisma.user.upsert({
      where: { walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
      update: {
        role: UserRole.USER,
      },
      create: {
        walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        email: "user1@example.com",
        name: "User One",
        profileImage: "https://i.pravatar.cc/150?u=user1",
        authProvider: AuthProvider.WALLET,
        regionId: regions[0].id,
        role: UserRole.USER,
      },
    }),
    prisma.user.upsert({
      where: { email: "user2@example.com" },
      update: {
        role: UserRole.USER,
      },
      create: {
        email: "user2@example.com",
        name: "User Two",
        profileImage: "https://i.pravatar.cc/150?u=user2",
        authProvider: AuthProvider.GOOGLE,
        socialId: "google-123456",
        regionId: regions[1].id,
        role: UserRole.USER,
      },
    }),
  ]);

  const vendors = await Promise.all([
    prisma.vendor.upsert({
      where: { name: "vcGamer" },
      update: {},
      create: { name: "vcGamer" },
    }),
    prisma.vendor.upsert({
      where: { name: "DigiVoucher" },
      update: {},
      create: { name: "DigiVoucher" },
    }),
  ]);

  await Promise.all([
    prisma.vendorAPI.upsert({
      where: { id: "vcgamer-api" },
      update: {},
      create: {
        vendorId: vendors[0].id,
        baseUrl: "https://mitra-api.vcgamers.com",
        apiKey:
          "4d5855d626b5558e155ce6eddb7f370e7749f2e6fee891556e879d46cadb276e8c7a25a4b841efb5972e6d3d9aa2f201bb4d",
        apiSecret: "8aa3a704a9c2af43c636df2e59828777",
        isActive: true,
      },
    }),
    prisma.vendorAPI.upsert({
      where: { id: "digivoucher-api" },
      update: {},
      create: {
        vendorId: vendors[1].id,
        baseUrl: "https://api.digivoucher.com",
        apiKey: "digivoucher-api-key-789",
        apiSecret: "digivoucher-api-secret-012",
        isActive: true,
      },
    }),
  ]);

  const CATEGORY = {
    GAMING: "Gaming",
    PULSA_DATA: "Pulsa & Data Package",
    WITHDRAW: "Withdraw",
    SOCIALS: "Socials",
    RECHARGE: "Recharge",
    UTILITIES: "Utilities",
    STREAMING: "Streaming",
  } as const;

  const PRODUCT_CODE_TO_CATEGORY: Record<
    string,
    (typeof CATEGORY)[keyof typeof CATEGORY]
  > = {
    OVO: CATEGORY.WITHDRAW,
    LAJ: CATEGORY.WITHDRAW,
    GoPay: CATEGORY.WITHDRAW,
    DNA: CATEGORY.WITHDRAW,

    XL: CATEGORY.PULSA_DATA,
    AXIS: CATEGORY.PULSA_DATA,
    BYU: CATEGORY.PULSA_DATA,
    PSATL: CATEGORY.PULSA_DATA,
    TRI: CATEGORY.PULSA_DATA,
    PSAIN: CATEGORY.PULSA_DATA,
    SMARTFREN: CATEGORY.PULSA_DATA,

    GFX: CATEGORY.STREAMING,
    VOBST: CATEGORY.STREAMING,
    WETVID: CATEGORY.STREAMING,
    WETV: CATEGORY.STREAMING,
    IQIY: CATEGORY.STREAMING,
    VHBOGO: CATEGORY.STREAMING,
    SPO: CATEGORY.STREAMING,

    BLV: CATEGORY.SOCIALS,
    BMD: CATEGORY.SOCIALS,
    "DazzLive-C": CATEGORY.SOCIALS,
    LIVU: CATEGORY.SOCIALS,
    PPYLV: CATEGORY.SOCIALS,
    VOCBIGO: CATEGORY.SOCIALS,
    firy: CATEGORY.SOCIALS,
    mico: CATEGORY.SOCIALS,
    sugo: CATEGORY.SOCIALS,
    SCVCP: CATEGORY.SOCIALS,
    IMO: CATEGORY.SOCIALS,
    MALV: CATEGORY.SOCIALS,
    MIGO: CATEGORY.SOCIALS,
    TGL: CATEGORY.SOCIALS,
    YLG: CATEGORY.SOCIALS,

    tvpn: CATEGORY.UTILITIES,
    PLN: CATEGORY.RECHARGE,
  };

  const categoryRecords = await Promise.all(
    Object.values(CATEGORY).map((name) =>
      prisma.category.upsert({
        where: { name },
        update: {},
        create: {
          name,
          categoryType: "MAINCATEGORY",
          isActive: CATEGORY[name] === "Withdraw" ? false : true,
        },
      }),
    ),
  );

  const categoriesByName = new Map(categoryRecords.map((c) => [c.name, c]));

  console.log("🎮 Fetching VCGamers products...");
  const vcGamersProducts = await vcGamersAPI.getProducts();
  if (vcGamersProducts.statusCode !== 200 || !vcGamersProducts.data) {
    throw new Error("Failed to fetch products from vcGamers API");
  }
  console.log(
    `✅ Retrieved ${vcGamersProducts.data.length} products from VCGamers`,
  );
  console.log("");

  const productsMap = new Map();
  for (const product of vcGamersProducts.data) {
    const mappedCategoryName = PRODUCT_CODE_TO_CATEGORY[product.key];
    const fallbackCategoryId = categoriesByName.get(CATEGORY.GAMING)!.id;
    const mappedCategoryId = mappedCategoryName
      ? (categoriesByName.get(mappedCategoryName)?.id ?? fallbackCategoryId)
      : fallbackCategoryId;
    // Vendor-declared delivery mode for NEW products only. Existing rows
    // keep whatever ops set (or null → derived from `isVoucher` on read).
    const deliveryType = product.is_voucher ? "VOUCHER_CODE" : "DIRECT_TOPUP";
    const createdProduct = await prisma.product.upsert({
      where: { code: product.key },
      update: {},
      create: {
        name: product.name,
        code: product.key,
        categoryId: mappedCategoryId,
        description: product.description?.replace(/<[^>]*>/g, "") || "",
        imageUrl: product.image_url,
        isActive: true,
        isVoucher: product.is_voucher,
        deliveryType,
      },
    });
    productsMap.set(product.key, createdProduct);

    const vcGamerVendor = await prisma.vendor.findFirst({
      where: { name: "vcGamer" },
    });

    if (!vcGamerVendor) {
      console.warn(
        "VCGamer vendor not found, skipping variants for this product",
      );
      continue;
    }

    if (
      product.forms &&
      Array.isArray(product.forms) &&
      product.forms.length > 0
    ) {
      await prisma.productInputField.upsert({
        where: {
          id: `input-field-${product.key}`,
        },
        update: {
          forms: product.forms,
        },
        create: {
          id: `input-field-${product.key}`,
          productId: createdProduct.id,
          forms: product.forms,
        },
      });

      console.log(`Added input fields for product: ${product.name}`);
    }

    console.log(
      `Fetching variants for product: ${product.name} (${product.key})`,
    );
    const variantsResponse = await vcGamersAPI.getProductVariants(product.key);

    if (
      variantsResponse.statusCode !== 200 ||
      !variantsResponse.data ||
      variantsResponse.data.length === 0
    ) {
      console.warn(`No variants found for product: ${product.key}`);
      continue;
    }

    console.log(
      `Found ${variantsResponse.data.length} variants for product: ${product.name}`,
    );

    for (const variant of variantsResponse.data) {
      try {
        // `sla` is seconds (1800 / 7200 dominate the feed); 0 = unknown.
        const slaSeconds = variant.sla > 0 ? variant.sla : null;
        const createdVariant = await prisma.productVariant.upsert({
          where: { variantCode: variant.key },
          update: { slaSeconds },
          create: {
            name: variant.variation_name,
            variantCode: variant.key,
            description: `${variant.variation_name} for ${variant.brand_name}`,
            productId: createdProduct.id,
            slaSeconds,
          },
        });

        const sellPrice = Math.round(variant.price * 1.05);

        await prisma.productPrice.upsert({
          where: { id: `price-${variant.key}` },
          update: {},
          create: {
            id: `price-${variant.key}`,
            productVariantId: createdVariant.id,
            vendorId: vcGamerVendor.id,
            priceFromVendor: variant.price,
            realValue: variant.price,
            sellPrice: sellPrice,
            isActive: variant.is_active,
            currency: "IDR",
          },
        });

        console.log(
          `Added variant: ${variant.variation_name} (${variant.key})`,
        );
      } catch (error) {
        console.error(`Error creating variant ${variant.key}:`, error);
      }
    }
  }

  const firstProduct = Array.from(productsMap.values())[0];

  const productVariants = await Promise.all([
    prisma.productVariant.upsert({
      where: { variantCode: "MLBB-86" },
      update: {},
      create: {
        name: "86 Diamonds",
        variantCode: "MLBB-86",
        description: "86 Diamonds for Mobile Legends",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "MLBB-172" },
      update: {},
      create: {
        name: "172 Diamonds",
        variantCode: "MLBB-172",
        description: "172 Diamonds for Mobile Legends",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "GOGP-10" },
      update: {},
      create: {
        name: "$10 Google Play Card",
        variantCode: "GOGP-10",
        description: "$10 Google Play Gift Card",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "GOGP-25" },
      update: {},
      create: {
        name: "$25 Google Play Card",
        variantCode: "GOGP-25",
        description: "$25 Google Play Gift Card",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "XLDB1GB2H" },
      update: {},
      create: {
        name: "Data Blue 1 GB 2 Hari",
        variantCode: "XLDB1GB2H",
        description: "XL Data Blue 1 GB valid for 2 days",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "XLHR1GB2H" },
      update: {},
      create: {
        name: "HOTROD 1 GB 2 Hari",
        variantCode: "XLHR1GB2H",
        description: "XL HOTROD 1 GB valid for 2 days",
        productId: firstProduct.id,
      },
    }),
    prisma.productVariant.upsert({
      where: { variantCode: "XLHR500M7H" },
      update: {},
      create: {
        name: "HOTROD 500 MB 7 Hari",
        variantCode: "XLHR500M7H",
        description: "XL HOTROD 500 MB valid for 7 days",
        productId: firstProduct.id,
      },
    }),
  ]);

  await Promise.all([
    prisma.productPrice.upsert({
      where: { id: "product-price-1" },
      update: {},
      create: {
        id: "product-price-1",
        productVariantId: productVariants[0].id,
        vendorId: vendors[0].id,
        realValue: 50000,
        priceFromVendor: 47500,
        sellPrice: 52500,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-2" },
      update: {},
      create: {
        id: "product-price-2",
        productVariantId: productVariants[1].id,
        vendorId: vendors[0].id,
        realValue: 100000,
        priceFromVendor: 95000,
        sellPrice: 105000,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-3" },
      update: {},
      create: {
        id: "product-price-3",
        productVariantId: productVariants[2].id,
        vendorId: vendors[1].id,
        realValue: 150000,
        priceFromVendor: 145000,
        sellPrice: 155000,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-4" },
      update: {},
      create: {
        id: "product-price-4",
        productVariantId: productVariants[3].id,
        vendorId: vendors[1].id,
        realValue: 375000,
        priceFromVendor: 365000,
        sellPrice: 385000,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-5" },
      update: {},
      create: {
        id: "product-price-5",
        productVariantId: productVariants[4].id,
        vendorId: vendors[0].id,
        realValue: 4710,
        priceFromVendor: 4500,
        sellPrice: 5000,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-6" },
      update: {},
      create: {
        id: "product-price-6",
        productVariantId: productVariants[5].id,
        vendorId: vendors[0].id,
        realValue: 4728,
        priceFromVendor: 4500,
        sellPrice: 5000,
        isActive: true,
        currency: "IDR",
      },
    }),
    prisma.productPrice.upsert({
      where: { id: "product-price-7" },
      update: {},
      create: {
        id: "product-price-7",
        productVariantId: productVariants[6].id,
        vendorId: vendors[0].id,
        realValue: 5395,
        priceFromVendor: 5100,
        sellPrice: 5700,
        isActive: true,
        currency: "IDR",
      },
    }),
  ]);

  const seedTxHash =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const existingSeedTransaction = await prisma.transactionHistory.findFirst({
    where: { txHash: seedTxHash },
  });

  if (!existingSeedTransaction) {
    const transaction = await prisma.transactionHistory.create({
      data: {
        userId: users[0].id,
        tokenId: tokens[0].id,
        type: "PAYMENT",
        status: "COMPLETED",
        amount: 10,
        amountInFiat: 157000,
        fiatCurrency: "IDR",
        txHash: seedTxHash,
        senderAddress: users[0].walletAddress,
        recipientAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
      },
    });

    const productPrice = await prisma.productPrice.findFirst({
      where: { productVariantId: productVariants[0].id },
    });

    if (!productPrice) {
      throw new Error(
        "Product price not found for variant: " + productVariants[0].id,
      );
    }

    const bookingOrder = await prisma.bookingOrder.create({
      data: {
        walletAddress: users[0].walletAddress!,
        productVariantId: productVariants[0].id,
        productPriceId: productPrice.id,
        customerInfo: {
          userId: "12345",
          server: "Asia",
        },
        payment: {
          amount: 10,
          tokenAddress: tokens[0].contractAddress,
          chainId: 1,
        },
        exchangeRate: {
          rate: 15700,
          fromCurrency: "ETH",
          toCurrency: "IDR",
        },
        status: "EXECUTED",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await prisma.purchase.create({
      data: {
        transactionId: transaction.id,
        transactionCreatedAt: transaction.createdAt,
        productVariantId: productVariants[0].id,
        bookingOrderId: bookingOrder.id,
        status: "COMPLETED",
        vendorResponse: JSON.parse(
          '{"success": true, "message": "Top up successful", "transactionId": "VC123456789"}',
        ),
        vendorRefId: "VC123456789",
      },
    });
  }

  console.log("🌱 Seeding Dapp categories...");
  const dappCategories = await Promise.all(
    DAPP_CATEGORY_SEED.map((c, i) =>
      prisma.dappCategory.upsert({
        where: { name: c.name },
        update: {
          description: c.description,
          appearance: { v: 1, accent: c.accent },
          sortOrder: i,
          isActive: true,
        },
        create: {
          name: c.name,
          description: c.description,
          appearance: { v: 1, accent: c.accent },
          sortOrder: i,
          isActive: true,
        },
      }),
    ),
  );
  const dappCategoryId = Object.fromEntries(
    DAPP_CATEGORY_SEED.map((c, i) => [c.key, dappCategories[i].id]),
  ) as Record<DappCategoryKey, string>;
  console.log(`✅ Created ${dappCategories.length} dapp categories`);

  console.log("🌱 Seeding Dapps...");
  const dapps = await Promise.all(
    DAPP_SEED.map((d, i) => {
      const appearance = d.color
        ? { v: 1, background: { type: "solid", color: d.color } }
        : undefined;
      const data = {
        name: d.name,
        description: d.description,
        logoUrl: d.logoUrl,
        websiteUrl: d.websiteUrl,
        categoryId: dappCategoryId[d.cat],
        isPopular: d.popular ?? false,
        isSponsor: d.sponsor ?? false,
        isHighlight: d.highlight ?? false,
        isActive: true,
        appearance,
        sortOrder: i,
      };
      return prisma.dapp.upsert({
        where: { id: d.id },
        update: data,
        create: { id: d.id, ...data },
      });
    }),
  );
  console.log(`✅ Created ${dapps.length} dapps`);

  console.log("🌱 Seeding Dapp promotions...");
  const dappPromotions = await Promise.all(
    DAPP_PROMOTION_SEED.map((p, i) => {
      const data = {
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        imageUrl: p.imageUrl,
        appearance: {
          v: 1,
          background: { type: "solid", color: p.bg },
          foreground: p.fg,
        },
        targetUrl: null as string | null,
        dappId: p.dappId,
        isSponsored: p.sponsored ?? false,
        isActive: true,
        sortOrder: i,
      };
      return prisma.dappPromotion.upsert({
        where: { id: p.id },
        update: data,
        create: { id: p.id, ...data },
      });
    }),
  );
  console.log(`✅ Created ${dappPromotions.length} dapp promotions`);

  console.log("🌱 Seeding user dapp favorites...");
  const userDappFavorites = await Promise.all([
    prisma.userDappFavorite.upsert({
      where: {
        userId_dappId: {
          userId: users[0].id,
          dappId: dapps[0].id,
        },
      },
      update: {},
      create: {
        userId: users[0].id,
        dappId: dapps[0].id,
      },
    }),
    prisma.userDappFavorite.upsert({
      where: {
        userId_dappId: {
          userId: users[0].id,
          dappId: dapps[1].id,
        },
      },
      update: {},
      create: {
        userId: users[0].id,
        dappId: dapps[1].id,
      },
    }),
    prisma.userDappFavorite.upsert({
      where: {
        userId_dappId: {
          userId: users[1].id,
          dappId: dapps[2].id,
        },
      },
      update: {},
      create: {
        userId: users[1].id,
        dappId: dapps[2].id,
      },
    }),
    prisma.userDappFavorite.upsert({
      where: {
        userId_dappId: {
          userId: users[1].id,
          dappId: dapps[5].id,
        },
      },
      update: {},
      create: {
        userId: users[1].id,
        dappId: dapps[5].id,
      },
    }),
  ]);

  console.log(`✅ Created ${userDappFavorites.length} user dapp favorites`);

  await seedApiKeys();

  await seedAdminUsers();

  await seedPointPriceConfigs();

  await seedTestMerchants();

  console.log("");
  console.log("🎉 Seed data created successfully!");
  console.log("");
  console.log("📊 Final Cache Status:");
  cacheHelpers.getCacheInfo();
  console.log("");
  console.log(
    "💡 Tip: Next time you run this script, it will use cached vendor data for faster execution.",
  );
  console.log(
    "💡 To force fresh API calls, uncomment the clearCache() line in the main function.",
  );
}

async function seedPointPriceConfigs() {
  console.log("\n💎 Seeding point price configs...");

  const configs = [
    { currency: "IDR", baseRate: "1" },
    { currency: "USD", baseRate: "0.001" },
    { currency: "JPY", baseRate: "0.15" },
  ];

  for (const config of configs) {
    await prisma.pointPriceConfig.upsert({
      where: {
        currency_isActive: { currency: config.currency, isActive: true },
      },
      update: { baseRate: config.baseRate },
      create: {
        currency: config.currency,
        baseRate: config.baseRate,
        isActive: true,
      },
    });

    console.log(
      `  ✅ ${config.currency}: 1 point = ${config.baseRate} ${config.currency}`,
    );
  }
}

/**
 * 26-char Crockford base32 ULID, mirroring `MerchantsService`'s local
 * helper — the id is generated up-front so the JWS `merchantId` claim
 * matches the row before it's persisted.
 */
function generateMerchantUlid(): string {
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  let timeEnc = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeEnc = ENC[t % 32] + timeEnc;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ENC[Math.floor(Math.random() * 32)];
  }
  return timeEnc + rand;
}

/**
 * Real-world static QRIS stickers registered for local payment-flow
 * testing (scan-to-pay via `/pay-merchant`). Mirrors
 * `MerchantsService.signup()` (same JWS signing, same account-number
 * encryption) so the row is indistinguishable from one created through
 * the real endpoint. `qrisPan` is the EMVCo tag 26/51 sub-01 value —
 * see `extractQrisPan()` in `src/pay/intents.service.ts` for the
 * matching lookup rule.
 */
async function seedTestMerchants() {
  console.log("\n🏪 Seeding test merchants...");

  const testMerchants = [
    {
      // Decoded from a printed "GTron, SELONG" (Lombok Timur) QRIS
      // sticker, NMID ID1024347475146. Acquirer block is GoPay
      // (COM.GO-JEK.WWW), so the payout channel below mirrors that —
      // the account number is a placeholder, not the real merchant's.
      qrisPan: "936009143669405532",
      displayName: "GTron, SELONG",
      contactPhone: "081298765432",
      payoutChannelCode: "GOPAY",
      payoutAccountNumber: "081298765432",
      payoutAccountHolderName: "GTron, SELONG",
    },
  ];

  for (const tm of testMerchants) {
    const existing = await prisma.merchant.findFirst({
      where: { qrisPan: tm.qrisPan },
    });
    if (existing) {
      console.log(
        `  ⏭️  ${tm.displayName} already registered (qrisPan ${tm.qrisPan})`,
      );
      continue;
    }

    const pem = process.env.TAKUMIPAY_QR_PRIVATE_KEY_PEM;
    if (!pem) {
      console.log(
        `  ⚠️  Skipping ${tm.displayName}: TAKUMIPAY_QR_PRIVATE_KEY_PEM not set`,
      );
      continue;
    }

    const merchantId = generateMerchantUlid();
    const normalizedPem = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
    const key = crypto.createPrivateKey({ key: normalizedPem, format: "pem" });
    const kid = process.env.TAKUMIPAY_QR_KID ?? "2026-04-20";
    const iat = Math.floor(Date.now() / 1000);
    const jws = await new SignJWT({
      merchantId,
      merchantName: tm.displayName,
      displayName: tm.displayName,
      country: "ID",
      currency: "IDR",
      amountMinor: null,
      qrisPan: tm.qrisPan,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
      .setIssuedAt(iat)
      .sign(key);

    await prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: {
          id: merchantId,
          displayName: tm.displayName,
          contactPhone: tm.contactPhone,
          country: "ID",
          payoutChannelCode: tm.payoutChannelCode,
          payoutAccountNumber: encryptAccountNumber(tm.payoutAccountNumber),
          payoutAccountHolderName: tm.payoutAccountHolderName,
          qrisPan: tm.qrisPan,
          qrisStickerPhotoKey: null,
          jwsQr: `takumipay:v1:${jws}`,
          jwsIssuedAt: new Date(iat * 1000),
          jwsExpiresAt: null,
          payoutProvider: "duitku",
          isActive: true,
        },
      });
      await tx.merchantQrisClaim.create({
        data: {
          merchantId: merchant.id,
          qrisPan: tm.qrisPan,
          stickerPhotoKey: "",
          claimedAt: new Date(),
        },
      });
    });

    console.log(`  ✅ Registered ${tm.displayName} (qrisPan ${tm.qrisPan})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
