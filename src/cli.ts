#!/usr/bin/env node
// SPEC §6.4. `triage <ticket.json> [--corpus <open-tickets.json>] [--out <result.json>] [--model <id>]`
import { readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage, formatZodIssues, TicketValidationError } from "./domain/errors.js";
import { parseTicket, TicketSchema, type Ticket, type TriageResult } from "./domain/schemas.js";
import { ClaudeClient, resolveModel } from "./llm/claude.js";
import { LLMError, type LLMClient } from "./llm/client.js";
import { TriageOutputError, triageTicket } from "./triage.js";

export const EXIT_OK = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_LLM_ERROR = 3;

const USAGE = "Usage: triage <ticket.json> [--corpus <open-tickets.json>] [--out <result.json>] [--model <id>]";

/** Builds the LLM client once the input is valid. Receives the resolved model (`--model` > TRIAGE_MODEL > default). */
export type CliClientFactory = (config: { model: string; apiKey: string }) => LLMClient;

export interface CliIO {
  /** Test seam: a ready client, or a factory that receives the resolved model. Defaults to ClaudeClient. */
  llm?: LLMClient | CliClientFactory | undefined;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
}

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. Never calls process.exit, so it is testable in-process. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const fail = (code: number, message: string): number => {
    io.stderr.write(`triage: ${message}\n`);
    return code;
  };

  let args: { file: string; corpus?: string | undefined; out?: string | undefined; model?: string | undefined };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        corpus: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    }
    if (positionals.length !== 1) throw new UsageError("expected exactly one ticket file");
    args = { file: positionals[0]!, corpus: values.corpus, out: values.out, model: values.model };
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, `${errorMessage(error)}\n${USAGE}`);
  }

  // Everything below the LLM call is validated first, so bad input never reaches (or authenticates with) the API.
  // Every input problem is a TicketValidationError (AC-2).
  let input: unknown;
  let corpus: Ticket[] | undefined;
  try {
    input = await readJson(args.file, "ticket");
    parseTicket(input);
    if (args.corpus !== undefined) {
      const parsed = TicketSchema.array().safeParse(await readJson(args.corpus, "corpus"));
      if (!parsed.success) {
        const { issues } = parsed.error;
        throw new TicketValidationError(issues, `Invalid corpus ${args.corpus}: ${formatZodIssues(issues)}`);
      }
      corpus = parsed.data;
    }
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, errorMessage(error));
  }

  const model = resolveModel(args.model, io.env);
  const apiKey = io.env.ANTHROPIC_API_KEY ?? "";
  const llm =
    typeof io.llm === "function"
      ? io.llm({ model, apiKey })
      : (io.llm ?? new ClaudeClient({ apiKey, model }));

  let result: TriageResult;
  try {
    result = await triageTicket(input, { llm, ...(corpus ? { corpus } : {}) });
  } catch (error) {
    if (error instanceof TicketValidationError) return fail(EXIT_INVALID_INPUT, error.message);
    if (error instanceof LLMError || error instanceof TriageOutputError) return fail(EXIT_LLM_ERROR, error.message);
    return fail(EXIT_UNEXPECTED, `unexpected error: ${errorMessage(error)}`);
  }

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out !== undefined) {
    try {
      // The only file write in src/ (SPEC §10 step 6).
      await writeFile(args.out, json, "utf8");
    } catch (error) {
      return fail(EXIT_UNEXPECTED, `cannot write ${args.out}: ${errorMessage(error)}`);
    }
  } else {
    io.stdout.write(json);
  }
  io.stderr.write(summarize(result));
  return EXIT_OK;
}

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw TicketValidationError.fromProblem(`cannot read ${what} file ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw TicketValidationError.fromProblem(`${what} file ${path} is not valid JSON: ${errorMessage(error)}`);
  }
}

/** Short human-readable summary for stderr (SPEC §6.4). */
export function summarize(r: TriageResult): string {
  const dupes = r.possibleDuplicates.map((d) => `${d.ticketId} (${d.confidence})`).join(", ") || "none";
  const warnings = r.qualityWarnings.length
    ? `${r.qualityWarnings.length} [${[...new Set(r.qualityWarnings.map((w) => w.code))].join(", ")}]`
    : "0";
  const flags = Object.entries(r.flags)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(", ");
  const lines = [
    `ticket: ${r.ticketId} (${r.reviewStatus})`,
    `disposition: ${r.disposition}${r.notActionableReason ? ` (${r.notActionableReason})` : ""}`,
    `category: ${r.category.primary} (${r.category.confidence})`,
    `priority: ${r.priority.value ?? "none"} (impact ${r.priority.impact ?? "-"}, urgency ${r.priority.urgency ?? "-"})`,
    `team: ${r.suggestedTeam ? `${r.suggestedTeam.team}${r.suggestedTeam.overridesDefault ? " (overrides default)" : ""}` : "none"}`,
    `duplicates: ${dupes}`,
    `questions: ${r.missingInfo.length}`,
    `warnings: ${warnings}`,
    `flags: ${flags || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function isMain(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // npm's bin shim is a symlink to dist/cli.js, so compare real paths.
    return (await realpath(entry)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isMain()) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
}
