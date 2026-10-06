// SPEC §7 golden eval (`npm run eval`): triage every case in eval/cases.json with the real model,
// check it against the hand labels, print a scorecard, and exit non-zero if any case fails.
// Needs ANTHROPIC_API_KEY. Not run in CI.
import { readdirSync, readFileSync } from "node:fs";
import { errorMessage } from "../src/domain/errors.js";
import { TicketSchema, type Ticket } from "../src/domain/schemas.js";
import { ClaudeClient } from "../src/llm/claude.js";
import { triageTicket } from "../src/triage.js";
import { checkCase, EvalCaseSchema, type CheckOutcome, type EvalCase } from "./check.js";

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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("eval: ANTHROPIC_API_KEY is not set. The golden eval runs against the real model; set it and retry.");
    return 2;
  }

  const cases = EvalCaseSchema.array().parse(readJson("eval/cases.json"));
  const llm = new ClaudeClient();
  console.log(`Golden eval: ${cases.length} cases, model ${llm.model}\n`);

  let failedCases = 0;
  for (const [i, c] of cases.entries()) {
    const label = `#${String(i + 1).padStart(2, "0")} ${c.fixture}${c.kind ? ` [${c.kind}]` : ""}`;
    let outcomes: CheckOutcome[];
    try {
      const corpus = loadCorpus(c);
      const result = await triageTicket(readJson(c.fixture), corpus ? { llm, corpus } : { llm });
      outcomes = checkCase(result, c.expect);
    } catch (error) {
      outcomes = [{ check: "triage", pass: false, detail: errorMessage(error) }];
    }
    const failures = outcomes.filter((o) => !o.pass);
    if (failures.length > 0) failedCases++;
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${label} (${outcomes.length - failures.length}/${outcomes.length} checks)`);
    for (const f of failures) console.log(`       ✗ ${f.check}: ${f.detail}`);
  }

  console.log(`\n${cases.length - failedCases}/${cases.length} cases passed`);
  return failedCases === 0 ? 0 : 1;
}

process.exitCode = await main();
