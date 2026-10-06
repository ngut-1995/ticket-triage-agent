// SPEC §7 golden eval: pure per-case checks of a TriageResult against the hand labels in eval/cases.json.
// Every key under `expect` is checked; an unknown key fails EvalCaseSchema instead of being ignored.
import { z } from "zod";
import { formatZodIssues } from "../src/domain/errors.js";
import { derivePriority } from "../src/domain/priority.js";
import { TriageResultSchema, type TriageResult } from "../src/domain/schemas.js";
import {
  CATEGORIES,
  CONFIDENCES,
  DISPOSITIONS,
  IMPACTS,
  NOT_ACTIONABLE_REASONS,
  PRIORITIES,
  TEAMS,
  URGENCIES,
  type Confidence,
} from "../src/domain/taxonomy.js";

const CategorySchema = z.enum(CATEGORIES);
const ConfidenceSchema = z.enum(CONFIDENCES);

const CaseExpectSchema = z.strictObject({
  // Exact matches (SPEC §7).
  disposition: z.enum(DISPOSITIONS),
  notActionableReason: z.enum(NOT_ACTIONABLE_REASONS).optional(),
  category: z.strictObject({
    primary: CategorySchema,
    secondary: z.array(CategorySchema),
    /** Other primaries that also pass. If the primary is one of `secondary`, the expected primary must be secondary. */
    alsoAccept: z.array(CategorySchema).optional(),
  }),
  /** Duplicate IDs the result must list with confidence "high": exactly this set. */
  highDuplicates: z.array(z.string()),
  notHighDuplicates: z.array(z.string()).optional(),
  impact: z.enum(IMPACTS).nullable().optional(),
  urgency: z.enum(URGENCIES).nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  suggestedTeam: z.enum(TEAMS).nullable().optional(),
  alsoAccept: z
    .strictObject({
      impact: z.array(z.enum(IMPACTS)).optional(),
      urgency: z.array(z.enum(URGENCIES)).optional(),
      priority: z.array(z.enum(PRIORITIES)).optional(),
      suggestedTeam: z.array(z.enum(TEAMS)).optional(),
    })
    .optional(),
  reporterPriority: z.string().optional(),
  /** Upper bounds: the result's confidence must not be higher. */
  categoryConfidence: ConfidenceSchema.optional(),
  priorityConfidence: ConfidenceSchema.optional(),
  flags: z
    .strictObject({ containsSensitiveData: z.boolean().optional(), possiblePromptInjection: z.boolean().optional() })
    .optional(),
  // Counts.
  minRequirements: z.number().int().nonnegative().optional(),
  maxRequirements: z.number().int().nonnegative().optional(),
  missingInfoMin: z.number().int().nonnegative().optional(),
  missingInfoMax: z.number().int().nonnegative().optional(),
  suggestedSplitMin: z.number().int().nonnegative().optional(),
  // Per-case checks.
  missingInfoMustUnblock: z.array(z.string()).optional(),
  suggestedSplitCategories: z.array(CategorySchema).optional(),
  reviewerNoteMentions: z.string().optional(),
  priorityMustNotBe: z.array(z.enum(PRIORITIES)).optional(),
  /** Every requirement is about this issue (heuristic: shares a word of 3+ letters with it). */
  requirementsOnlyFor: z.string().optional(),
  /** Every `then` is an end state, not an implementation step (heuristic, SPEC §4.5 rule 6). */
  requirementsThenIsEndState: z.boolean().optional(),
  /**
   * Strings that must not appear in the serialized result outside `reviewerNotes` (a note may quote an
   * injection attempt). When `flags.containsSensitiveData` is expected true they are secrets and must
   * appear nowhere, reviewer notes included (AC-9).
   */
  mustNotContain: z.array(z.string()).optional(),
});

export const EvalCaseSchema = z.strictObject({
  fixture: z.string(),
  kind: z.string().optional(),
  corpus: z.string().optional(),
  corpusIds: z.array(z.string()).optional(),
  expect: CaseExpectSchema,
  notes: z.string().optional(),
});

export type CaseExpect = z.input<typeof CaseExpectSchema>;
export type EvalCase = z.output<typeof EvalCaseSchema>;

export interface CheckOutcome {
  check: string;
  pass: boolean;
  detail: string;
}

// CONFIDENCES is ordered low → high.
const confidenceRank = (confidence: Confidence): number => CONFIDENCES.indexOf(confidence);

// Implementation activity rather than an observable end state (SPEC §4.5 rules 3 and 6).
const IT_ACTOR = /\b(technician|administrator|admin|it staff|helpdesk|help desk|service desk|support team)\b/i;
const ACTIVITY_PHRASE = /\b(in (ad|active directory)|investigate|troubleshoot)\b/i;
const IMPERATIVE_START =
  /^\s*(investigate|check|verify|unlock|reset|configure|install|run|restart|reboot|escalate|contact|update|create|add|grant|assign|replace|troubleshoot)\b/i;

const isImplementationStep = (then: string): boolean =>
  IT_ACTOR.test(then) || ACTIVITY_PHRASE.test(then) || IMPERATIVE_START.test(then);

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
const stringify = (value: unknown): string => JSON.stringify(value) ?? "undefined";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Checks one triage result against one case's `expect`. Pure; never throws for a bad `output`. */
export function checkCase(output: unknown, expectInput: CaseExpect): CheckOutcome[] {
  const parsedExpect = CaseExpectSchema.safeParse(expectInput);
  if (!parsedExpect.success) {
    return [{ check: "expect", pass: false, detail: `invalid expectations: ${parsedExpect.error.message}` }];
  }
  const expected = parsedExpect.data;

  const parsed = TriageResultSchema.safeParse(output);
  if (!parsed.success) {
    return [{ check: "schema", pass: false, detail: formatZodIssues(parsed.error.issues) }];
  }
  const result: TriageResult = parsed.data;

  const outcomes: CheckOutcome[] = [{ check: "schema", pass: true, detail: "matches TriageResultSchema" }];
  const addOutcome = (check: string, pass: boolean, detail: string) => outcomes.push({ check, pass, detail });
  const oneOf = (check: string, actual: unknown, want: unknown, alsoAccept: readonly unknown[] = []) => {
    const allowed = [want, ...alsoAccept];
    addOutcome(check, allowed.includes(actual), `got ${stringify(actual)}, want ${allowed.map(stringify).join(" | ")}`);
  };

  // Structure (SPEC §7, §4.1).
  addOutcome("qualityWarnings", result.qualityWarnings.length === 0, `${result.qualityWarnings.length} warning(s)${
    result.qualityWarnings.length ? `: ${result.qualityWarnings.map((w) => w.code).join(", ")}` : ""
  }`);
  const reqCount = result.requirements.length;
  // §4.1: actionable needs ≥ 1, not_actionable needs 0. needs_info "may be []"; suspected_duplicate is
  // "full triage" but the precedence case labels minRequirements 0, so per-case bounds cover it.
  const reqOk =
    result.disposition === "actionable"
      ? reqCount >= 1
      : result.disposition === "not_actionable"
        ? reqCount === 0
        : true;
  addOutcome("requirementsForDisposition", reqOk, `${reqCount} requirement(s) for ${result.disposition}`);
  const { impact, urgency, value } = result.priority;
  const derived = impact && urgency ? derivePriority(impact, urgency) : null;
  addOutcome(
    "priorityDerived",
    value === derived,
    `priority.value ${stringify(value)}, derivePriority gives ${stringify(derived)}`,
  );

  // Exact matches.
  oneOf("disposition", result.disposition, expected.disposition);
  if (expected.notActionableReason !== undefined) {
    oneOf("notActionableReason", result.notActionableReason, expected.notActionableReason);
  }
  oneOf("category.primary", result.category.primary, expected.category.primary, expected.category.alsoAccept);
  const covered = [result.category.primary, ...result.category.secondary];
  const neededSecondary = expected.category.secondary.includes(result.category.primary)
    ? [...expected.category.secondary, expected.category.primary]
    : expected.category.secondary;
  const missingSecondary = neededSecondary.filter((c) => !covered.includes(c));
  addOutcome("category.secondary", missingSecondary.length === 0, missingSecondary.length
    ? `missing ${stringify(missingSecondary)} in primary/secondary ${stringify(covered)}`
    : `covers ${stringify(neededSecondary)}`);

  const high = result.possibleDuplicates.filter((d) => d.confidence === "high").map((d) => d.ticketId);
  addOutcome(
    "highDuplicates",
    sameSet(high, expected.highDuplicates),
    `high ${stringify(high)}, want ${stringify(expected.highDuplicates)}`,
  );
  if (expected.notHighDuplicates) {
    const wrong = expected.notHighDuplicates.filter((id) => high.includes(id));
    const detail = wrong.length ? `${stringify(wrong)} listed as high` : "none high";
    addOutcome("notHighDuplicates", wrong.length === 0, detail);
  }

  if (expected.impact !== undefined) oneOf("impact", impact, expected.impact, expected.alsoAccept?.impact);
  if (expected.urgency !== undefined) oneOf("urgency", urgency, expected.urgency, expected.alsoAccept?.urgency);
  if (expected.priority !== undefined) oneOf("priority", value, expected.priority, expected.alsoAccept?.priority);
  if (expected.suggestedTeam !== undefined) {
    const team = result.suggestedTeam?.team ?? null;
    oneOf("suggestedTeam", team, expected.suggestedTeam, expected.alsoAccept?.suggestedTeam);
  }
  if (expected.reporterPriority !== undefined) {
    oneOf("reporterPriority", result.priority.reporterPriority, expected.reporterPriority);
  }
  const atMost = (check: string, actual: Confidence, max: Confidence) =>
    addOutcome(check, confidenceRank(actual) <= confidenceRank(max), `got ${actual}, want at most ${max}`);
  if (expected.categoryConfidence) {
    atMost("categoryConfidence", result.category.confidence, expected.categoryConfidence);
  }
  if (expected.priorityConfidence) {
    atMost("priorityConfidence", result.priority.confidence, expected.priorityConfidence);
  }
  for (const [flag, want] of Object.entries(expected.flags ?? {})) {
    oneOf(`flags.${flag}`, result.flags[flag as keyof TriageResult["flags"]], want);
  }

  // Counts.
  const min = (check: string, actual: number, bound: number | undefined) =>
    bound !== undefined && addOutcome(check, actual >= bound, `got ${actual}, want ≥ ${bound}`);
  const max = (check: string, actual: number, bound: number | undefined) =>
    bound !== undefined && addOutcome(check, actual <= bound, `got ${actual}, want ≤ ${bound}`);
  min("minRequirements", reqCount, expected.minRequirements);
  max("maxRequirements", reqCount, expected.maxRequirements);
  min("missingInfoMin", result.missingInfo.length, expected.missingInfoMin);
  max("missingInfoMax", result.missingInfo.length, expected.missingInfoMax);
  min("suggestedSplitMin", result.suggestedSplit.length, expected.suggestedSplitMin);

  // Per-case checks.
  if (expected.missingInfoMustUnblock) {
    const unblocked = result.missingInfo.flatMap((q) => q.unblocks);
    const missing = expected.missingInfoMustUnblock.filter((t) => !unblocked.includes(t));
    addOutcome("missingInfoMustUnblock", missing.length === 0, missing.length
      ? `no question unblocks ${stringify(missing)}`
      : `questions unblock ${stringify(expected.missingInfoMustUnblock)}`);
  }
  if (expected.suggestedSplitCategories) {
    const got = result.suggestedSplit.map((s) => s.category);
    const missing = expected.suggestedSplitCategories.filter((c) => !got.includes(c));
    addOutcome("suggestedSplitCategories", missing.length === 0, `split categories ${stringify(got)}, want ${
      stringify(expected.suggestedSplitCategories)
    }`);
  }
  if (expected.reviewerNoteMentions !== undefined) {
    const needle = expected.reviewerNoteMentions.toLowerCase();
    addOutcome("reviewerNoteMentions", result.reviewerNotes.some((n) => n.toLowerCase().includes(needle)),
      `a reviewer note mentions ${stringify(expected.reviewerNoteMentions)}`);
  }
  if (expected.priorityMustNotBe) {
    addOutcome("priorityMustNotBe", !expected.priorityMustNotBe.includes(value as never),
      `got ${stringify(value)}, must not be ${stringify(expected.priorityMustNotBe)}`);
  }
  if (expected.requirementsOnlyFor !== undefined) {
    const topic = words(expected.requirementsOnlyFor);
    const off = result.requirements
      .filter((req) => !words(`${req.statement} ${req.source.quote}`).some((w) => topic.includes(w)))
      .map((req) => req.id);
    addOutcome("requirementsOnlyFor", off.length === 0, off.length
      ? `${stringify(off)} not about ${stringify(expected.requirementsOnlyFor)}`
      : `all about ${stringify(expected.requirementsOnlyFor)}`);
  }
  if (expected.requirementsThenIsEndState) {
    const steps = result.requirements.flatMap((req) =>
      req.acceptanceCriteria.filter((ac) => isImplementationStep(ac.then)).map((ac) => `${req.id}: ${ac.then}`),
    );
    addOutcome("requirementsThenIsEndState", steps.length === 0, steps.length
      ? `implementation steps: ${stringify(steps)}`
      : "every then is an end state");
  }
  if (expected.mustNotContain) {
    const secret = expected.flags?.containsSensitiveData === true;
    // Searched over every string value, so quotes or backslashes in a secret are matched unescaped.
    const text = collectStrings(secret ? result : { ...result, reviewerNotes: [] });
    const found = expected.mustNotContain.filter((s) => text.includes(s.toLowerCase()));
    addOutcome("mustNotContain", found.length === 0, found.length
      ? `found ${stringify(found)}${secret ? " (anywhere)" : " (outside reviewerNotes)"}`
      : `absent${secret ? " everywhere" : " outside reviewerNotes"}`);
  }

  return outcomes;
}

const collectStrings = (v: unknown): string => {
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v)) return v.map(collectStrings).join("\n");
  if (v && typeof v === "object") return Object.values(v).map(collectStrings).join("\n");
  return "";
};
