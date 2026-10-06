import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prefilterCandidates } from "../src/duplicates/prefilter.js";
import { TicketSchema, type Ticket } from "../src/domain/schemas.js";

const root = new URL("../", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const ticket = (id: string, title: string, body = ""): Ticket => ({
  id,
  title,
  body,
  createdAt: "2026-10-05T09:00:00Z",
});

const ids = (candidates: { ticket: Ticket }[]) => candidates.map((c) => c.ticket.id);

describe("prefilterCandidates", () => {
  it("scores by token Jaccard over title + body", () => {
    // {printer, streaks} vs {printer, jam}: 1 shared / 3 total
    const [only] = prefilterCandidates(ticket("in", "Printer streaks"), [ticket("a", "Printer jam")]);
    expect(only?.score).toBeCloseTo(1 / 3);
  });

  it("ranks candidates by descending score", () => {
    const input = ticket("in", "finance printer streaks");
    const corpus = [
      ticket("weak", "printer jam"),
      ticket("exact", "finance printer streaks"),
      ticket("mid", "finance printer toner"),
    ];
    expect(ids(prefilterCandidates(input, corpus))).toEqual(["exact", "mid", "weak"]);
  });

  it("ignores case", () => {
    const [only] = prefilterCandidates(ticket("in", "PRINTER Streaks"), [ticket("a", "printer streaks")]);
    expect(only?.score).toBe(1);
  });

  it("matches on body tokens, not only the title", () => {
    const input = ticket("in", "Help", "the scanner on floor two jams");
    const result = prefilterCandidates(input, [ticket("a", "Hardware issue", "scanner jams constantly")]);
    expect(ids(result)).toEqual(["a"]);
  });

  it("drops tickets that share no tokens", () => {
    const result = prefilterCandidates(ticket("in", "printer streaks"), [ticket("a", "vpn disconnects")]);
    expect(result).toEqual([]);
  });

  it("drops tickets that share only stopwords", () => {
    const result = prefilterCandidates(ticket("in", "the printer is broken"), [
      ticket("a", "the vpn is down"),
    ]);
    expect(result).toEqual([]);
  });

  it("never includes the input ticket, even when it is in the corpus", () => {
    const input = ticket("same", "printer streaks");
    const result = prefilterCandidates(input, [input, ticket("other", "printer jam")]);
    expect(ids(result)).toEqual(["other"]);
  });

  it("returns [] for an empty corpus", () => {
    expect(prefilterCandidates(ticket("in", "printer streaks"), [])).toEqual([]);
  });

  it("keeps at most 10 candidates by default, the highest scoring ones", () => {
    const input = ticket("in", "printer streaks grey lines");
    const strong = Array.from({ length: 10 }, (_, i) => ticket(`strong-${i}`, "printer streaks grey"));
    const weak = Array.from({ length: 5 }, (_, i) => ticket(`weak-${i}`, "printer"));
    const result = prefilterCandidates(input, [...weak, ...strong]);
    expect(result).toHaveLength(10);
    expect(ids(result).every((id) => id.startsWith("strong-"))).toBe(true);
  });

  it("respects a custom k", () => {
    const input = ticket("in", "printer streaks");
    const corpus = Array.from({ length: 5 }, (_, i) => ticket(`t${i}`, "printer"));
    expect(prefilterCandidates(input, corpus, 3)).toHaveLength(3);
  });

  describe("with the fixture corpus", () => {
    const input = TicketSchema.parse(read("fixtures/tickets/duplicate-of-1042.json"));
    const corpus = TicketSchema.array().parse(read("fixtures/corpus/open-tickets.json"));
    const result = prefilterCandidates(input, corpus);

    it("keeps both the real duplicate (1042) and the decoy (1045) for the LLM to judge", () => {
      expect(ids(result)).toEqual(expect.arrayContaining(["1042", "1045"]));
    });

    it("returns ≤ 10 candidates, all with score > 0, sorted by descending score", () => {
      expect(result.length).toBeLessThanOrEqual(10);
      for (const c of result) expect(c.score).toBeGreaterThan(0);
      const scores = result.map((c) => c.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });
  });
});
