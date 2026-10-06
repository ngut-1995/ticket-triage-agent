// SPEC §6.2. Orchestrates one triage: validate input, prompt, parse, derive, validate, repair once.
import type { z } from "zod";
import { derivePriority } from "./domain/priority.js";
import {
  LlmTriageOutputSchema,
  TicketSchema,
  type LlmTriageOutput,
  type QualityWarning,
  type Ticket,
  type TriageResult,
} from "./domain/schemas.js";
import { DEFAULT_TEAM } from "./domain/taxonomy.js";
import { prefilterCandidates } from "./duplicates/prefilter.js";
import type { LLMClient, StructuredResponse } from "./llm/client.js";
import { buildRepairPrompt, buildTriagePrompt, PROMPT_VERSION, type RepairIssue } from "./prompt/build.js";
import { validateResult } from "./quality/validate.js";

export interface TriageDeps {
  llm: LLMClient;
  corpus?: Ticket[];
  /** Clock for meta.durationMs (ms). Defaults to Date.now. */
  now?: () => number;
}

type ZodIssue = z.core.$ZodIssue;

const formatPath = (issue: ZodIssue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)");
const formatIssues = (issues: ZodIssue[]): string => issues.map((i) => `${formatPath(i)}: ${i.message}`).join("; ");

/** The input is not a valid Ticket (SPEC §3.1). Thrown before any LLM call. */
export class TicketValidationError extends Error {
  readonly issues: ZodIssue[];

  constructor(issues: ZodIssue[]) {
    super(`Invalid ticket: ${formatIssues(issues)}`);
    this.name = "TicketValidationError";
    this.issues = issues;
  }
}

/** The LLM output still does not match LlmTriageOutputSchema after the repair call (SPEC §5). */
export class TriageOutputError extends Error {
  readonly issues: ZodIssue[];
  /** The last raw output that failed to parse. */
  readonly output: unknown;

  constructor(issues: ZodIssue[], output: unknown) {
    super(`LLM output does not match the triage schema after repair: ${formatIssues(issues)}`);
    this.name = "TriageOutputError";
    this.issues = issues;
    this.output = output;
  }
}

type Attempt =
  | { ok: true; result: TriageResult; warnings: QualityWarning[] }
  | { ok: false; issues: ZodIssue[] };

export async function triageTicket(input: unknown, deps: TriageDeps): Promise<TriageResult> {
  const now = deps.now ?? Date.now;
  const start = now();

  const parsed = TicketSchema.safeParse(input);
  if (!parsed.success) throw new TicketValidationError(parsed.error.issues);
  const ticket = parsed.data;

  const candidates = deps.corpus ? prefilterCandidates(ticket, deps.corpus).map((c) => c.ticket) : [];
  const candidateIds = candidates.map((c) => c.id);

  const evaluate = (response: StructuredResponse): Attempt => {
    const llm = LlmTriageOutputSchema.safeParse(response.output);
    if (!llm.success) return { ok: false, issues: llm.error.issues };
    const result = toResult(llm.data, ticket, candidateIds.length > 0, response.model);
    return { ok: true, result, warnings: validateResult(result, ticket, candidateIds) };
  };
  const finish = (result: TriageResult, warnings: QualityWarning[], repairAttempted: boolean): TriageResult => ({
    ...result,
    qualityWarnings: warnings,
    meta: { ...result.meta, repairAttempted, durationMs: now() - start },
  });

  const request = buildTriagePrompt(ticket, candidates);
  const firstResponse = await deps.llm.generateStructured(request);
  const first = evaluate(firstResponse);
  if (first.ok && first.warnings.length === 0) return finish(first.result, [], false);

  // SPEC §5: exactly one repair call, with quality warnings or zod issues as the problems to fix.
  const problems: RepairIssue[] = first.ok
    ? first.warnings
    : first.issues.map((i) => ({ code: "SCHEMA_INVALID", message: `${formatPath(i)}: ${i.message}` }));
  const repairResponse = await deps.llm.generateStructured(
    buildRepairPrompt(request, firstResponse.output, problems),
  );
  const repaired = evaluate(repairResponse);
  if (repaired.ok) return finish(repaired.result, repaired.warnings, true);
  // A structurally valid first output beats throwing: its warnings are surfaced instead.
  if (first.ok) return finish(first.result, first.warnings, true);
  throw new TriageOutputError(repaired.issues, repairResponse.output);
}

// SPEC §6.2 step 5: the fields computed in code (never trusted from the LLM). Everything else, including a null
// suggestedTeam or a stray notActionableReason, passes through so validateResult reports DISPOSITION_MISMATCH and
// the repair call can fix it. The one exception: not_actionable always gets suggestedTeam null (SPEC §3.3).
function toResult(llm: LlmTriageOutput, ticket: Ticket, candidatesSent: boolean, model: string): TriageResult {
  const notActionable = llm.disposition === "not_actionable";
  const { impact, urgency } = llm.priority;
  const team = llm.suggestedTeam;
  return {
    ...llm,
    ticketId: ticket.id,
    reviewStatus: "pending_review",
    priority: {
      ...llm.priority,
      value: !notActionable && impact && urgency ? derivePriority(impact, urgency) : null,
      ...(ticket.reporterPriority === undefined ? {} : { reporterPriority: ticket.reporterPriority }),
    },
    suggestedTeam:
      notActionable || team === null
        ? null
        : { ...team, overridesDefault: team.team !== DEFAULT_TEAM[llm.category.primary] },
    // SPEC §4.3 step 4: with no candidates sent there is no duplicate reasoning.
    possibleDuplicates: candidatesSent ? llm.possibleDuplicates : [],
    qualityWarnings: [],
    meta: { model, promptVersion: PROMPT_VERSION, repairAttempted: false, durationMs: 0 },
  };
}
