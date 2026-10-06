import { describe, expect, it } from "vitest";
import type { QualityRuleCode, Ticket, TriageResult } from "../src/domain/schemas.js";
import { VAGUE_TERMS, validateResult } from "../src/quality/validate.js";
import { bugClearTicket, notActionableTriageResult, validTriageResult } from "./support/builders.js";

// Deep copy of `base` after `mutate`, so each test changes only what it is about.
const edit = <T>(base: T, mutate: (draft: T) => void): T => {
  const draft = structuredClone(base);
  mutate(draft);
  return draft;
};

const codes = (result: TriageResult, ticket: Ticket = bugClearTicket(), candidateIds: string[] = []) =>
  validateResult(result, ticket, candidateIds).map((w) => w.code);

const withCode = (result: TriageResult, code: QualityRuleCode, ticket: Ticket = bugClearTicket(), ids: string[] = []) =>
  validateResult(result, ticket, ids).filter((w) => w.code === code);

const ticketWithComment = (): Ticket => ({
  ...bugClearTicket(),
  comments: [
    { author: "Andrea", body: "Same thing happens   in Edge 141.", createdAt: "2026-10-05T10:00:00Z" },
  ],
});

// A needs_info result where question 1 blocks the only requirement.
const needsInfo = (): TriageResult =>
  edit(validTriageResult(), (r) => {
    r.disposition = "needs_info";
    r.missingInfo = [{ question: "Which browser version?", why: "Crash may be version-specific.", unblocks: ["R1"] }];
  });

describe("validateResult: the valid builder", () => {
  it("returns no warnings for a valid actionable result", () => {
    expect(validateResult(validTriageResult(), bugClearTicket())).toEqual([]);
  });

  it("returns no warnings for a valid not_actionable result", () => {
    expect(validateResult(notActionableTriageResult(), bugClearTicket())).toEqual([]);
  });
});

describe("QUOTE_NOT_FOUND", () => {
  it("passes when the quote matches ignoring case and collapsed whitespace", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source.quote = "  CLICK the chart menu\n (three   dots) > export ";
    });
    expect(withCode(r, "QUOTE_NOT_FOUND")).toEqual([]);
  });

  it("matches whitespace that spans a newline in the ticket", () => {
    // body has "...the board deck for now, but I need the numbers in Excel." and "\n\nSteps to reproduce"
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source.quote = "reloads. steps to reproduce:";
    });
    expect(withCode(r, "QUOTE_NOT_FOUND")).toEqual([]);
  });

  it("fails when the quote is not in the named field", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source.quote = "Exporting to CSV also crashes";
    });
    expect(withCode(r, "QUOTE_NOT_FOUND")).toEqual([
      { code: "QUOTE_NOT_FOUND", requirementId: "R1", message: expect.any(String) },
    ]);
  });

  it("fails when the quote exists but in a different field than the one named", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source = { quote: "Insight dashboard crashes when exporting", field: "body" };
    });
    expect(codes(r)).toContain("QUOTE_NOT_FOUND");
    const inTitle = edit(r, (d) => {
      d.requirements[0]!.source.field = "title";
    });
    expect(codes(inTitle)).not.toContain("QUOTE_NOT_FOUND");
  });

  it("finds comment quotes in any comment body", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source = { quote: "same thing happens in edge 141", field: "comment" };
    });
    expect(withCode(r, "QUOTE_NOT_FOUND", ticketWithComment())).toEqual([]);
    expect(withCode(r, "QUOTE_NOT_FOUND", bugClearTicket())).toHaveLength(1);
  });

  it("fails on an empty quote", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.source.quote = "   ";
    });
    expect(codes(r)).toContain("QUOTE_NOT_FOUND");
  });

  it("searches priority.evidence across title, body and comments", () => {
    const r = edit(validTriageResult(), (d) => {
      d.priority.evidence = ["insight DASHBOARD crashes", "the tab crashes   after about 3 seconds", "in Edge 141"];
    });
    expect(withCode(r, "QUOTE_NOT_FOUND", ticketWithComment())).toEqual([]);
  });

  it("fails on a priority.evidence entry that is not in the ticket", () => {
    const r = edit(validTriageResult(), (d) => {
      d.priority.evidence = ["The tab crashes after about 3 seconds", "the whole sales team is blocked"];
    });
    const warnings = withCode(r, "QUOTE_NOT_FOUND");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.requirementId).toBeUndefined();
    expect(warnings[0]!.message).toContain("the whole sales team is blocked");
  });
});

describe("NO_ACCEPTANCE_CRITERIA", () => {
  it("passes with one acceptance criterion", () => {
    expect(codes(validTriageResult())).not.toContain("NO_ACCEPTANCE_CRITERIA");
  });

  it("fails when a requirement has no acceptance criteria", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.acceptanceCriteria = [];
    });
    expect(withCode(r, "NO_ACCEPTANCE_CRITERIA")).toEqual([
      { code: "NO_ACCEPTANCE_CRITERIA", requirementId: "R1", message: expect.any(String) },
    ]);
  });
});

describe("VAGUE_TERM", () => {
  it("exports the banned terms from SPEC §4.5", () => {
    expect(VAGUE_TERMS).toEqual(
      expect.arrayContaining([
        "fast",
        "quickly",
        "easy",
        "user-friendly",
        "intuitive",
        "ASAP",
        "properly",
        "correctly",
        "as expected",
        "better",
        "improve",
        "optimize",
        "etc.",
        "and/or",
      ]),
    );
  });

  it("passes when statement and then have no banned term (word boundaries respected)", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.statement = "Breakfast orders export to Excel."; // contains "fast" inside a word
      d.requirements[0]!.acceptanceCriteria[0]!.then = "the file opens in Excel";
    });
    expect(codes(r)).not.toContain("VAGUE_TERM");
  });

  it("fails on a banned term in the statement, case-insensitively", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.statement = "Excel export works Correctly.";
    });
    expect(withCode(r, "VAGUE_TERM")).toEqual([
      { code: "VAGUE_TERM", requirementId: "R1", message: expect.stringContaining("correctly") },
    ]);
  });

  it("fails on a banned term in an acceptance criterion's then", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.acceptanceCriteria[0]!.then = "the export works as expected";
    });
    expect(withCode(r, "VAGUE_TERM")).toHaveLength(1);
  });

  it("ignores banned terms in given/when (only statement and then are checked)", () => {
    const r = edit(validTriageResult(), (d) => {
      d.requirements[0]!.acceptanceCriteria[0]!.given = "a fast network";
    });
    expect(codes(r)).not.toContain("VAGUE_TERM");
  });
});

describe("DUPLICATE_REQ_ID", () => {
  const twoReqs = (secondId: string) =>
    edit(validTriageResult(), (d) => {
      d.requirements.push({ ...structuredClone(d.requirements[0]!), id: secondId });
    });

  it("passes with unique IDs", () => {
    expect(codes(twoReqs("R2"))).not.toContain("DUPLICATE_REQ_ID");
  });

  it("fails once per repeated ID", () => {
    expect(withCode(twoReqs("R1"), "DUPLICATE_REQ_ID")).toEqual([
      { code: "DUPLICATE_REQ_ID", requirementId: "R1", message: expect.any(String) },
    ]);
  });
});

describe("DANGLING_UNBLOCKS", () => {
  it("passes for existing requirement IDs and the field names", () => {
    const r = edit(validTriageResult(), (d) => {
      d.missingInfo = [{ question: "q?", why: "w", unblocks: ["R1", "category", "priority", "duplicate"] }];
    });
    expect(codes(r)).not.toContain("DANGLING_UNBLOCKS");
  });

  it("fails for a requirement ID that does not exist", () => {
    const r = edit(validTriageResult(), (d) => {
      d.missingInfo = [{ question: "q?", why: "w", unblocks: ["priority", "R7"] }];
    });
    expect(withCode(r, "DANGLING_UNBLOCKS")).toEqual([
      { code: "DANGLING_UNBLOCKS", requirementId: "R7", message: expect.any(String) },
    ]);
  });
});

describe("UNBLOCKS_NOTHING", () => {
  it("passes when every question unblocks something", () => {
    const r = edit(validTriageResult(), (d) => {
      d.missingInfo = [{ question: "q?", why: "w", unblocks: ["priority"] }];
    });
    expect(codes(r)).not.toContain("UNBLOCKS_NOTHING");
  });

  it("fails for a question with an empty unblocks", () => {
    const r = edit(validTriageResult(), (d) => {
      d.missingInfo = [{ question: "q?", why: "w", unblocks: [] }];
    });
    expect(withCode(r, "UNBLOCKS_NOTHING")).toHaveLength(1);
  });
});

describe("UNKNOWN_DUPLICATE_ID", () => {
  const withDup = (id: string) =>
    edit(validTriageResult(), (d) => {
      d.possibleDuplicates = [{ ticketId: id, confidence: "low", reason: "similar" }];
    });

  it("passes when the duplicate was among the candidates sent", () => {
    expect(codes(withDup("1042"), bugClearTicket(), ["1042", "1045"])).not.toContain("UNKNOWN_DUPLICATE_ID");
  });

  it("fails when the duplicate was not among the candidates sent", () => {
    expect(withCode(withDup("9999"), "UNKNOWN_DUPLICATE_ID", bugClearTicket(), ["1042"])).toHaveLength(1);
  });

  it("fails for any duplicate when no candidates were sent (default)", () => {
    expect(codes(withDup("1042"))).toContain("UNKNOWN_DUPLICATE_ID");
  });
});

describe("SUMMARY_TOO_LONG", () => {
  it("passes at exactly 280 chars", () => {
    const r = edit(validTriageResult(), (d) => {
      d.summary = "a".repeat(280);
    });
    expect(codes(r)).not.toContain("SUMMARY_TOO_LONG");
  });

  it("fails at 281 chars", () => {
    const r = edit(validTriageResult(), (d) => {
      d.summary = "a".repeat(281);
    });
    expect(withCode(r, "SUMMARY_TOO_LONG")).toHaveLength(1);
  });
});

describe("TOO_MANY_QUESTIONS", () => {
  const withQuestions = (n: number) =>
    edit(validTriageResult(), (d) => {
      d.missingInfo = Array.from({ length: n }, (_, i) => ({ question: `q${i}?`, why: "w", unblocks: ["priority"] }));
    });

  it("passes with 5 questions", () => {
    expect(codes(withQuestions(5))).not.toContain("TOO_MANY_QUESTIONS");
  });

  it("fails with 6 questions", () => {
    expect(withCode(withQuestions(6), "TOO_MANY_QUESTIONS")).toHaveLength(1);
  });
});

describe("DISPOSITION_MISMATCH (SPEC §4.1)", () => {
  const mismatch = (r: TriageResult, ids: string[] = []) => withCode(r, "DISPOSITION_MISMATCH", bugClearTicket(), ids);

  describe("actionable", () => {
    it("passes with ≥1 requirement and a non-blocking question", () => {
      const r = edit(validTriageResult(), (d) => {
        d.missingInfo = [{ question: "q?", why: "w", unblocks: ["priority"] }];
      });
      expect(mismatch(r)).toEqual([]);
    });

    it("fails with no requirements", () => {
      const r = edit(validTriageResult(), (d) => {
        d.requirements = [];
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails when every requirement is blocked by a question (that is needs_info)", () => {
      const r = edit(needsInfo(), (d) => {
        d.disposition = "actionable";
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with a high-confidence duplicate (precedence: suspected_duplicate)", () => {
      const r = edit(validTriageResult(), (d) => {
        d.possibleDuplicates = [{ ticketId: "1042", confidence: "high", reason: "same" }];
      });
      expect(mismatch(r, ["1042"])).toHaveLength(1);
    });

    it("fails with a notActionableReason", () => {
      const r = edit(validTriageResult(), (d) => {
        d.notActionableReason = "spam";
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with a null suggestedTeam, null impact/urgency or null priority value", () => {
      for (const mutate of [
        (d: TriageResult) => (d.suggestedTeam = null),
        (d: TriageResult) => (d.priority.impact = null),
        (d: TriageResult) => (d.priority.urgency = null),
        (d: TriageResult) => (d.priority.value = null),
      ]) {
        expect(mismatch(edit(validTriageResult(), mutate))).toHaveLength(1);
      }
    });
  });

  describe("needs_info", () => {
    it("passes when one question blocks every requirement", () => {
      expect(mismatch(needsInfo())).toEqual([]);
    });

    it("passes with no requirements and a question that unblocks a field", () => {
      const r = edit(needsInfo(), (d) => {
        d.requirements = [];
        d.missingInfo = [{ question: "q?", why: "w", unblocks: ["category"] }];
      });
      expect(mismatch(r)).toEqual([]);
    });

    it("fails with no questions", () => {
      const r = edit(needsInfo(), (d) => {
        d.missingInfo = [];
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails when no single question blocks all requirements", () => {
      const r = edit(needsInfo(), (d) => {
        d.requirements.push({ ...structuredClone(d.requirements[0]!), id: "R2" });
        d.missingInfo = [
          { question: "a?", why: "w", unblocks: ["R1"] },
          { question: "b?", why: "w", unblocks: ["R2"] },
        ];
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with a high-confidence duplicate (precedence: suspected_duplicate)", () => {
      const r = edit(needsInfo(), (d) => {
        d.possibleDuplicates = [{ ticketId: "1042", confidence: "high", reason: "same" }];
      });
      expect(mismatch(r, ["1042"])).toHaveLength(1);
    });
  });

  describe("suspected_duplicate", () => {
    const dup = () =>
      edit(validTriageResult(), (d) => {
        d.disposition = "suspected_duplicate";
        d.possibleDuplicates = [{ ticketId: "1042", confidence: "high", reason: "same" }];
      });

    it("passes with a high-confidence duplicate", () => {
      expect(mismatch(dup(), ["1042"])).toEqual([]);
    });

    it("passes with no requirements when it would otherwise be needs_info (precedence)", () => {
      const r = edit(dup(), (d) => {
        d.requirements = [];
        d.missingInfo = [{ question: "q?", why: "w", unblocks: ["category"] }];
      });
      expect(mismatch(r, ["1042"])).toEqual([]);
    });

    it("fails without a high-confidence duplicate", () => {
      const r = edit(dup(), (d) => {
        d.possibleDuplicates[0]!.confidence = "medium";
      });
      expect(mismatch(r, ["1042"])).toHaveLength(1);
    });
  });

  describe("not_actionable", () => {
    it("passes for an empty ticket with one question", () => {
      const r = edit(notActionableTriageResult(), (d) => {
        d.notActionableReason = "empty";
        d.missingInfo = [{ question: "What do you need help with?", why: "No content.", unblocks: ["category"] }];
      });
      expect(mismatch(r)).toEqual([]);
    });

    it("fails with requirements", () => {
      const r = edit(notActionableTriageResult(), (d) => {
        d.requirements = validTriageResult().requirements;
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with a question when the reason is not empty", () => {
      const r = edit(notActionableTriageResult(), (d) => {
        d.missingInfo = [{ question: "q?", why: "w", unblocks: ["category"] }];
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with two questions even when the reason is empty", () => {
      const r = edit(notActionableTriageResult(), (d) => {
        d.notActionableReason = "empty";
        d.missingInfo = [
          { question: "a?", why: "w", unblocks: ["category"] },
          { question: "b?", why: "w", unblocks: ["category"] },
        ];
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails without a notActionableReason", () => {
      const r = edit(notActionableTriageResult(), (d) => {
        delete d.notActionableReason;
      });
      expect(mismatch(r)).toHaveLength(1);
    });

    it("fails with a suggestedTeam, impact, urgency or priority value", () => {
      const valid = validTriageResult();
      for (const mutate of [
        (d: TriageResult) => (d.suggestedTeam = valid.suggestedTeam),
        (d: TriageResult) => (d.priority.impact = "single_user"),
        (d: TriageResult) => (d.priority.urgency = "degraded"),
        (d: TriageResult) => (d.priority.value = "P3"),
      ]) {
        expect(mismatch(edit(notActionableTriageResult(), mutate))).toHaveLength(1);
      }
    });
  });
});

describe("purity", () => {
  it("returns the same output twice and does not mutate its inputs", () => {
    const result = edit(validTriageResult(), (d) => {
      d.summary = "x".repeat(300);
      d.requirements[0]!.acceptanceCriteria = [];
      d.missingInfo = [{ question: "q?", why: "w", unblocks: [] }];
      d.possibleDuplicates = [{ ticketId: "1", confidence: "high", reason: "r" }];
    });
    const ticket = ticketWithComment();
    const ids = ["2"];
    const [resultCopy, ticketCopy, idsCopy] = structuredClone([result, ticket, ids]);

    const first = validateResult(result, ticket, ids);
    const second = validateResult(result, ticket, ids);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(result).toEqual(resultCopy);
    expect(ticket).toEqual(ticketCopy);
    expect(ids).toEqual(idsCopy);
  });
});
