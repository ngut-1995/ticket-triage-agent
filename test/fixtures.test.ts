import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TicketSchema } from "../src/domain/schemas.js";

const root = new URL("../", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const jsonFiles = (dir: string) =>
  readdirSync(new URL(dir, root))
    .filter((f) => f.endsWith(".json"))
    .sort();

const ticketFiles = jsonFiles("fixtures/tickets/");
const tickets = ticketFiles.map((f) => TicketSchema.parse(read(`fixtures/tickets/${f}`)));
const corpus = TicketSchema.array().parse(read("fixtures/corpus/open-tickets.json"));

interface EvalCase {
  fixture: string;
  corpus?: string;
  corpusIds?: string[];
  expect: { highDuplicates: string[]; notHighDuplicates?: string[] };
}
const cases = read("eval/cases.json") as EvalCase[];

describe("fixtures/tickets", () => {
  it.each(ticketFiles)("%s matches TicketSchema with no unknown fields", (file) => {
    const result = TicketSchema.safeParse(read(`fixtures/tickets/${file}`));
    expect(result.error?.issues).toBeUndefined();
    expect(result.data?.raw).toBeUndefined();
  });

  it("numbered files are named <id>-<slug>.json", () => {
    ticketFiles.forEach((file, i) => {
      if (/^\d/.test(file)) expect(file.startsWith(`${tickets[i]?.id}-`)).toBe(true);
    });
  });

  it("ticket and corpus ids are unique", () => {
    const ids = [...tickets, ...corpus].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fixtures/invalid", () => {
  it.each(jsonFiles("fixtures/invalid/"))("%s fails to load as a Ticket", (file) => {
    const text = readFileSync(new URL(`fixtures/invalid/${file}`, root), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    expect(TicketSchema.safeParse(parsed).success).toBe(false);
  });
});

describe("eval/cases.json", () => {
  it("covers every ticket fixture", () => {
    const covered = new Set(cases.map((c) => c.fixture));
    expect(ticketFiles.map((f) => `fixtures/tickets/${f}`).filter((f) => !covered.has(f))).toEqual([]);
  });

  it.each(cases.map((c, i) => [i, c.fixture, c] as const))(
    "case %i (%s) references existing tickets",
    (_i, _fixture, c) => {
      const ticket = TicketSchema.parse(read(c.fixture));
      const pool = c.corpus
        ? TicketSchema.array().parse(read(c.corpus))
        : tickets.filter((t) => c.corpusIds?.includes(t.id));
      expect(pool.map((t) => t.id)).not.toContain(ticket.id);
      if (c.corpusIds) expect(pool).toHaveLength(c.corpusIds.length);
      const poolIds = pool.map((t) => t.id);
      for (const id of [...c.expect.highDuplicates, ...(c.expect.notHighDuplicates ?? [])]) {
        expect(poolIds).toContain(id);
      }
    },
  );
});
