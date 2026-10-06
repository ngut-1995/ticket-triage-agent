// Public API (SPEC §6).
export { triageTicket, TicketValidationError, TriageOutputError, type TriageDeps } from "./triage.js";
export { TicketSchema, LlmTriageOutputSchema, TriageResultSchema, QUALITY_RULE_CODES } from "./domain/schemas.js";
export type * from "./domain/types.js";
export { derivePriority } from "./domain/priority.js";
export { DEFAULT_TEAM } from "./domain/taxonomy.js";
export { validateResult } from "./quality/validate.js";
export type { TicketSource } from "./sources/ticket-source.js";
export { FileTicketSource, type FileTicketSourceOptions } from "./sources/file.js";
export { LLMError, type LLMClient, type StructuredRequest, type StructuredResponse } from "./llm/client.js";
export { ClaudeClient, DEFAULT_MODEL, type ClaudeClientOptions } from "./llm/claude.js";
export { FakeClient } from "./llm/fake.js";
