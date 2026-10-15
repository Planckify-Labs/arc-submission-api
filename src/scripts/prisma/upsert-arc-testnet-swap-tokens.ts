/**
 * One-off: upsert ONLY the Arc Testnet EURC + cirBTC catalogue rows that
 * seed.ts now carries, without re-running the whole seed. Safe to re-run.
 *
 *   npx ts-node --transpile-only src/scripts/prisma/upsert-arc-testnet-swap-tokens.ts
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

const ROWS = [
  {
    contractAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    name: "EURC",
    symbol: "EURC",
    decimals: 6,
    logoUrl: "https://static.alchemyapi.io/images/assets/20641.png",
    isStablecoin: true,
    peggedCurrency: "EUR",
  },
  {
    contractAddress: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
    name: "Circle Wrapped Bitcoin",
    symbol: "cirBTC",
    decimals: 8,
    logoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
    isStablecoin: false,
    peggedCurrency: null,
  },
];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const chain = await prisma.blockchain.findUnique({ where: { chainId: 5042002 } });
    if (!chain) throw new Error("no Arc Testnet (5042002) blockchain row");
    for (const row of ROWS) {
      const data = {
        ...row,
        isNativeCurrency: false,
        isPaymentEnabled: false,
        isActive: true,
      };
      const saved = await prisma.token.upsert({
        where: {
          blockchainId_contractAddress: {
            blockchainId: chain.id,
            contractAddress: row.contractAddress,
          },
        },
        update: data,
        create: { ...data, blockchainId: chain.id },
      });
      console.log(`upserted ${saved.symbol} ${saved.contractAddress} on ${chain.name}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
