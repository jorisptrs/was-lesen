import { describe, expect, it } from "vitest";
import { initialRunState, runReducer } from "../src/state";

describe("runReducer — the Cancel path", () => {
  it("reset returns a running stream to idle", () => {
    // Cancel dispatches this. Before the fix nothing was dispatched at all — the abort's
    // AbortError was swallowed and status stayed "running", spinner and Cancel button forever.
    let s = runReducer(initialRunState, { type: "start" });
    s = runReducer(s, {
      type: "sse",
      event: { type: "lens_progress", lens: "bridges", lines: 3, quota: 12, state: "running" },
    });
    expect(s.status).toBe("running");
    expect(s.lenses.bridges?.lines).toBe(3);
    s = runReducer(s, { type: "reset" });
    expect(s).toEqual(initialRunState);
  });
});
