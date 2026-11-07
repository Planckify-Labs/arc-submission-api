-- CreateEnum
CREATE TYPE "PointsHoldStatus" AS ENUM ('NONE', 'HELD', 'CONSUMED', 'RELEASED');

-- AlterTable
-- pointTransactionId / pointTransactionCreatedAt point at the PointTransaction
-- hypertable and deliberately carry NO foreign key.
ALTER TABLE "BookingOrder"
    ADD COLUMN "pointsApplied" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "pointsHoldStatus" "PointsHoldStatus" NOT NULL DEFAULT 'NONE',
    ADD COLUMN "pointTransactionId" TEXT,
    ADD COLUMN "pointTransactionCreatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BookingOrder_pointsHoldStatus_expiresAt_idx" ON "BookingOrder"("pointsHoldStatus", "expiresAt");
