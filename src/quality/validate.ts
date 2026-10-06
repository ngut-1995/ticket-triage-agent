// SPEC §5 quality validator. Pure and deterministic: it reports problems and never mutates its inputs.
import type { QualityRuleCode, QualityWarning, Requirement, Ticket, TriageResult } from "../domain/schemas.js";
import { UNBLOCK_FIELDS, VAGUE_TERMS } from "../domain/taxonomy.js";

// SPEC §6 lists VAGUE_TERMS here; it is defined with the rest of the taxonomy.
export { VAGUE_TERMS };

const MAX_SUMMARY_CHARS = 280;
const MAX_QUESTIONS = 5;
const UNBLOCK_FIELD_SET: ReadonlySet<string> = new Set(UNBLOCK_FIELDS);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Boundaries treat letters, digits, "_" and "-" as word characters, so "fast" does not match "breakfast" and
// "user-friendly" is one term.
const VAGUE_PATTERNS = VAGUE_TERMS.map(
  (term) => [term, new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`, "gi")] as const,
);
// SPEC §4.5 rule 4: a term is fine when its clause carries a measurable qualifier (a number). A clause runs to the
// nearest ".", ";", "," or newline on either side. "etc." and "and/or" have no exemption.
const NO_QUALIFIER_EXEMPTION: ReadonlySet<string> = new Set(["etc.", "and/or"]);
const CLAUSE_BREAK = /[.;,\n]/;
const HAS_NUMBER = /\d/;

const clauseAround = (text: string, start: number, end: number): string => {
  let from = start;
  while (from > 0 && !CLAUSE_BREAK.test(text[from - 1]!)) from--;
  let to = end;
  while (to < text.length && !CLAUSE_BREAK.test(text[to]!)) to++;
  return text.slice(from, to);
};

/** True when `text` uses `term` at least once without a measurable qualifier in the same clause. */
const usesVagueTerm = (text: string, term: string, pattern: RegExp): boolean =>
  [...text.matchAll(pattern)].some(
    (m) =>
      NO_QUALIFIER_EXEMPTION.has(term) || !HAS_NUMBER.test(clauseAround(text, m.index, m.index + m[0].length)),
  );

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const contains = (haystacks: string[], quote: string): boolean => {
  const needle = normalize(quote);
  // An empty quote is a substring of everything, so it traces to nothing.
  return needle !== "" && haystacks.some((h) => normalize(h).includes(needle));
};

const fieldTexts = (ticket: Ticket, field: Requirement["source"]["field"]): string[] => {
  if (field === "title") return [ticket.title];
  if (field === "body") return [ticket.body];
  return (ticket.comments ?? []).map((c) => c.body);
};

export function validateResult(result: TriageResult, ticket: Ticket, candidateIds: string[] = []): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const warn = (code: QualityRuleCode, message: string, requirementId?: string) =>
    warnings.push(requirementId === undefined ? { code, message } : { code, requirementId, message });

  const allTexts = [ticket.title, ticket.body, ...(ticket.comments ?? []).map((c) => c.body)];
  const requirementIds = new Set(result.requirements.map((r) => r.id));

  // Per-requirement rules.
  const seenIds = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const req of result.requirements) {
    if (seenIds.has(req.id) && !reportedDuplicates.has(req.id)) {
      reportedDuplicates.add(req.id);
      warn("DUPLICATE_REQ_ID", `Requirement ID "${req.id}" is used more than once.`, req.id);
    }
    seenIds.add(req.id);

    if (!contains(fieldTexts(ticket, req.source.field), req.source.quote)) {
      warn(
        "QUOTE_NOT_FOUND",
        `source.quote "${req.source.quote}" is not a verbatim substring of the ticket ${req.source.field}.`,
        req.id,
      );
    }

    if (req.acceptanceCriteria.length === 0) {
      warn("NO_ACCEPTANCE_CRITERIA", `Requirement ${req.id} has no acceptance criteria.`, req.id);
    }

    const texts = [
      ["statement", req.statement],
      ...req.acceptanceCriteria.map((ac, i) => [`acceptanceCriteria[${i}].then`, ac.then] as const),
    ] as const;
    for (const [where, text] of texts) {
      for (const [term, pattern] of VAGUE_PATTERNS) {
        if (usesVagueTerm(text, term, pattern)) {
          warn("VAGUE_TERM", `Requirement ${req.id} ${where} uses the vague term "${term}".`, req.id);
        }
      }
    }
  }

  result.priority.evidence.forEach((quote, i) => {
    if (!contains(allTexts, quote)) {
      warn("QUOTE_NOT_FOUND", `priority.evidence[${i}] "${quote}" is not a verbatim substring of the ticket.`);
    }
  });

  // Missing-info questions.
  result.missingInfo.forEach((q, i) => {
    if (q.unblocks.length === 0) {
      warn("UNBLOCKS_NOTHING", `missingInfo[${i}] ("${q.question}") has an empty unblocks.`);
    }
    for (const target of q.unblocks) {
      if (!UNBLOCK_FIELD_SET.has(target) && !requirementIds.has(target)) {
        warn("DANGLING_UNBLOCKS", `missingInfo[${i}] unblocks "${target}", which is not a requirement ID.`, target);
      }
    }
  });
  if (result.missingInfo.length > MAX_QUESTIONS) {
    warn("TOO_MANY_QUESTIONS", `missingInfo has ${result.missingInfo.length} questions (max ${MAX_QUESTIONS}).`);
  }

  const candidates = new Set(candidateIds);
  for (const dup of result.possibleDuplicates) {
    if (!candidates.has(dup.ticketId)) {
      warn("UNKNOWN_DUPLICATE_ID", `possibleDuplicates lists ticket ${dup.ticketId}, which was not a candidate.`);
    }
  }

  const summaryLength = [...result.summary].length;
  if (summaryLength > MAX_SUMMARY_CHARS) {
    warn("SUMMARY_TOO_LONG", `summary is ${summaryLength} chars (max ${MAX_SUMMARY_CHARS}).`);
  }

  for (const message of dispositionMismatches(result)) warn("DISPOSITION_MISMATCH", message);

  return warnings;
}

// SPEC §4.1 table, precedence and the not_actionable invariants. One message per violated rule.
function dispositionMismatches(result: TriageResult): string[] {
  const { disposition, requirements, missingInfo } = result;
  const problems: string[] = [];
  const hasHighDuplicate = result.possibleDuplicates.some((d) => d.confidence === "high");
  const reqIds = requirements.map((r) => r.id);
  // "A question blocking all requirements" (SPEC §4.1).
  const blocksAll = (unblocks: string[]) =>
    reqIds.length === 0 ? unblocks.length > 0 : reqIds.every((id) => unblocks.includes(id));
  const everyRequirementBlocked =
    reqIds.length > 0 && reqIds.every((id) => missingInfo.some((q) => q.unblocks.includes(id)));

  if (disposition === "not_actionable") {
    if (result.notActionableReason === undefined) problems.push("not_actionable requires a notActionableReason.");
    if (requirements.length > 0) problems.push("not_actionable must have no requirements.");
    const maxQuestions = result.notActionableReason === "empty" ? 1 : 0;
    if (missingInfo.length > maxQuestions) {
      problems.push(
        `not_actionable (${result.notActionableReason ?? "no reason"}) allows at most ${maxQuestions} missingInfo question(s).`,
      );
    }
    if (result.suggestedTeam !== null) problems.push("not_actionable must have suggestedTeam null.");
    if (result.priority.impact !== null || result.priority.urgency !== null) {
      problems.push("not_actionable must have null priority.impact and priority.urgency.");
    }
    if (result.priority.value !== null) problems.push("not_actionable must have priority.value null.");
    return problems;
  }

  if (result.notActionableReason !== undefined) {
    problems.push(`notActionableReason is only allowed when disposition is not_actionable, not ${disposition}.`);
  }
  if (result.suggestedTeam === null) problems.push(`${disposition} requires a suggestedTeam.`);
  if (result.priority.impact === null || result.priority.urgency === null) {
    problems.push(`${disposition} requires priority.impact and priority.urgency.`);
  }
  if (result.priority.value === null) problems.push(`${disposition} requires a priority.value.`);

  if (disposition === "suspected_duplicate") {
    if (!hasHighDuplicate) problems.push("suspected_duplicate requires a possible duplicate with high confidence.");
    return problems;
  }

  // actionable / needs_info: a high-confidence duplicate takes precedence.
  if (hasHighDuplicate) {
    problems.push(`${disposition} has a high-confidence duplicate; precedence makes it suspected_duplicate.`);
  }
  if (disposition === "needs_info") {
    if (missingInfo.length === 0) problems.push("needs_info requires at least one missingInfo question.");
    else if (!missingInfo.some((q) => blocksAll(q.unblocks))) {
      problems.push("needs_info requires at least one question that blocks all requirements.");
    }
  } else {
    if (requirements.length === 0) problems.push("actionable requires at least one requirement.");
    if (everyRequirementBlocked) {
      problems.push("actionable has every requirement blocked by a question; that is needs_info.");
    }
  }
  return problems;
}
