import { describe, expect, it } from "vitest";
import { LlmTriageOutputSchema, TicketSchema, TriageResultSchema } from "../src/domain/schemas.js";
import { notActionableLlmOutput, validLlmOutput, validTriageResult } from "./support/builders.js";

// Returns a deep copy of `base` after applying `mutate` to it, typed loosely so tests can break the shape.
const edit = <T>(base: T, mutate: (draft: any) => void): unknown => {
  const draft = structuredClone(base);
  mutate(draft);
  return draft;
};

const minimalTicket = { id: "1", title: "", body: "", createdAt: "2026-10-05T09:00:00Z" };

describe("TicketSchema", () => {
  it("accepts a minimal ticket with empty title and body", () => {
    expect(TicketSchema.safeParse(minimalTicket).success).toBe(true);
  });

  it("accepts every optional field", () => {
    const full = {
      ...minimalTicket,
      reporter: { name: "Ana", email: "ana@example.com", department: "Sales" },
      reporterPriority: "urgent!!",
      comments: [{ author: "Ana", body: "still broken", createdAt: "2026-10-05T10:00:00-03:00" }],
      attachments: [{ filename: "error.png", mimeType: "image/png" }],
    };
    expect(TicketSchema.safeParse(full).success).toBe(true);
  });

  it.each(["id", "title", "body", "createdAt"])("rejects a ticket missing %s", (field) => {
    const { [field as keyof typeof minimalTicket]: _omit, ...rest } = minimalTicket;
    expect(TicketSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ["numeric id", { id: 1 }],
    ["empty id", { id: "" }],
    ["null body", { body: null }],
    ["non-ISO createdAt", { createdAt: "yesterday afternoon" }],
    ["non-string reporterPriority", { reporterPriority: 1 }],
    ["comment without author", { comments: [{ body: "x", createdAt: "2026-10-05T10:00:00Z" }] }],
  ])("rejects a ticket with %s", (_label, override) => {
    expect(TicketSchema.safeParse({ ...minimalTicket, ...override }).success).toBe(false);
  });

  it("moves unknown top-level fields into raw", () => {
    const ticket = TicketSchema.parse({ ...minimalTicket, status: "open", customFields: { site: "BA" } });
    expect(ticket.raw).toEqual({ status: "open", customFields: { site: "BA" } });
    expect(ticket).not.toHaveProperty("status");
    expect(ticket).not.toHaveProperty("customFields");
  });

  it("omits raw when there are no unknown fields", () => {
    expect(TicketSchema.parse(minimalTicket)).not.toHaveProperty("raw");
  });
});

describe("LlmTriageOutputSchema", () => {
  it("accepts a valid actionable output", () => {
    const result = LlmTriageOutputSchema.safeParse(validLlmOutput());
    expect(result.error?.issues).toBeUndefined();
  });

  it("accepts a not_actionable output with null impact, urgency and team", () => {
    const result = LlmTriageOutputSchema.safeParse(notActionableLlmOutput());
    expect(result.error?.issues).toBeUndefined();
  });

  it("does not require the fields computed in code", () => {
    // validLlmOutput() has no ticketId, reviewStatus, priority.value, overridesDefault, qualityWarnings or meta.
    const output = validLlmOutput();
    for (const field of ["ticketId", "reviewStatus", "qualityWarnings", "meta"]) {
      expect(output).not.toHaveProperty(field);
    }
    expect(output.priority).not.toHaveProperty("value");
    expect(LlmTriageOutputSchema.safeParse(output).success).toBe(true);
  });

  it.each([
    ["disposition outside the enum", (d: any) => (d.disposition = "closed")],
    ["category outside the taxonomy", (d: any) => (d.category.primary = "printer")],
    ["secondary category outside the taxonomy", (d: any) => (d.category.secondary = ["printer"])],
    ["confidence outside the enum", (d: any) => (d.category.confidence = "certain")],
    ["impact outside the enum", (d: any) => (d.priority.impact = "everyone")],
    ["urgency outside the enum", (d: any) => (d.priority.urgency = "asap")],
    ["team outside the taxonomy", (d: any) => (d.suggestedTeam.team = "ceo")],
    ["notActionableReason outside the enum", (d: any) => (d.notActionableReason = "boring")],
    ["requirement source field outside title/body/comment", (d: any) => (d.requirements[0].source.field = "attachment")],
    ["missing flags", (d: any) => delete d.flags],
    ["missing requirements", (d: any) => delete d.requirements],
    ["non-boolean flag", (d: any) => (d.flags.possiblePromptInjection = "yes")],
    ["duplicate confidence outside the enum", (d: any) =>
      (d.possibleDuplicates = [{ ticketId: "1042", confidence: "certain", reason: "same printer" }])],
  ])("rejects %s", (_label, mutate) => {
    expect(LlmTriageOutputSchema.safeParse(edit(validLlmOutput(), mutate)).success).toBe(false);
  });

  // These are quality problems, not shape problems: the validator (SPEC §5) must get to see them
  // so it can report them, which it cannot do if zod rejects the output first.
  it.each([
    ["a summary over 280 chars (SUMMARY_TOO_LONG)", (d: any) => (d.summary = "x".repeat(281))],
    ["more than 5 questions (TOO_MANY_QUESTIONS)", (d: any) =>
      (d.missingInfo = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}?`, why: "w", unblocks: ["R1"] })))],
    ["a question with empty unblocks (UNBLOCKS_NOTHING)", (d: any) =>
      (d.missingInfo = [{ question: "q?", why: "w", unblocks: [] }])],
    ["a requirement without acceptance criteria (NO_ACCEPTANCE_CRITERIA)", (d: any) =>
      (d.requirements[0].acceptanceCriteria = [])],
    ["duplicate requirement IDs (DUPLICATE_REQ_ID)", (d: any) =>
      d.requirements.push(structuredClone(d.requirements[0]))],
    ["a quote not found in the ticket (QUOTE_NOT_FOUND)", (d: any) =>
      (d.requirements[0].source.quote = "words the reporter never wrote")],
    ["an unknown duplicate id (UNKNOWN_DUPLICATE_ID)", (d: any) =>
      (d.possibleDuplicates = [{ ticketId: "nope", confidence: "low", reason: "r" }])],
  ])("accepts %s, leaving it to the validator", (_label, mutate) => {
    const result = LlmTriageOutputSchema.safeParse(edit(validLlmOutput(), mutate));
    expect(result.error?.issues).toBeUndefined();
  });
});

describe("TriageResultSchema", () => {
  it("accepts a valid result", () => {
    const result = TriageResultSchema.safeParse(validTriageResult());
    expect(result.error?.issues).toBeUndefined();
  });

  it("accepts a null priority value", () => {
    const result = TriageResultSchema.safeParse(edit(validTriageResult(), (d) => (d.priority.value = null)));
    expect(result.error?.issues).toBeUndefined();
  });

  it.each([
    ["reviewStatus other than pending_review", (d: any) => (d.reviewStatus = "approved")],
    ["missing reviewStatus", (d: any) => delete d.reviewStatus],
    ["missing ticketId", (d: any) => delete d.ticketId],
    ["priority outside P1–P4", (d: any) => (d.priority.value = "P5")],
    ["missing priority value", (d: any) => delete d.priority.value],
    ["missing overridesDefault on the team", (d: any) => delete d.suggestedTeam.overridesDefault],
    ["missing meta", (d: any) => delete d.meta],
    ["non-boolean meta.repairAttempted", (d: any) => (d.meta.repairAttempted = "no")],
    ["an unknown quality warning code", (d: any) => (d.qualityWarnings = [{ code: "MADE_UP", message: "m" }])],
  ])("rejects %s", (_label, mutate) => {
    expect(TriageResultSchema.safeParse(edit(validTriageResult(), mutate)).success).toBe(false);
  });

  it.each([
    "QUOTE_NOT_FOUND",
    "NO_ACCEPTANCE_CRITERIA",
    "VAGUE_TERM",
    "DUPLICATE_REQ_ID",
    "DANGLING_UNBLOCKS",
    "UNBLOCKS_NOTHING",
    "DISPOSITION_MISMATCH",
    "UNKNOWN_DUPLICATE_ID",
    "SUMMARY_TOO_LONG",
    "TOO_MANY_QUESTIONS",
  ])("accepts a %s quality warning", (code) => {
    const withWarning = edit(validTriageResult(), (d) => {
      d.qualityWarnings = [{ code, requirementId: "R1", message: "m" }];
    });
    expect(TriageResultSchema.safeParse(withWarning).error?.issues).toBeUndefined();
  });
});
