import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileTicketSource } from "../src/sources/file.js";
import type { TicketSource } from "../src/sources/ticket-source.js";
import { TicketValidationError } from "../src/triage.js";

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const ticketsDir = path("fixtures/tickets");
const corpusFile = path("fixtures/corpus/open-tickets.json");

describe("FileTicketSource.getTicket", () => {
  it("finds a ticket by its id, not its filename", async () => {
    const source = new FileTicketSource({ ticketsDir });
    // bug-clear.json holds id "3001"
    const ticket = await source.getTicket("3001");
    expect(ticket.id).toBe("3001");
    expect(ticket.title).toBe("Insight dashboard crashes when exporting a chart to Excel");
    expect(ticket.raw).toBeUndefined();
  });

  it("finds a numbered fixture by id", async () => {
    const source = new FileTicketSource({ ticketsDir });
    const ticket = await source.getTicket("2001");
    expect(ticket.id).toBe("2001");
  });

  it("does not treat the filename as an id", async () => {
    const source = new FileTicketSource({ ticketsDir });
    await expect(source.getTicket("bug-clear")).rejects.toThrow(/bug-clear/);
  });

  it("throws for an unknown id", async () => {
    const source = new FileTicketSource({ ticketsDir });
    const error = await source.getTicket("does-not-exist").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TicketValidationError);
    expect((error as Error).message).toMatch(/does-not-exist/);
  });

  it("throws when the matching ticket fails TicketSchema", async () => {
    const source = new FileTicketSource({ ticketsDir: path("fixtures/invalid") });
    // missing-body.json has id "9001" but no body
    const error = await source.getTicket("9001").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketValidationError);
    expect((error as Error).message).toMatch(/9001/);
  });

  it("throws when the ticket directory does not exist", async () => {
    const source = new FileTicketSource({ ticketsDir: path("fixtures/nope") });
    await expect(source.getTicket("3001")).rejects.toThrow();
  });
});

describe("FileTicketSource.listOpenTickets", () => {
  it("returns [] without a corpusFile", async () => {
    const source = new FileTicketSource({ ticketsDir });
    expect(await source.listOpenTickets()).toEqual([]);
  });

  it("returns the corpus tickets parsed with TicketSchema", async () => {
    const source = new FileTicketSource({ ticketsDir, corpusFile });
    const tickets = await source.listOpenTickets();
    const ids = tickets.map((t) => t.id);
    expect(ids).toContain("1042");
    expect(ids).toContain("1043");
    expect(ids).toContain("1045");
    expect(tickets.find((t) => t.id === "1042")?.title).toBe("Finance printer printing streaks");
  });

  it("throws when the corpus contains an invalid ticket", async () => {
    const source = new FileTicketSource({
      ticketsDir,
      corpusFile: path("fixtures/invalid/missing-body.json"),
    });
    await expect(source.listOpenTickets()).rejects.toThrow();
  });
});

describe("TicketSource interface", () => {
  it("exposes only getTicket and listOpenTickets (read-only)", () => {
    const source: TicketSource = new FileTicketSource({ ticketsDir });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(source)).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual(["getTicket", "listOpenTickets"]);
  });
});
