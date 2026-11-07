import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { SETTLEMENT_JOB_OPTIONS } from "../blockchain-verification/settlement-policy";
import {
  TPurchaseJobData,
  TBlockchainVerificationJobData,
  TVendorApiJobData,
} from "./interfaces/job-data.interface";

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue("purchase-processing") private purchaseQueue: Queue,
    @InjectQueue("blockchain-verification") private blockchainQueue: Queue,
    @InjectQueue("vendor-api-calls") private vendorQueue: Queue,
  ) {}

  async addPurchaseJob(data: TPurchaseJobData): Promise<string> {
    // The payer has already paid on-chain by the time this runs, so the job
    // rides the same long settlement schedule as merchant payments and point
    // deposits instead of the queue's 3 quick attempts (the processor's own
    // vendor budget is separate; see VENDOR_STAGE_MAX_ATTEMPTS).
    const job = await this.purchaseQueue.add("process-purchase", data, {
      ...SETTLEMENT_JOB_OPTIONS,
      jobId: `purchase-${data.refId}`,
      delay: 0,
    });

    this.logger.log(`Added purchase job ${job.id} for refId: ${data.refId}`);
    return job.id!;
  }

  async addBlockchainVerificationJob(
    data: TBlockchainVerificationJobData,
  ): Promise<string> {
    const job = await this.blockchainQueue.add("verify-transaction", data, {
      jobId: `blockchain-${data.refId}`,
      delay: 0,
    });

    this.logger.log(
      `Added blockchain verification job ${job.id} for refId: ${data.refId}`,
    );
    return job.id!;
  }

  async addVendorApiJob(data: TVendorApiJobData): Promise<string> {
    const job = await this.vendorQueue.add("process-vendor-order", data, {
      jobId: `vendor-${data.refId}`,
      delay: 0,
    });

    this.logger.log(`Added vendor API job ${job.id} for refId: ${data.refId}`);
    return job.id!;
  }

  async getJobStatus(queueName: string, jobId: string) {
    let queue: Queue;

    switch (queueName) {
      case "purchase-processing":
        queue = this.purchaseQueue;
        break;
      case "blockchain-verification":
        queue = this.blockchainQueue;
        break;
      case "vendor-api-calls":
        queue = this.vendorQueue;
        break;
      default:
        throw new Error(`Unknown queue: ${queueName}`);
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      opts: job.opts,
    };
  }

  async getPurchaseJobsByRefId(refId: string) {
    const jobs = await Promise.all([
      this.purchaseQueue.getJob(`purchase-${refId}`),
      this.blockchainQueue.getJob(`blockchain-${refId}`),
      this.vendorQueue.getJob(`vendor-${refId}`),
    ]);

    return {
      purchase: jobs[0],
      blockchain: jobs[1],
      vendor: jobs[2],
    };
  }

  async getQueueStats() {
    const [purchaseStats, blockchainStats, vendorStats] = await Promise.all([
      this.purchaseQueue.getJobCounts(),
      this.blockchainQueue.getJobCounts(),
      this.vendorQueue.getJobCounts(),
    ]);

    return {
      purchase: purchaseStats,
      blockchain: blockchainStats,
      vendor: vendorStats,
    };
  }

  async cleanQueues() {
    await Promise.all([
      this.purchaseQueue.clean(24 * 60 * 60 * 1000, 100, "completed"),
      this.purchaseQueue.clean(24 * 60 * 60 * 1000, 50, "failed"),
      this.blockchainQueue.clean(24 * 60 * 60 * 1000, 100, "completed"),
      this.blockchainQueue.clean(24 * 60 * 60 * 1000, 50, "failed"),
      this.vendorQueue.clean(24 * 60 * 60 * 1000, 100, "completed"),
      this.vendorQueue.clean(24 * 60 * 60 * 1000, 50, "failed"),
    ]);

    this.logger.log("Cleaned old jobs from all queues");
  }
}
