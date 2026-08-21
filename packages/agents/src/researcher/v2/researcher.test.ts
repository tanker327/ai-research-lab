// Ticket 8.5 contract test: v2 = v1's tool loop (covered in v1's tests) with
// the independence rule in the prompt — vendor material alone never settles a
// vendor-reported measured value.
import { describe, expect, it } from "vitest";
import { researcherV2 } from "./index";
import { systemPrompt } from "./prompt";

describe("researcherV2", () => {
  it("reports version v2", () => {
    expect(researcherV2.version).toBe("v2");
  });

  it("prompt carries the independence rule in both tool configurations", () => {
    for (const hasSearch of [true, false]) {
      const p = systemPrompt(hasSearch, 5);
      expect(p).toContain("INDEPENDENCE");
      expect(p).toContain("independent source");
      expect(p).toContain("self-assess complete=false");
    }
  });
});
