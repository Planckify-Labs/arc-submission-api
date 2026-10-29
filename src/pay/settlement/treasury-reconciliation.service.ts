import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export interface CustodyBalance {
  tokenId: string;
  tokenSymbol: string;
  totalSettledMinor: bigint;
  totalPlatformFeeMinor: bigint;
  totalMerchantBackingMinor: bigint;
}

/**
 * Treasury reconciliation surface (task 28).
 *
 * Exposes "outstanding token custody" queries for ops dashboards.
 * Aggregates OnchainSettlement-backed PaymentIntents by token,
 * breaking down the total settled amount into platform fee and
 * merchant-backing portions.
 *
 * Spec refs:
 *   - ss11a item (4): "Backend should expose outstanding token custody"
 *   - ss4.7a: "platform fee math"
 */
@Injectable()
export class TreasuryReconciliationService {
  private readonly logger = new Logger(TreasuryReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the outstanding custody balance per token for all intents
   * that have been settled or paid out via the onchain rail.
   *
   * "Outstanding" means tokens are still in the contract (not yet swept).
   * To compute true outstanding, subtract what left on-chain:
   * MerchantBackingSwept, Withdraw and TokenRecovered amounts, plus
   * PlatformFeesSwept from sweepPlatformFees. Since contract 2.3.0 a
   * withdrawal that takes fee-backed balance also emits PlatformFeesSwept in
   * the same transaction, relabelling part of that Withdraw/TokenRecovered
   * amount as fees. Those are not an extra outflow, so do not subtract them twice.
   */
  async getOutstandingCustody(): Promise<CustodyBalance[]> {
    const results = await this.prisma.$queryRaw<
      Array<{
        tokenId: string;
        tokenSymbol: string;
        totalSettledMinor: bigint | number | string;
        totalPlatformFeeMinor: bigint | number | string;
        totalMerchantBackingMinor: bigint | number | string;
      }>
    >`
      SELECT
        pi."sourceTokenId" as "tokenId",
        t."symbol" as "tokenSymbol",
        COALESCE(SUM(pi."tokenAmountMinor"), 0) as "totalSettledMinor",
        COALESCE(SUM(pi."platformFeeAmountMinor"), 0) as "totalPlatformFeeMinor",
        COALESCE(SUM(pi."merchantBackingAmountMinor"), 0) as "totalMerchantBackingMinor"
      FROM "PaymentIntent" pi
      JOIN "OnchainSettlement" os ON os."intentId" = pi."id"
      LEFT JOIN "Token" t ON t."id" = pi."sourceTokenId"
      WHERE pi."status" IN ('SETTLED', 'PAID_OUT')
        AND os."verifiedAt" IS NOT NULL
      GROUP BY pi."sourceTokenId", t."symbol"
    `;

    this.logger.log(
      `Treasury reconciliation: ${results.length} token(s) with outstanding custody`,
    );

    return results.map((r) => ({
      tokenId: r.tokenId,
      tokenSymbol: r.tokenSymbol,
      totalSettledMinor: BigInt(r.totalSettledMinor),
      totalPlatformFeeMinor: BigInt(r.totalPlatformFeeMinor),
      totalMerchantBackingMinor: BigInt(r.totalMerchantBackingMinor),
    }));
  }

  /**
   * Returns per-merchant settlement totals for a given time range.
   * Useful for merchant-level reconciliation and payout verification.
   */
  async getMerchantSettlementTotals(
    sinceDate: Date,
  ): Promise<
    Array<{
      merchantId: string;
      tokenSymbol: string;
      totalSettledMinor: bigint;
      intentCount: number;
    }>
  > {
    const results = await this.prisma.$queryRaw<
      Array<{
        merchantId: string;
        tokenSymbol: string;
        totalSettledMinor: bigint | number | string;
        intentCount: number;
      }>
    >`
      SELECT
        pi."merchantId",
        t."symbol" as "tokenSymbol",
        COALESCE(SUM(pi."tokenAmountMinor"), 0) as "totalSettledMinor",
        COUNT(pi."id")::int as "intentCount"
      FROM "PaymentIntent" pi
      JOIN "OnchainSettlement" os ON os."intentId" = pi."id"
      LEFT JOIN "Token" t ON t."id" = pi."sourceTokenId"
      WHERE pi."status" IN ('SETTLED', 'PAID_OUT')
        AND os."verifiedAt" IS NOT NULL
        AND os."createdAt" >= ${sinceDate}
      GROUP BY pi."merchantId", t."symbol"
      ORDER BY "totalSettledMinor" DESC
    `;

    return results.map((r) => ({
      merchantId: r.merchantId,
      tokenSymbol: r.tokenSymbol,
      totalSettledMinor: BigInt(r.totalSettledMinor),
      intentCount: r.intentCount,
    }));
  }
}
