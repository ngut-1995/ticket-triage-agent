// SPEC §3. Types are inferred from the zod schemas in ./schemas.ts; never hand-write them here.
export type {
  LlmTriageOutput,
  MissingInfoQuestion,
  QualityRuleCode,
  QualityWarning,
  Requirement,
  Ticket,
  TriageResult,
} from "./schemas.js";
export type {
  Category,
  Confidence,
  Disposition,
  Impact,
  NotActionableReason,
  Priority,
  Team,
  Urgency,
} from "./taxonomy.js";
