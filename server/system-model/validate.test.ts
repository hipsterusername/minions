import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { validateLoadedSystemModel } from "./validate.ts";
import path from "path";

describe("validateLoadedSystemModel", () => {
  it("passes the valid fixture", () => {
    const { model } = loadSystemModel(path.resolve("tests/fixtures/system-model/valid"));
    expect(model).not.toBeNull();
    expect(validateLoadedSystemModel(model!)).toEqual([]);
  });
});
