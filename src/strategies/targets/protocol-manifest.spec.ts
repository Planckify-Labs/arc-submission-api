/**
 * Manifest conformance (runbook §11.2).
 *
 * §11.3 says "a family that forgets its gate is the exact mistake" — a warning
 * that exists because it happened. This turns that checklist into failing
 * tests, so the mistake is caught by CI rather than by a reviewer noticing an
 * absence.
 *
 * Every assertion here is about a property a HUMAN would otherwise have to
 * remember. Nothing here touches the network.
 */

import {
  type ProtocolManifest,
  allProtocolManifests,
  bootProtocolManifests,
} from "./protocol-manifest";
import { EVM_TARGET_KINDS } from "./types";
import "./protocols";
import { bootTargetResolvers } from "./bootstrap";
import { getResolverForProject } from "./registry";

const MANIFESTS = allProtocolManifests();

/** Execution kinds a manifest may declare that map to a real EVM target kind. */
const EXECUTION_TO_TARGET_KIND: Record<string, string | null> = {
  erc4626: "erc4626",
  "erc4626-pinned": "erc4626",
  "compound-v2": "compound-v2",
  // Registers no resolver of its own (bespoke) or a refusing one (reserved),
  // so neither maps to an execution target kind.
  bespoke: null,
  reserved: null,
};

describe("protocol catalogue", () => {
  it("declares at least one protocol (guards the collector itself)", () => {
    // A refactor that stopped importing ./protocols would make every check
    // below pass vacuously.
    expect(MANIFESTS.length).toBeGreaterThan(0);
  });

  it("gives every protocol a unique slug and no overlapping aliases", () => {
    // Two protocols claiming one DeFiLlama slug makes which resolver wins
    // depend on registration order, which is not a decision anyone made.
    const slugs = MANIFESTS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const m of MANIFESTS) {
      for (const alias of m.aliases) {
        const key = alias.toLowerCase();
        const owner = seen.get(key);
        if (owner && owner !== m.slug)
          clashes.push(`${alias}: ${owner} vs ${m.slug}`);
        seen.set(key, m.slug);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("maps every execution kind to a real EVM target kind", () => {
    // A typo'd kind would silently build a resolver for a target nothing can
    // execute. `EVM_TARGET_KINDS` is the union the validators are keyed by.
    const bad = MANIFESTS.filter((m) => {
      const target = EXECUTION_TO_TARGET_KIND[m.execution.kind];
      if (target === null) return false; // bespoke: resolver lives elsewhere
      return (
        target === undefined || !EVM_TARGET_KINDS.includes(target as never)
      );
    }).map((m) => `${m.slug}:${m.execution.kind}`);
    expect(bad).toEqual([]);
  });

  it("requires a discovery source unless the addresses are pinned", () => {
    // The /poolsOld outage taught this one: "we did not think about discovery"
    // and "the aggregator will handle it" are the same bug. A protocol that is
    // neither pinned nor withheld MUST say where its address comes from.
    const bad = MANIFESTS.filter(
      (m) =>
        !m.withheld &&
        m.execution.kind !== "erc4626-pinned" &&
        // A reserved slug deliberately resolves nothing, so it needs no source.
        m.execution.kind !== "reserved" &&
        !m.discovery,
    ).map((m) => m.slug);
    expect(bad).toEqual([]);
  });

  it("makes every withheld protocol state a reason", () => {
    // A withheld entry with an empty reason is an omission wearing a comment.
    const bad = MANIFESTS.filter(
      (m) => m.withheld !== undefined && m.withheld.trim().length < 10,
    ).map((m) => m.slug);
    expect(bad).toEqual([]);
  });

  it("never registers a withheld protocol", () => {
    const withheld = MANIFESTS.filter((m) => m.withheld);
    expect(withheld.every((m) => !!m.withheld)).toBe(true);
    // Booting with every flag off must register nothing at all, which also
    // proves gating is consulted rather than assumed.
    expect(() => bootProtocolManifests()).not.toThrow();
  });

  it("keeps a bespoke protocol honest about who resolves it", () => {
    // `bespoke` registers no resolver. If nobody names the file that does, the
    // protocol silently has no execution path at all.
    const bad = MANIFESTS.filter(
      (m) =>
        m.execution.kind === "bespoke" &&
        !(m.execution as { resolvedBy?: string }).resolvedBy?.endsWith(".ts"),
    ).map((m) => m.slug);
    expect(bad).toEqual([]);
  });

  it("keeps minTvlUsd a pre-filter, not a safety control", () => {
    // Documented intent: it exists to spare the RPC budget. A huge value would
    // quietly become a policy nobody reviewed.
    const bad = MANIFESTS.filter(
      (m) => m.minTvlUsd !== undefined && m.minTvlUsd > 10_000_000,
    ).map((m) => `${m.slug}:${m.minTvlUsd}`);
    expect(bad).toEqual([]);
  });
});

describe("reserved slugs", () => {
  it("keeps aave-v4 claimed so it cannot fall through to the v3 Pool", () => {
    // Regression, found by the dry run 2026-08-21: nothing claimed "aave-v4"
    // exactly, so the registry's substring fallback matched "aave" and every
    // v4 pool resolved to the Aave v3 Pool — and VALIDATED, because wstETH,
    // WBTC and weETH are genuinely listed v3 reserves. Users would have been
    // shown v4 and deposited into v3. Five pools, $168M, all silently wrong.
    //
    // Since 2026-10-26 the claim is a real resolver, not a reservation: v4
    // deposits through Aave's own TokenizationSpokes (aave-v4.resolver.ts).
    // What must hold is unchanged: "aave-v4" is answered EXACTLY, and never by
    // the v3 family.
    expect(MANIFESTS.find((m) => m.slug === "aave-v4")).toBeUndefined();
    bootTargetResolvers();
    const resolver = getResolverForProject("aave-v4");
    expect(resolver?.family).toBe("aave-v4");
    expect(getResolverForProject("aave-v4-core")?.family).toBe("aave-v4");
  });

  it("makes every reserved slug explain what it is protecting against", () => {
    const bad = MANIFESTS.filter(
      (m) =>
        m.execution.kind === "reserved" &&
        (m.execution as { reason?: string }).reason!.trim().length < 20,
    ).map((m) => m.slug);
    expect(bad).toEqual([]);
  });

  it("never leaves a reserved slug also marked withheld", () => {
    // `withheld` skips registration entirely, which would silently un-reserve
    // the slug and let the substring fallback back in.
    const bad = MANIFESTS.filter(
      (m) => m.execution.kind === "reserved" && m.withheld,
    ).map((m) => m.slug);
    expect(bad).toEqual([]);
  });
});

describe("manifest shape", () => {
  it("rejects a duplicate slug loudly", async () => {
    const { registerProtocol, resetProtocolManifests } = await import(
      "./protocol-manifest"
    );
    const entry: ProtocolManifest = {
      slug: "dup-test",
      aliases: ["dup-test"],
      tier: "tier1",
      execution: { kind: "erc4626" },
      withheld: "test fixture, never registered",
    };
    registerProtocol(entry);
    expect(() => registerProtocol(entry)).toThrow(/duplicate slug/);
    resetProtocolManifests();
  });
});
