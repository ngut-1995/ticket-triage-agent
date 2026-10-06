// Errors and error formatting shared by triage, the CLI, ticket sources and the eval. Imports nothing from src/,
// so any module can depend on it without a cycle.
import type { z } from "zod";

export type ZodIssue = z.core.$ZodIssue;

const formatPath = (issue: ZodIssue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)");

/** One zod issue as "path: message". */
export const formatZodIssue = (issue: ZodIssue): string => `${formatPath(issue)}: ${issue.message}`;

/** Zod issues as "path: message; path: message". */
export const formatZodIssues = (issues: readonly ZodIssue[]): string => issues.map(formatZodIssue).join("; ");

/** The message of anything thrown. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The input is not a valid Ticket (SPEC §3.1, AC-2): a missing or ill-typed field, unparseable JSON or a missing
 * file. Thrown before any LLM call.
 */
export class TicketValidationError extends Error {
  readonly issues: ZodIssue[];

  constructor(issues: ZodIssue[], message = `Invalid ticket: ${formatZodIssues(issues)}`) {
    super(message);
    this.name = "TicketValidationError";
    this.issues = issues;
  }

  /** For input that never reached the schema, such as a missing file or unparseable JSON. */
  static fromProblem(problem: string): TicketValidationError {
    return new TicketValidationError([{ code: "custom", path: [], message: problem }], `Invalid ticket: ${problem}`);
  }
}
