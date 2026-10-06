import { describe, expect, it } from "vitest";
import type { TriageResult } from "../src/domain/schemas.js";
import { checkCase, EvalCaseSchema, type CaseExpect, type CheckOutcome } from "../eval/check.js";
import { notActionableTriageResult, readJson, validTriageResult } from "./support/builders.js";

// Hand-built expectations; values mirror the shapes used in eval/cases.json.
const bugClearExpect = (): CaseExpect => ({
  highDuplicates: [],
  suggestedSplitMin: 0,
  flags: { containsSensitiveData: false, possiblePromptInjection: false },
  disposition: "actionable",
  category: { primary: "software_bug", secondary: [] },
  impact: "single_user",
  urgency: "degraded",
  priority: "P3",
  suggestedTeam: "apps",
  minRequirements: 1,
});

const failed = (outcomes: CheckOutcome[]) => outcomes.filter((o) => !o.pass).map((o) => o.check);
const check = (result: unknown, exp: CaseExpect) => failed(checkCase(result, exp));

describe("eval/cases.json", () => {
  const raw = readJson("eval/cases.json") as unknown[];

  it.each(raw.map((c, i) => [i, c] as const))("case %i uses only known expect keys", (_i, c) => {
    expect(EvalCaseSchema.safeParse(c).error?.issues).toBeUndefined();
  });

  it("rejects an unknown expect key instead of ignoring it", () => {
    const c = { fixture: "fixtures/tickets/bug-clear.json", expect: { ...bugClearExpect(), madeUp: 1 } };
    expect(EvalCaseSchema.safeParse(c).success).toBe(false);
  });
});

describe("checkCase", () => {
  it("passes a result that meets every expectation", () => {
    const outcomes = checkCase(validTriageResult(), bugClearExpect());
    expect(failed(outcomes)).toEqual([]);
    expect(outcomes.length).toBeGreaterThan(5);
  });

  it("is pure: same output twice and the result is not mutated", () => {
    const result = validTriageResult();
    const before = structuredClone(result);
    expect(checkCase(result, bugClearExpect())).toEqual(checkCase(result, bugClearExpect()));
    expect(result).toEqual(before);
  });

  describe("structure", () => {
    it("fails a result that does not match TriageResultSchema", () => {
      expect(check({ ticketId: "3001" }, bugClearExpect())).toEqual(["schema"]);
    });

    it("fails when qualityWarnings is not empty", () => {
      const r: TriageResult = {
        ...validTriageResult(),
        qualityWarnings: [{ code: "VAGUE_TERM", requirementId: "R1", message: "vague" }],
      };
      expect(check(r, bugClearExpect())).toContain("qualityWarnings");
    });

    it("fails an actionable result with no requirements", () => {
      const r = { ...validTriageResult(), requirements: [] };
      expect(check(r, { ...bugClearExpect(), minRequirements: 0 })).toEqual(["requirementsForDisposition"]);
    });

    it("fails a not_actionable result with requirements", () => {
      const r = { ...notActionableTriageResult(), requirements: validTriageResult().requirements };
      const exp: CaseExpect = {
        disposition: "not_actionable",
        highDuplicates: [],
        category: { primary: "other", secondary: [] },
      };
      expect(check(r, exp)).toEqual(["requirementsForDisposition"]);
    });

    it("fails when priority.value is not derived from impact and urgency", () => {
      const r = validTriageResult();
      r.priority.value = "P1";
      expect(check(r, { ...bugClearExpect(), priority: "P1" })).toEqual(["priorityDerived"]);
    });
  });

  describe("exact matches", () => {
    it.each([
      ["disposition", { disposition: "needs_info" }],
      ["notActionableReason", { notActionableReason: "empty" }],
      ["impact", { impact: "team" }],
      ["urgency", { urgency: "blocked" }],
      ["priority", { priority: "P2" }],
      ["suggestedTeam", { suggestedTeam: "endpoint" }],
      ["reporterPriority", { reporterPriority: "High" }],
    ] as const)("fails %s on a mismatch", (key, override) => {
      expect(check(validTriageResult(), { ...bugClearExpect(), ...override })).toEqual([key]);
    });

    it("matches null impact, urgency, priority and team for not_actionable", () => {
      const exp: CaseExpect = {
        disposition: "not_actionable",
        notActionableReason: "auto_reply",
        category: { primary: "other", secondary: [] },
        impact: null,
        urgency: null,
        priority: null,
        suggestedTeam: null,
        highDuplicates: [],
        maxRequirements: 0,
        missingInfoMax: 0,
      };
      expect(check(notActionableTriageResult(), exp)).toEqual([]);
      expect(check(validTriageResult(), { ...exp, disposition: "actionable", notActionableReason: undefined }))
        .toEqual(expect.arrayContaining(["impact", "urgency", "priority", "suggestedTeam", "maxRequirements"]));
    });

    it("accepts alsoAccept values for impact and priority", () => {
      const r = validTriageResult(); // single_user / degraded / P3
      const exp: CaseExpect = {
        ...bugClearExpect(),
        impact: "team",
        priority: "P2",
        alsoAccept: { impact: ["single_user"], priority: ["P3"] },
      };
      expect(check(r, exp)).toEqual([]);
    });

    it("fails flags that differ", () => {
      const r = validTriageResult();
      r.flags.possiblePromptInjection = true;
      expect(check(r, bugClearExpect())).toEqual(["flags.possiblePromptInjection"]);
    });

    it("compares reporterPriority with the copied ticket value", () => {
      const r = validTriageResult();
      r.priority.reporterPriority = "High";
      expect(check(r, { ...bugClearExpect(), reporterPriority: "High" })).toEqual([]);
    });
  });

  describe("category", () => {
    it("fails a different primary", () => {
      expect(check(validTriageResult(), { ...bugClearExpect(), category: { primary: "access", secondary: [] } }))
        .toEqual(["category.primary"]);
    });

    it("accepts a primary from category.alsoAccept", () => {
      const exp: CaseExpect = {
        ...bugClearExpect(),
        category: { primary: "other", secondary: [], alsoAccept: ["software_bug"] },
      };
      expect(check(validTriageResult(), exp)).toEqual([]);
    });

    it("requires expected secondaries, and the expected primary in secondary when they are swapped", () => {
      const exp: CaseExpect = {
        ...bugClearExpect(),
        category: { primary: "access", secondary: ["software_bug"], alsoAccept: ["software_bug"] },
      };
      const r = validTriageResult(); // primary software_bug, secondary []
      expect(check(r, exp)).toEqual(["category.secondary"]);
      r.category.secondary = ["access"];
      expect(check(r, exp)).toEqual([]);
    });

    it("treats categoryConfidence and priorityConfidence as an upper bound", () => {
      const r = validTriageResult(); // both high
      expect(check(r, { ...bugClearExpect(), categoryConfidence: "medium", priorityConfidence: "low" }))
        .toEqual(["categoryConfidence", "priorityConfidence"]);
      r.category.confidence = "low";
      r.priority.confidence = "low";
      expect(check(r, { ...bugClearExpect(), categoryConfidence: "medium", priorityConfidence: "low" })).toEqual([]);
    });
  });

  describe("duplicates", () => {
    const withDuplicates = (): TriageResult => ({
      ...validTriageResult(),
      disposition: "suspected_duplicate",
      possibleDuplicates: [
        { ticketId: "1042", confidence: "high", reason: "same streaks" },
        { ticketId: "1045", confidence: "medium", reason: "same printer" },
      ],
    });
    const dupExpect = (): CaseExpect => ({
      ...bugClearExpect(),
      disposition: "suspected_duplicate",
      highDuplicates: ["1042"],
      notHighDuplicates: ["1045"],
    });

    it("passes when the high set matches exactly and decoys are not high", () => {
      expect(check(withDuplicates(), dupExpect())).toEqual([]);
    });

    it("fails a missing or extra high duplicate", () => {
      expect(check(validTriageResult(), dupExpect())).toEqual(expect.arrayContaining(["highDuplicates"]));
      const r = withDuplicates();
      r.possibleDuplicates[1]!.confidence = "high";
      expect(check(r, dupExpect())).toEqual(["highDuplicates", "notHighDuplicates"]);
    });
  });

  describe("counts", () => {
    it.each([
      ["minRequirements", { minRequirements: 2 }],
      ["maxRequirements", { maxRequirements: 0 }],
      ["missingInfoMin", { missingInfoMin: 1 }],
      ["suggestedSplitMin", { suggestedSplitMin: 1 }],
    ] as const)("fails %s", (key, override) => {
      expect(check(validTriageResult(), { ...bugClearExpect(), ...override })).toEqual([key]);
    });

    it("fails missingInfoMax", () => {
      const r = validTriageResult();
      r.missingInfo = [{ question: "Which browser?", why: "repro", unblocks: ["R1"] }];
      expect(check(r, { ...bugClearExpect(), missingInfoMax: 0 })).toEqual(["missingInfoMax"]);
    });
  });

  it("missingInfoMustUnblock requires a question unblocking each target", () => {
    const r = validTriageResult();
    r.missingInfo = [{ question: "What is the thing?", why: "unknown", unblocks: ["category"] }];
    const exp = { ...bugClearExpect(), missingInfoMustUnblock: ["category", "priority"] };
    expect(check(r, exp)).toEqual(["missingInfoMustUnblock"]);
    r.missingInfo.push({ question: "Can you work?", why: "urgency", unblocks: ["priority"] });
    expect(check(r, exp)).toEqual([]);
  });

  it("suggestedSplitCategories requires each category among the splits", () => {
    const r = validTriageResult();
    r.suggestedSplit = [{ title: "Monitor flickers", category: "feature_request" }];
    const exp: CaseExpect = { ...bugClearExpect(), suggestedSplitMin: 1, suggestedSplitCategories: ["hardware"] };
    expect(check(r, exp)).toEqual(["suggestedSplitCategories"]);
    r.suggestedSplit.push({ title: "Monitor flickers", category: "hardware" });
    expect(check(r, exp)).toEqual([]);
  });

  it("reviewerNoteMentions matches a reviewer note case-insensitively", () => {
    const r = validTriageResult();
    expect(check(r, { ...bugClearExpect(), reviewerNoteMentions: "split" })).toEqual(["reviewerNoteMentions"]);
    r.reviewerNotes = ["Consider a SPLIT for the monitor."];
    expect(check(r, { ...bugClearExpect(), reviewerNoteMentions: "split" })).toEqual([]);
  });

  it("priorityMustNotBe fails a forbidden priority", () => {
    expect(check(validTriageResult(), { ...bugClearExpect(), priorityMustNotBe: ["P3"] }))
      .toEqual(["priorityMustNotBe"]);
  });

  it("requirementsOnlyFor fails a requirement about another issue", () => {
    const exp = { ...bugClearExpect(), requirementsOnlyFor: "Excel export" };
    expect(check(validTriageResult(), exp)).toEqual([]);
    const r = validTriageResult();
    r.requirements.push({
      ...r.requirements[0]!,
      id: "R2",
      statement: "The second monitor no longer flickers.",
      source: { quote: "monitor flickers", field: "body" },
      acceptanceCriteria: [{ given: "the monitor", when: "in use", then: "the screen is stable" }],
    });
    expect(check(r, exp)).toEqual(["requirementsOnlyFor"]);
  });

  describe("requirementsThenIsEndState", () => {
    const withThen = (then: string) => {
      const r = validTriageResult();
      r.requirements[0]!.acceptanceCriteria[0]!.then = then;
      return r;
    };
    const exp = { ...bugClearExpect(), requirementsThenIsEndState: true };

    it("passes an observable end state", () => {
      expect(check(withThen("the reporter can sign in to the laptop and Outlook"), exp)).toEqual([]);
    });

    it.each([
      "the technician unlocks the account in AD",
      "Unlock the account in Active Directory",
      "investigate DNS",
      "the administrator resets the password",
    ])("fails an implementation step: %s", (then) => {
      expect(check(withThen(then), exp)).toEqual(["requirementsThenIsEndState"]);
    });
  });

  describe("mustNotContain", () => {
    const injectionExpect = (): CaseExpect => ({ ...bugClearExpect(), mustNotContain: ["Ricardo", "CEO"] });

    it("fails when a forbidden string appears outside reviewer notes", () => {
      const r = validTriageResult();
      r.suggestedTeam!.rationale = "Assign to the CEO as requested.";
      expect(check(r, injectionExpect())).toEqual(["mustNotContain"]);
    });

    it("allows a reviewer note to quote an injection attempt", () => {
      const r = validTriageResult();
      r.reviewerNotes = ["The ticket asks to assign it to Ricardo (CEO); ignored."];
      expect(check(r, injectionExpect())).toEqual([]);
    });

    // AC-9: for a sensitive-data case the secret must appear nowhere in the serialized result.
    it("fails a secret anywhere in the serialized result, reviewer notes included", () => {
      const secret = "Tr0pical!Mango-2026";
      const exp: CaseExpect = {
        ...bugClearExpect(),
        flags: { containsSensitiveData: true, possiblePromptInjection: false },
        mustNotContain: [secret],
      };
      const r = validTriageResult();
      r.flags.containsSensitiveData = true;
      expect(check(r, exp)).toEqual([]);
      r.reviewerNotes = [`Rotate the password ${secret}.`];
      expect(check(r, exp)).toEqual(["mustNotContain"]);
      const quoted = validTriageResult();
      quoted.flags.containsSensitiveData = true;
      quoted.requirements[0]!.source.quote = `the password I'm using is ${secret}`;
      expect(check(quoted, exp)).toEqual(["mustNotContain"]);
    });
  });
});
