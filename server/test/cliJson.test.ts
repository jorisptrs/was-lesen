import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/claude/client";

describe("extractJsonObject", () => {
  it("extracts a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("strips markdown fences and prose", () => {
    expect(extractJsonObject('Sure! Here it is:\n```json\n{"a":{"b":[1,2]}}\n```\nDone.')).toBe('{"a":{"b":[1,2]}}');
  });
  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"t":"a { weird } title"} trailing')).toBe('{"t":"a { weird } title"}');
  });
  it("handles escaped quotes", () => {
    expect(extractJsonObject('{"t":"he said \\"hi\\""}')).toBe('{"t":"he said \\"hi\\""}');
  });
  it("returns null when no object exists", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
  it("returns null for an unterminated object", () => {
    expect(extractJsonObject('{"a": 1')).toBeNull();
  });
});

describe("escapeControlCharsInStrings", () => {
  it("escapes raw newlines inside strings only", async () => {
    const { escapeControlCharsInStrings } = await import("../src/claude/client");
    const raw = '{"summary":"Para one.\n\nPara two.","n":1}';
    expect(JSON.parse(escapeControlCharsInStrings(raw)).summary).toBe("Para one.\n\nPara two.");
  });
  it("leaves already-escaped sequences and structure whitespace alone", async () => {
    const { escapeControlCharsInStrings } = await import("../src/claude/client");
    const raw = '{\n  "a": "x\\ny",\n  "b": 2\n}';
    expect(JSON.parse(escapeControlCharsInStrings(raw))).toEqual({ a: "x\ny", b: 2 });
  });
});
