import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GROUP_SIZE,
  GROUP_WORDING_MIN,
  SKIM_MIN,
  buildFileProtocolBlock,
  callTimeoutMs,
  countCompleteLines,
  mergeByKey,
  missingKeys,
  parseJsonl,
} from "../src/claude/jsonl";

const Line = z.object({ id: z.string(), n: z.number() });
const parseLine = (raw: unknown) => Line.parse(raw);

describe("parseJsonl", () => {
  it("parses complete lines", () => {
    const { valid, malformed } = parseJsonl('{"id":"a","n":1}\n{"id":"b","n":2}\n', parseLine);
    expect(valid).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(malformed).toEqual([]);
  });

  it("isolates a malformed line without losing its neighbours", () => {
    const { valid, malformed } = parseJsonl('{"id":"a","n":1}\nnot json\n{"id":"c","n":3}\n', parseLine);
    expect(valid.map((v) => v.id)).toEqual(["a", "c"]);
    expect(malformed).toEqual(["not json"]);
  });

  it("treats valid JSON that fails the schema as malformed", () => {
    const { valid, malformed } = parseJsonl('{"id":"a","n":"not a number"}\n', parseLine);
    expect(valid).toEqual([]);
    expect(malformed).toHaveLength(1);
  });

  it("ignores an unterminated trailing line (killed mid-write)", () => {
    const { valid, malformed } = parseJsonl('{"id":"a","n":1}\n{"id":"b","n":', parseLine);
    expect(valid.map((v) => v.id)).toEqual(["a"]);
    expect(malformed).toEqual([]);
  });

  it("counts the same line once it is terminated", () => {
    const { valid } = parseJsonl('{"id":"a","n":1}\n{"id":"b","n":2}\n', parseLine);
    expect(valid).toHaveLength(2);
  });

  it("skips blank lines and tolerates CRLF", () => {
    const { valid, malformed } = parseJsonl('{"id":"a","n":1}\r\n\n{"id":"b","n":2}\r\n', parseLine);
    expect(valid.map((v) => v.id)).toEqual(["a", "b"]);
    expect(malformed).toEqual([]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseJsonl("", parseLine)).toEqual({ valid: [], malformed: [] });
  });
});

describe("parseJsonl repair", () => {
  const Book = z.object({ id: z.string(), summary: z.string() });
  const parseBook = (raw: unknown) => Book.parse(raw);

  it("rejoins an object split by a real paragraph break inside a string", () => {
    const text = '{"id":"a","summary":"Para one.\n\nPara two."}\n{"id":"b","summary":"Fine."}\n';
    const { valid, malformed } = parseJsonl(text, parseBook);
    expect(valid.map((v) => v.id)).toEqual(["a", "b"]);
    expect(valid[0]!.summary).toBe("Para one.\n\nPara two.");
    expect(malformed).toEqual([]);
  });

  it("rejoins a pretty-printed object", () => {
    const text = '{\n  "id": "a",\n  "summary": "x"\n}\n{"id":"b","summary":"y"}\n';
    const { valid, malformed } = parseJsonl(text, parseBook);
    expect(valid.map((v) => v.id)).toEqual(["a", "b"]);
    expect(malformed).toEqual([]);
  });

  it("does NOT let a schema-rejected line swallow the next good line", () => {
    // Valid JSON, wrong shape: joining forward must not be attempted.
    const text = '{"id":123,"summary":"x"}\n{"id":"b","summary":"y"}\n';
    const { valid, malformed } = parseJsonl(text, parseBook);
    expect(valid.map((v) => v.id)).toEqual(["b"]);
    expect(malformed).toHaveLength(1);
  });

  it("drops only the unrepairable line and keeps the rest", () => {
    const text = 'this is not json at all\n{"id":"b","summary":"y"}\n';
    const { valid, malformed } = parseJsonl(text, parseBook);
    expect(valid.map((v) => v.id)).toEqual(["b"]);
    expect(malformed).toHaveLength(1);
  });

  it("still ignores an unterminated split object at the end", () => {
    const text = '{"id":"a","summary":"ok"}\n{"id":"b","summary":"half';
    const { valid } = parseJsonl(text, parseBook);
    expect(valid.map((v) => v.id)).toEqual(["a"]);
  });
});

describe("countCompleteLines", () => {
  it("counts only terminated, non-blank lines", () => {
    expect(countCompleteLines('{"a":1}\n{"b":2}\n')).toBe(2);
    expect(countCompleteLines('{"a":1}\n{"b":2')).toBe(1);
    expect(countCompleteLines("")).toBe(0);
    expect(countCompleteLines("\n\n")).toBe(0);
  });
});

describe("mergeByKey", () => {
  it("keeps the last line for a repeated key", () => {
    const merged = mergeByKey(
      [
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "a", n: 99 },
      ],
      (l) => l.id,
    );
    expect(merged.get("a")).toEqual({ id: "a", n: 99 });
    expect(merged.size).toBe(2);
  });

  it("preserves first-seen order", () => {
    const merged = mergeByKey(
      [
        { id: "b", n: 1 },
        { id: "a", n: 2 },
        { id: "b", n: 3 },
      ],
      (l) => l.id,
    );
    expect([...merged.keys()]).toEqual(["b", "a"]);
  });
});

describe("missingKeys", () => {
  it("reports only the absent keys", () => {
    expect(missingKeys(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
    expect(missingKeys(["a"], new Set(["a"]))).toEqual([]);
    expect(missingKeys([], new Set(["a"]))).toEqual([]);
  });
});

describe("buildFileProtocolBlock", () => {
  const lineSchema = { type: "object", properties: { id: { type: "string" } } };
  const outputPath = "/tmp/sb-claude-abc123/out.jsonl";

  it("gives the absolute output path and inlines the line schema", () => {
    const block = buildFileProtocolBlock({ outputPath, lineSchema });
    // Absolute, because the CLI resolves a relative path against home rather than the cwd.
    expect(block).toContain(outputPath);
    expect(block).toContain(JSON.stringify(lineSchema));
  });

  it("ends by asking for the done sentinel", () => {
    expect(buildFileProtocolBlock({ outputPath, lineSchema }).trimEnd()).toMatch(/reply with exactly: done$/);
  });

  it("asks for grouped appends only at or above the grouping threshold", () => {
    expect(buildFileProtocolBlock({ outputPath, lineSchema, expectedLines: GROUP_WORDING_MIN - 1 })).toContain(
      "Write all the lines",
    );
    expect(buildFileProtocolBlock({ outputPath, lineSchema, expectedLines: GROUP_WORDING_MIN })).toContain(
      `groups of ~${GROUP_SIZE} lines`,
    );
  });

  it("adds the skim nudge only for big calls", () => {
    expect(buildFileProtocolBlock({ outputPath, lineSchema, expectedLines: SKIM_MIN - 1 })).not.toContain("skim");
    expect(buildFileProtocolBlock({ outputPath, lineSchema, expectedLines: SKIM_MIN })).toContain("skim");
  });

  it("permits an empty result only when asked to", () => {
    expect(buildFileProtocolBlock({ outputPath, lineSchema })).not.toContain("write no lines");
    expect(buildFileProtocolBlock({ outputPath, lineSchema, zeroLinesOk: true })).toContain("write no lines");
  });
});

describe("callTimeoutMs", () => {
  it("floors at ten minutes for small or unknown calls", () => {
    expect(callTimeoutMs()).toBe(10 * 60_000);
    expect(callTimeoutMs(0)).toBe(10 * 60_000);
    expect(callTimeoutMs(8)).toBe(10 * 60_000);
  });

  it("scales with the expected line count", () => {
    expect(callTimeoutMs(73)).toBe(73 * 15_000);
  });

  it("caps at thirty minutes", () => {
    expect(callTimeoutMs(500)).toBe(30 * 60_000);
  });
});
