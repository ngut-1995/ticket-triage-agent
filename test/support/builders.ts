// Valid outputs for fixtures/tickets/bug-clear.json (ticket 3001).
// Quotes are verbatim from that fixture so validator tests can rely on them.
import { readFileSync } from "node:fs";
import type { LlmTriageOutput, Ticket, TriageResult } from "../../src/domain/schemas.js";

const root = new URL("../../", import.meta.url);
export const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));

export const bugClearTicket = (): Ticket => readJson("fixtures/tickets/bug-clear.json") as Ticket;

export const validLlmOutput = (): LlmTriageOutput => ({
  disposition: "actionable",
  summary: "Exporting the Monthly Revenue chart in Insight to Excel crashes the Chrome tab for date ranges over 3 months.",
  category: {
    primary: "software_bug",
    secondary: [],
    confidence: "high",
    rationale: "Reproducible crash in an internal app with clear steps.",
  },
  priority: {
    impact: "single_user",
    urgency: "degraded",
    confidence: "high",
    evidence: ["The tab crashes after about 3 seconds", "I'm taking screenshots for the board deck for now"],
  },
  suggestedTeam: { team: "apps", rationale: "Insight is an internal application." },
  suggestedSplit: [],
  possibleDuplicates: [],
  missingInfo: [],
  requirements: [
    {
      id: "R1",
      statement: "Exporting the Monthly Revenue chart to Excel for Jan 2026 - Sep 2026 produces an .xlsx file.",
      source: { quote: "Click the chart menu (three dots) > Export > Excel (.xlsx)", field: "body" },
      acceptanceCriteria: [
        {
          given: "Insight > Sales > Monthly Revenue with date range Jan 2026 - Sep 2026 in Chrome 141 on Windows 11",
          when: "the user clicks Export > Excel (.xlsx)",
          then: "an .xlsx file downloads and the tab does not crash",
        },
      ],
      assumptions: [],
    },
  ],
  flags: { containsSensitiveData: false, possiblePromptInjection: false },
  reviewerNotes: [],
});

export const validTriageResult = (): TriageResult => {
  const llm = validLlmOutput();
  return {
    ...llm,
    ticketId: "3001",
    reviewStatus: "pending_review",
    priority: { ...llm.priority, value: "P3" },
    suggestedTeam: { team: "apps", rationale: "Insight is an internal application.", overridesDefault: false },
    qualityWarnings: [],
    meta: { model: "claude-sonnet-5-5", promptVersion: "test", repairAttempted: false, durationMs: 0 },
  };
};

export const notActionableLlmOutput = (): LlmTriageOutput => ({
  ...validLlmOutput(),
  disposition: "not_actionable",
  notActionableReason: "auto_reply",
  summary: "Out-of-office auto-reply.",
  category: { primary: "other", secondary: [], confidence: "low", rationale: "Automatic reply, no request." },
  priority: { impact: null, urgency: null, confidence: "low", evidence: [] },
  suggestedTeam: null,
  requirements: [],
});

export const notActionableTriageResult = (): TriageResult => {
  const llm = notActionableLlmOutput();
  return {
    ...validTriageResult(),
    ...llm,
    priority: { ...llm.priority, value: null },
    suggestedTeam: null,
  };
};
