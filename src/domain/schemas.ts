import { z } from "zod";
import { TicketValidationError } from "./errors.js";
import {
  CATEGORIES,
  CONFIDENCES,
  DISPOSITIONS,
  IMPACTS,
  NOT_ACTIONABLE_REASONS,
  PRIORITIES,
  TEAMS,
  URGENCIES,
} from "./taxonomy.js";

// SPEC §3.1: ISO-8601 date, or date-time with or without a zone ("Z" or an offset).
const IsoTimestamp = z.union([z.iso.datetime({ offset: true, local: true }), z.iso.date()]);

const TicketFields = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  createdAt: IsoTimestamp,
  reporter: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      department: z.string().optional(),
    })
    .optional(),
  reporterPriority: z.string().optional(),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string(),
        createdAt: IsoTimestamp,
      }),
    )
    .optional(),
  attachments: z
    .array(z.object({ filename: z.string(), mimeType: z.string().optional() }))
    .optional(),
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Moves unknown top-level fields into `raw`. Anything that is not an object is left for the schema to reject.
const collectRaw = (input: unknown): unknown => {
  if (!isPlainObject(input)) return input;
  const ticket: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    (key in TicketFields.shape ? ticket : raw)[key] = value;
  }
  return Object.keys(raw).length > 0 ? { ...ticket, raw } : ticket;
};

// SPEC §3.1. Unknown top-level fields are preserved in `raw` and never sent to the LLM.
export const TicketSchema = z.preprocess(
  collectRaw,
  TicketFields.extend({ raw: z.record(z.string(), z.unknown()).optional() }),
);

export type Ticket = z.output<typeof TicketSchema>;

/** Parses `input` as a Ticket (SPEC §3.1) or throws TicketValidationError. */
export function parseTicket(input: unknown): Ticket {
  const parsed = TicketSchema.safeParse(input);
  if (!parsed.success) throw new TicketValidationError(parsed.error.issues);
  return parsed.data;
}

// SPEC §3.4, §6.1. Shape only: anything the quality validator (SPEC §5) reports, such as summary length,
// question count, empty unblocks or acceptance criteria, missing quotes or duplicate IDs, is accepted here
// so the validator can see it and the repair loop can fix it.

const Category = z.enum(CATEGORIES);
const Confidence = z.enum(CONFIDENCES);

const RequirementSchema = z.object({
  id: z.string(),
  statement: z.string(),
  source: z.object({ quote: z.string(), field: z.enum(["title", "body", "comment"]) }),
  acceptanceCriteria: z.array(z.object({ given: z.string(), when: z.string(), then: z.string() })),
  assumptions: z.array(z.string()),
});

const MissingInfoQuestionSchema = z.object({
  question: z.string(),
  why: z.string(),
  // Requirement IDs ("R2") and/or UNBLOCK_FIELDS (taxonomy.ts). Dangling IDs are a validator concern.
  unblocks: z.array(z.string()),
});

const LlmPriority = z.object({
  impact: z.enum(IMPACTS).nullable(),
  urgency: z.enum(URGENCIES).nullable(),
  confidence: Confidence,
  evidence: z.array(z.string()),
});

const LlmTeam = z.object({ team: z.enum(TEAMS), rationale: z.string() });

const llmFields = {
  disposition: z.enum(DISPOSITIONS),
  notActionableReason: z.enum(NOT_ACTIONABLE_REASONS).optional(),
  summary: z.string(),
  category: z.object({
    primary: Category,
    secondary: z.array(Category),
    confidence: Confidence,
    rationale: z.string(),
  }),
  priority: LlmPriority,
  suggestedTeam: LlmTeam.nullable(),
  suggestedSplit: z.array(z.object({ title: z.string(), category: Category })),
  possibleDuplicates: z.array(z.object({ ticketId: z.string(), confidence: Confidence, reason: z.string() })),
  missingInfo: z.array(MissingInfoQuestionSchema),
  requirements: z.array(RequirementSchema),
  flags: z.object({ containsSensitiveData: z.boolean(), possiblePromptInjection: z.boolean() }),
  reviewerNotes: z.array(z.string()),
};

// What the LLM returns: TriageResult minus the fields computed in code (ticketId, reviewStatus,
// priority.value, priority.reporterPriority, suggestedTeam.overridesDefault, qualityWarnings, meta).
export const LlmTriageOutputSchema = z.object(llmFields);

export const QUALITY_RULE_CODES = [
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
] as const;

const QualityWarningSchema = z.object({
  code: z.enum(QUALITY_RULE_CODES),
  requirementId: z.string().optional(),
  message: z.string(),
});

export const TriageResultSchema = z.object({
  ticketId: z.string(),
  reviewStatus: z.literal("pending_review"),
  ...llmFields,
  priority: LlmPriority.extend({
    value: z.enum(PRIORITIES).nullable(),
    reporterPriority: z.string().optional(),
  }),
  suggestedTeam: LlmTeam.extend({ overridesDefault: z.boolean() }).nullable(),
  qualityWarnings: z.array(QualityWarningSchema),
  meta: z.object({
    model: z.string(),
    promptVersion: z.string(),
    repairAttempted: z.boolean(),
    durationMs: z.number(),
  }),
});

export type LlmTriageOutput = z.output<typeof LlmTriageOutputSchema>;
export type TriageResult = z.output<typeof TriageResultSchema>;
export type Requirement = z.output<typeof RequirementSchema>;
export type MissingInfoQuestion = z.output<typeof MissingInfoQuestionSchema>;
export type QualityWarning = z.output<typeof QualityWarningSchema>;
export type QualityRuleCode = (typeof QUALITY_RULE_CODES)[number];
