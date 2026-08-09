import { describe, it, expect } from "vitest";
import {
  okResult,
  textResult,
  errorResult,
  jsonResult,
  compactJson,
  stripAbsent,
} from "./tool-result.ts";

describe("okResult", () => {
  it("returns the constant minimal ack with no isError flag", () => {
    expect(okResult()).toEqual({ content: [{ type: "text", text: "ok" }] });
  });
});

describe("textResult / errorResult", () => {
  it("textResult wraps the text without an isError flag", () => {
    const r = textResult("3 tasks running");
    expect(r).toEqual({ content: [{ type: "text", text: "3 tasks running" }] });
    expect("isError" in r).toBe(false);
  });

  it("errorResult sets isError true", () => {
    expect(errorResult("boom")).toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });
});

describe("compactJson", () => {
  it("serializes without indentation or spacing", () => {
    expect(compactJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it("drops null and undefined object fields recursively", () => {
    expect(
      compactJson({ a: null, b: { c: undefined, d: 0 }, e: "", f: false }),
    ).toBe('{"b":{"d":0},"e":"","f":false}');
  });

  it("preserves array elements positionally, including nulls", () => {
    expect(compactJson({ rows: [1, null, { x: null, y: 2 }] })).toBe(
      '{"rows":[1,null,{"y":2}]}',
    );
  });
});

describe("stripAbsent", () => {
  it("returns primitives unchanged", () => {
    expect(stripAbsent("s")).toBe("s");
    expect(stripAbsent(0)).toBe(0);
    expect(stripAbsent(false)).toBe(false);
    expect(stripAbsent(null)).toBe(null);
  });

  it("does not mutate the input object", () => {
    const input = { a: null, b: { c: null } };
    stripAbsent(input);
    expect(input).toEqual({ a: null, b: { c: null } });
  });
});

describe("jsonResult", () => {
  it("emits compact, null-stripped JSON in a single text block", () => {
    const r = jsonResult({ status: "running", result: null });
    expect(r.content).toEqual([
      { type: "text", text: '{"status":"running"}' },
    ]);
    expect("isError" in r).toBe(false);
  });

  it("carries isError when requested", () => {
    expect(jsonResult({ error: "x" }, { isError: true }).isError).toBe(true);
  });
});
