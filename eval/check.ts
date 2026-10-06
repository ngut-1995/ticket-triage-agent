// SPEC §7 golden eval: pure per-case checks of a TriageResult against the hand labels in eval/cases.json.
// Every key under `expect` is checked; an unknown key fails EvalCaseSchema instead of being ignored.
import { z } from "zod";
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
} from "../src/domain/taxonomy.js";

const Category = z.enum(CATEGORIES);
const Confidence = z.enum(CONFIDENCES);

const CaseExpectSchema = z.strictObject({
  // Exact matches (SPEC §7).
  disposition: z.enum(DISPOSITIONS),
  notActionableReason: z.enum(NOT_ACTIONABLE_REASONS).optional(),
  category: z.strictObject({
    primary: Category,
    secondary: z.array(Category),
    /** Other primaries that also pass. If the primary is one of `secondary`, the expected primary must be secondary. */
    alsoAccept: z.array(Category).optional(),
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
  categoryConfidence: Confidence.optional(),
  priorityConfidence: Confidence.optional(),
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
  suggestedSplitCategories: z.array(Category).optional(),
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

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

// Implementation activity rather than an observable end state (SPEC §4.5 rules 3 and 6).
const IT_ACTOR = /\b(technician|administrator|admin|it staff|helpdesk|help desk|service desk|support team)\b/i;
const ACTIVITY_PHRASE = /\b(in (ad|active directory)|investigate|troubleshoot)\b/i;
const IMPERATIVE_START =
  /^\s*(investigate|check|verify|unlock|reset|configure|install|run|restart|reboot|escalate|contact|update|create|add|grant|assign|replace|troubleshoot)\b/i;

const isImplementationStep = (then: string): boolean =>
  IT_ACTOR.test(then) || ACTIVITY_PHRASE.test(then) || IMPERATIVE_START.test(then);

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Checks one triage result against one case's `expect`. Pure; never throws for a bad `result`. */
export function checkCase(result: unknown, expectInput: CaseExpect): CheckOutcome[] {
  const parsedExpect = CaseExpectSchema.safeParse(expectInput);
  if (!parsedExpect.success) {
    return [{ check: "expect", pass: false, detail: `invalid expectations: ${parsedExpect.error.message}` }];
  }
  const exp = parsedExpect.data;

  const parsed = TriageResultSchema.safeParse(result);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return [{ check: "schema", pass: false, detail: issues }];
  }
  const r: TriageResult = parsed.data;

  const out: CheckOutcome[] = [{ check: "schema", pass: true, detail: "matches TriageResultSchema" }];
  const add = (check: string, pass: boolean, detail: string) => out.push({ check, pass, detail });
  const oneOf = (check: string, actual: unknown, expected: unknown, alsoAccept: readonly unknown[] = []) => {
    const allowed = [expected, ...alsoAccept];
    add(check, allowed.includes(actual), `got ${show(actual)}, want ${allowed.map(show).join(" | ")}`);
  };

  // Structure (SPEC §7, §4.1).
  add("qualityWarnings", r.qualityWarnings.length === 0, `${r.qualityWarnings.length} warning(s)${
    r.qualityWarnings.length ? `: ${r.qualityWarnings.map((w) => w.code).join(", ")}` : ""
  }`);
  const reqCount = r.requirements.length;
  // §4.1: actionable needs ≥ 1, not_actionable needs 0. needs_info "may be []"; suspected_duplicate is
  // "full triage" but the precedence case labels minRequirements 0, so per-case bounds cover it.
  const reqOk =
    r.disposition === "actionable" ? reqCount >= 1 : r.disposition === "not_actionable" ? reqCount === 0 : true;
  add("requirementsForDisposition", reqOk, `${reqCount} requirement(s) for ${r.disposition}`);
  const { impact, urgency, value } = r.priority;
  const derived = impact && urgency ? derivePriority(impact, urgency) : null;
  add("priorityDerived", value === derived, `priority.value ${show(value)}, derivePriority gives ${show(derived)}`);

  // Exact matches.
  oneOf("disposition", r.disposition, exp.disposition);
  if (exp.notActionableReason !== undefined) {
    oneOf("notActionableReason", r.notActionableReason, exp.notActionableReason);
  }
  oneOf("category.primary", r.category.primary, exp.category.primary, exp.category.alsoAccept);
  const covered = [r.category.primary, ...r.category.secondary];
  const neededSecondary = exp.category.secondary.includes(r.category.primary)
    ? [...exp.category.secondary, exp.category.primary]
    : exp.category.secondary;
  const missingSecondary = neededSecondary.filter((c) => !covered.includes(c));
  add("category.secondary", missingSecondary.length === 0, missingSecondary.length
    ? `missing ${show(missingSecondary)} in primary/secondary ${show(covered)}`
    : `covers ${show(neededSecondary)}`);

  const high = r.possibleDuplicates.filter((d) => d.confidence === "high").map((d) => d.ticketId);
  add("highDuplicates", sameSet(high, exp.highDuplicates), `high ${show(high)}, want ${show(exp.highDuplicates)}`);
  if (exp.notHighDuplicates) {
    const wrong = exp.notHighDuplicates.filter((id) => high.includes(id));
    add("notHighDuplicates", wrong.length === 0, wrong.length ? `${show(wrong)} listed as high` : "none high");
  }

  if (exp.impact !== undefined) oneOf("impact", impact, exp.impact, exp.alsoAccept?.impact);
  if (exp.urgency !== undefined) oneOf("urgency", urgency, exp.urgency, exp.alsoAccept?.urgency);
  if (exp.priority !== undefined) oneOf("priority", value, exp.priority, exp.alsoAccept?.priority);
  if (exp.suggestedTeam !== undefined) {
    oneOf("suggestedTeam", r.suggestedTeam?.team ?? null, exp.suggestedTeam, exp.alsoAccept?.suggestedTeam);
  }
  if (exp.reporterPriority !== undefined) {
    oneOf("reporterPriority", r.priority.reporterPriority, exp.reporterPriority);
  }
  const atMost = (check: string, actual: keyof typeof CONFIDENCE_RANK, max: keyof typeof CONFIDENCE_RANK) =>
    add(check, CONFIDENCE_RANK[actual] <= CONFIDENCE_RANK[max], `got ${actual}, want at most ${max}`);
  if (exp.categoryConfidence) atMost("categoryConfidence", r.category.confidence, exp.categoryConfidence);
  if (exp.priorityConfidence) atMost("priorityConfidence", r.priority.confidence, exp.priorityConfidence);
  for (const [flag, want] of Object.entries(exp.flags ?? {})) {
    oneOf(`flags.${flag}`, r.flags[flag as keyof TriageResult["flags"]], want);
  }

  // Counts.
  const min = (check: string, actual: number, bound: number | undefined) =>
    bound !== undefined && add(check, actual >= bound, `got ${actual}, want ≥ ${bound}`);
  const max = (check: string, actual: number, bound: number | undefined) =>
    bound !== undefined && add(check, actual <= bound, `got ${actual}, want ≤ ${bound}`);
  min("minRequirements", reqCount, exp.minRequirements);
  max("maxRequirements", reqCount, exp.maxRequirements);
  min("missingInfoMin", r.missingInfo.length, exp.missingInfoMin);
  max("missingInfoMax", r.missingInfo.length, exp.missingInfoMax);
  min("suggestedSplitMin", r.suggestedSplit.length, exp.suggestedSplitMin);

  // Per-case checks.
  if (exp.missingInfoMustUnblock) {
    const unblocked = r.missingInfo.flatMap((q) => q.unblocks);
    const missing = exp.missingInfoMustUnblock.filter((t) => !unblocked.includes(t));
    add("missingInfoMustUnblock", missing.length === 0, missing.length
      ? `no question unblocks ${show(missing)}`
      : `questions unblock ${show(exp.missingInfoMustUnblock)}`);
  }
  if (exp.suggestedSplitCategories) {
    const got = r.suggestedSplit.map((s) => s.category);
    const missing = exp.suggestedSplitCategories.filter((c) => !got.includes(c));
    add("suggestedSplitCategories", missing.length === 0, `split categories ${show(got)}, want ${
      show(exp.suggestedSplitCategories)
    }`);
  }
  if (exp.reviewerNoteMentions !== undefined) {
    const needle = exp.reviewerNoteMentions.toLowerCase();
    add("reviewerNoteMentions", r.reviewerNotes.some((n) => n.toLowerCase().includes(needle)),
      `a reviewer note mentions ${show(exp.reviewerNoteMentions)}`);
  }
  if (exp.priorityMustNotBe) {
    add("priorityMustNotBe", !exp.priorityMustNotBe.includes(value as never),
      `got ${show(value)}, must not be ${show(exp.priorityMustNotBe)}`);
  }
  if (exp.requirementsOnlyFor !== undefined) {
    const topic = words(exp.requirementsOnlyFor);
    const off = r.requirements
      .filter((req) => !words(`${req.statement} ${req.source.quote}`).some((w) => topic.includes(w)))
      .map((req) => req.id);
    add("requirementsOnlyFor", off.length === 0, off.length
      ? `${show(off)} not about ${show(exp.requirementsOnlyFor)}`
      : `all about ${show(exp.requirementsOnlyFor)}`);
  }
  if (exp.requirementsThenIsEndState) {
    const steps = r.requirements.flatMap((req) =>
      req.acceptanceCriteria.filter((ac) => isImplementationStep(ac.then)).map((ac) => `${req.id}: ${ac.then}`),
    );
    add("requirementsThenIsEndState", steps.length === 0, steps.length
      ? `implementation steps: ${show(steps)}`
      : "every then is an end state");
  }
  if (exp.mustNotContain) {
    const secret = exp.flags?.containsSensitiveData === true;
    // Searched over every string value, so quotes or backslashes in a secret are matched unescaped.
    const text = collectStrings(secret ? r : { ...r, reviewerNotes: [] });
    const found = exp.mustNotContain.filter((s) => text.includes(s.toLowerCase()));
    add("mustNotContain", found.length === 0, found.length
      ? `found ${show(found)}${secret ? " (anywhere)" : " (outside reviewerNotes)"}`
      : `absent${secret ? " everywhere" : " outside reviewerNotes"}`);
  }

  return out;
}

const collectStrings = (v: unknown): string => {
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v)) return v.map(collectStrings).join("\n");
  if (v && typeof v === "object") return Object.values(v).map(collectStrings).join("\n");
  return "";
};
