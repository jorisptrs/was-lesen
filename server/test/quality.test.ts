import { describe, expect, it } from "vitest";
import { QUALITY_PRESETS, resolveQuality } from "../src/domain/request";

describe("resolveQuality", () => {
  it("maps each preset to its model + effort", () => {
    expect(resolveQuality({ quality: "test" }, "high")).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(resolveQuality({ quality: "standard" }, "low")).toEqual({ model: "claude-sonnet-5", effort: "high" });
    expect(resolveQuality({ quality: "best" }, "low")).toEqual({ model: "claude-fable-5", effort: "high" });
  });

  it("never yields max effort from a preset (max stays passphrase-gated)", () => {
    for (const p of Object.values(QUALITY_PRESETS)) expect(p.effort).not.toBe("max");
  });

  it("falls back to legacy raw effort with no model override", () => {
    expect(resolveQuality({ effort: "xhigh" }, "low")).toEqual({ effort: "xhigh" });
  });

  it("ignores an unknown quality string (client can't smuggle a model)", () => {
    expect(resolveQuality({ quality: "claude-opus-4-8" as never }, "low")).toEqual({ effort: "low" });
  });

  it("uses the configured fallback when nothing valid is sent", () => {
    expect(resolveQuality({}, "medium")).toEqual({ effort: "medium" });
    expect(resolveQuality({ effort: "turbo" as never }, "medium")).toEqual({ effort: "medium" });
  });
});

describe("qualityOf length discount", () => {
  it("leaves short and unknown-length books untouched", async () => {
    const { qualityOf } = await import("@sb/shared");
    expect(qualityOf(8, 5)).toBeCloseTo(7.4);
    expect(qualityOf(8, 5, null)).toBeCloseTo(7.4);
    expect(qualityOf(8, 5, 180)).toBeCloseTo(7.4);
  });
  it("discounts slightly with length and caps at one point", async () => {
    const { qualityOf } = await import("@sb/shared");
    expect(qualityOf(8, 5, 320)).toBeCloseTo(7.4 - 0.2);
    expect(qualityOf(8, 5, 500)).toBeCloseTo(7.4 - 0.5);
    expect(qualityOf(8, 5, 2000)).toBeCloseTo(7.4 - 1.0);
  });
});
