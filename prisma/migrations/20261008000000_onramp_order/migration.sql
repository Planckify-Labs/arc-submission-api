-- CreateEnum
CREATE TYPE "OnrampOrderStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SETTLED', 'FAILED');

-- CreateTable
CREATE TABLE "OnrampOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chainKey" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "OnrampOrderStatus" NOT NULL DEFAULT 'PENDING',
    "orderId" TEXT,
    "txHash" TEXT,
    "amount" TEXT,
    "token" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "settledAt" TIMESTAMPTZ,

    CONSTRAINT "OnrampOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnrampOrder_sessionId_key" ON "OnrampOrder"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OnrampOrder_orderId_key" ON "OnrampOrder"("orderId");

-- CreateIndex
CREATE INDEX "OnrampOrder_userId_createdAt_idx" ON "OnrampOrder"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OnrampOrder_walletAddress_status_idx" ON "OnrampOrder"("walletAddress", "status");
