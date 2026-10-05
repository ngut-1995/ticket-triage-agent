import { describe, expect, it } from "vitest";
import { hello } from "../src/index.js";

describe("hello", () => {
  it("greets by name", () => {
    expect(hello("world")).toBe("Hello, world");
  });
});
