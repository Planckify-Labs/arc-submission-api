/**
 * Live check of the pinned Chainlink FX feeds. Network-bound, so it only runs
 * with DRIFT_CHECKS=1 (same switch as address-book-drift.spec.ts) and needs
 * RPC_PROXY_URL + RPC_PROXY_API_KEY (api/.env). Reads through the rpc-proxy
 * route `/evm/<chainId>`, which is what the Blockchain rows point at.
 */

import { http, createPublicClient, parseAbi } from "viem";
import { CHAINLINK_FX_FEEDS } from "./chainlink-feeds";
import { checkFeedRead } from "./chainlink-fx";

const ENABLED = process.env.DRIFT_CHECKS?.trim() === "1";
const ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

(ENABLED ? describe : describe.skip)("Chainlink FX feeds — live drift", () => {
  const origin = process.env.RPC_PROXY_URL?.trim().replace(/\/+$/, "");
  const key = process.env.RPC_PROXY_API_KEY?.trim();

  it.each(CHAINLINK_FX_FEEDS.map((f) => [f.key, f] as const))(
    "%s is the pinned feed, positive and fresh",
    async (_key, pin) => {
      expect(origin).toBeTruthy();
      const client = createPublicClient({
        transport: http(`${origin}/evm/${pin.chainId}`, {
          fetchOptions: key
            ? { headers: { Authorization: `Bearer ${key}` } }
            : undefined,
        }),
      });
      const [description, decimals, round] = await Promise.all([
        client.readContract({
          address: pin.address,
          abi: ABI,
          functionName: "description",
        }),
        client.readContract({
          address: pin.address,
          abi: ABI,
          functionName: "decimals",
        }),
        client.readContract({
          address: pin.address,
          abi: ABI,
          functionName: "latestRoundData",
        }),
      ]);
      const result = checkFeedRead(
        pin,
        {
          description,
          decimals: Number(decimals),
          answer: round[1],
          updatedAtSec: round[3],
        },
        Math.floor(Date.now() / 1000),
      );
      expect(result).toMatchObject({ ok: true });
    },
    30_000,
  );
});
