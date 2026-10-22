import { describe, expect, it } from "vitest";

import { configuredEndpoints } from "@/lib/stellar/execution";
import { ENDPOINT_HINTS, NETWORKS } from "@/lib/stellar/networks";

// The Tuning panel label must report the endpoint lines actually typed in the box,
// not a fixed count, and every one of them must reach the parallel broadcast list.
describe("Additional endpoints count", () => {
  const primary = NETWORKS.find((n) => n.id === "pi-mainnet")!.horizon;

  it("counts the two hint endpoints as two active lines", () => {
    const box = ENDPOINT_HINTS.join("\n");

    expect(configuredEndpoints(primary, box)).toEqual([primary, ...ENDPOINT_HINTS]);
  });

  it("drops blank and whitespace-only lines instead of counting them", () => {
    const box = "http://194.233.69.78:31401\n\n   \nhttp://82.197.68.80:31401\n";

    expect(configuredEndpoints(primary, box).slice(1)).toEqual([
      "http://194.233.69.78:31401",
      "http://82.197.68.80:31401",
    ]);
  });

  it("reports zero active lines for an empty box", () => {
    expect(configuredEndpoints(primary, "").slice(1)).toEqual([]);
  });
});
