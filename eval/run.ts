// SPEC §7 golden eval (`npm run eval`): triage every case in eval/cases.json with the real model,
// check it against the hand labels, print a scorecard, and exit non-zero if any case fails.
// Provider from TRIAGE_PROVIDER (default claude), model from TRIAGE_MODEL; needs that provider's key
// (ANTHROPIC_API_KEY or DEEPSEEK_API_KEY). Not run in CI.
import { readdirSync, readFileSync } from "node:fs";
import { errorMessage } from "../src/domain/errors.js";
import { TicketSchema, type Ticket } from "../src/domain/schemas.js";
import { createLlmClient } from "../src/llm/provider.js";
import { triageTicket } from "../src/triage.js";
import { checkCase, EvalCaseSchema, type CheckOutcome, type EvalCase } from "./check.js";
import { resolveEvalConfig, scorecardHeader } from "./config.js";

const root = new URL("../", import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));

function loadCorpus(c: EvalCase): Ticket[] | undefined {
  if (c.corpus) return TicketSchema.array().parse(readJson(c.corpus));
  if (!c.corpusIds) return undefined;
  const all = readdirSync(new URL("fixtures/tickets/", root))
    .filter((f) => f.endsWith(".json"))
    .map((f) => TicketSchema.parse(readJson(`fixtures/tickets/${f}`)));
  return all.filter((t) => c.corpusIds?.includes(t.id));
}

async function main(): Promise<number> {
  const resolved = resolveEvalConfig();
  if (!resolved.ok) {
    console.error(resolved.error);
    return 2;
  }

  const cases = EvalCaseSchema.array().parse(readJson("eval/cases.json"));
  const llm = createLlmClient(resolved.config);
  console.log(`${scorecardHeader(cases.length, resolved.config)}\n`);

  let failedCases = 0;
  let repairedCases = 0;
  for (const [i, c] of cases.entries()) {
    const label = `#${String(i + 1).padStart(2, "0")} ${c.fixture}${c.kind ? ` [${c.kind}]` : ""}`;
    let outcomes: CheckOutcome[];
    let repaired = false;
    try {
      const corpus = loadCorpus(c);
      const result = await triageTicket(readJson(c.fixture), corpus ? { llm, corpus } : { llm });
      repaired = result.meta.repairAttempted;
      outcomes = checkCase(result, c.expect);
    } catch (error) {
      outcomes = [{ check: "triage", pass: false, detail: errorMessage(error) }];
    }
    const failures = outcomes.filter((o) => !o.pass);
    if (failures.length > 0) failedCases++;
    if (repaired) repairedCases++;
    const checks = `${outcomes.length - failures.length}/${outcomes.length} checks${repaired ? ", repaired" : ""}`;
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${label} (${checks})`);
    for (const f of failures) console.log(`       ✗ ${f.check}: ${f.detail}`);
  }

  console.log(`\n${cases.length - failedCases}/${cases.length} cases passed, ${repairedCases} needed repair`);
  return failedCases === 0 ? 0 : 1;
}

process.exitCode = await main();
