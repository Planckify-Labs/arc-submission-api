import type { Queue } from "bullmq";
import { QueueService } from "./queue.service";

function buildHarness() {
  const purchaseQueue = {
    add: jest.fn(async () => ({ id: "p_job_1" })),
    getJob: jest.fn(async (id: string) => ({ id })),
    getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0 })),
    clean: jest.fn(async () => ([])),
  } as unknown as Queue;
  const blockchainQueue = {
    add: jest.fn(async () => ({ id: "b_job_1" })),
    getJob: jest.fn(async (id: string) => ({ id })),
    getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0 })),
    clean: jest.fn(async () => ([])),
  } as unknown as Queue;
  const vendorQueue = {
    add: jest.fn(async () => ({ id: "v_job_1" })),
    getJob: jest.fn(async (id: string) => ({ id })),
    getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0 })),
    clean: jest.fn(async () => ([])),
  } as unknown as Queue;

  const svc = new QueueService(purchaseQueue, blockchainQueue, vendorQueue);
  return { svc, purchaseQueue, blockchainQueue, vendorQueue };
}

describe("QueueService.add* job dispatch", () => {
  it("addPurchaseJob uses jobId=`purchase-<refId>`", async () => {
    const { svc, purchaseQueue } = buildHarness();
    await svc.addPurchaseJob({ refId: "R1" } as never);
    const args = (purchaseQueue.add as jest.Mock).mock.calls[0];
    expect(args[0]).toBe("process-purchase");
    expect(args[2].jobId).toBe("purchase-R1");
  });

  it("addPurchaseJob rides the long settlement schedule (a payer who really paid must not be failed by a slow chain)", async () => {
    const { svc, purchaseQueue } = buildHarness();
    await svc.addPurchaseJob({ refId: "R1" } as never);
    const opts = (purchaseQueue.add as jest.Mock).mock.calls[0][2];
    expect(opts.attempts).toBe(150);
    expect(opts.backoff).toEqual({ type: "custom" });
  });

  it("addBlockchainVerificationJob uses jobId=`blockchain-<refId>`", async () => {
    const { svc, blockchainQueue } = buildHarness();
    await svc.addBlockchainVerificationJob({ refId: "R2" } as never);
    expect(
      (blockchainQueue.add as jest.Mock).mock.calls[0][2].jobId,
    ).toBe("blockchain-R2");
  });

  it("addVendorApiJob uses jobId=`vendor-<refId>`", async () => {
    const { svc, vendorQueue } = buildHarness();
    await svc.addVendorApiJob({ refId: "R3" } as never);
    expect((vendorQueue.add as jest.Mock).mock.calls[0][2].jobId).toBe("vendor-R3");
  });
});

describe("QueueService.getJobStatus", () => {
  it("dispatches to the right queue by name and returns job snapshot", async () => {
    const { svc } = buildHarness();
    const out = await svc.getJobStatus("purchase-processing", "purchase-R1");
    expect(out?.id).toBe("purchase-R1");
  });

  it("throws Error for unknown queue name", async () => {
    const { svc } = buildHarness();
    await expect(svc.getJobStatus("unknown-queue", "x")).rejects.toThrow(
      /Unknown queue/,
    );
  });

  it("returns null when the job is missing", async () => {
    const { svc, purchaseQueue } = buildHarness();
    (purchaseQueue.getJob as jest.Mock).mockResolvedValueOnce(null);
    const out = await svc.getJobStatus("purchase-processing", "missing");
    expect(out).toBeNull();
  });
});

describe("QueueService.getPurchaseJobsByRefId", () => {
  it("fans out across all three queues with the canonical job-id prefixes", async () => {
    const { svc, purchaseQueue, blockchainQueue, vendorQueue } = buildHarness();
    await svc.getPurchaseJobsByRefId("R7");
    expect(purchaseQueue.getJob).toHaveBeenCalledWith("purchase-R7");
    expect(blockchainQueue.getJob).toHaveBeenCalledWith("blockchain-R7");
    expect(vendorQueue.getJob).toHaveBeenCalledWith("vendor-R7");
  });
});

describe("QueueService.cleanQueues", () => {
  it("cleans completed and failed jobs > 24h on every queue", async () => {
    const { svc, purchaseQueue, blockchainQueue, vendorQueue } = buildHarness();
    await svc.cleanQueues();
    // Each queue gets two clean() calls (completed + failed).
    expect((purchaseQueue.clean as jest.Mock).mock.calls).toHaveLength(2);
    expect((blockchainQueue.clean as jest.Mock).mock.calls).toHaveLength(2);
    expect((vendorQueue.clean as jest.Mock).mock.calls).toHaveLength(2);
  });
});

describe("QueueService.getQueueStats", () => {
  it("aggregates counts from all three queues", async () => {
    const { svc } = buildHarness();
    const out = await svc.getQueueStats();
    expect(Object.keys(out)).toEqual(["purchase", "blockchain", "vendor"]);
  });
});
