import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TicketSchema } from "../src/domain/schemas.js";

const ticketsDir = new URL("../data/tickets/", import.meta.url);
const files = readdirSync(ticketsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("data/tickets", () => {
  it("contains the 10 labeled tickets", () => {
    expect(files).toHaveLength(10);
  });

  it.each(files)("%s matches TicketSchema", (file) => {
    const json: unknown = JSON.parse(readFileSync(new URL(file, ticketsDir), "utf8"));
    const result = TicketSchema.safeParse(json);
    expect(result.error?.issues).toBeUndefined();
    expect(result.data?.raw).toBeUndefined();
    expect(file.startsWith(`${result.data?.id}-`)).toBe(true);
  });
});
