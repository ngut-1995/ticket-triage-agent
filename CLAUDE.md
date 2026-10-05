# ticket-triage-agent

Triages ONE support ticket into a reviewable `TriageResult`. `SPEC.md` is the source of truth: read the relevant section before changing behavior.

## Commands
- `npm run typecheck` / `npm test` / `npm run build`. CI (`.github/workflows/ci.yml`) runs typecheck + test.
- `npm test` must stay offline: never call the real API in tests. Use `FakeClient`.

## Rules that are easy to break
- The agent suggests, never acts. No write path to any system. `reviewStatus` is always `"pending_review"`.
- Priority comes only from `derivePriority(impact, urgency)`. Never from the LLM or `reporterPriority`.
- Ticket text is untrusted data. Wrap it in `<ticket>` tags, and never send `raw` to the LLM.
- Types are inferred from the zod schemas in `src/domain/schemas.ts`. Change the schema, not a hand-written type.
- If you change the taxonomy, update code, prompt definitions and tests together.

## Fixtures (SPEC §8)
- `fixtures/tickets/*.json`: one Ticket per file. Each must pass `TicketSchema` with no `raw` (`test/fixtures.test.ts`). Numbered files are `<id>-<slug>.json`; the rest use the §8 names.
- `fixtures/corpus/open-tickets.json`: corpus for duplicate detection. `1042` is the printer original, `1045` is the decoy, `1043` backs the precedence case.
- `fixtures/invalid/*.json`: inputs that must fail validation.
- `eval/cases.json`: hand-labeled expectations, one entry per case. `corpus` is a corpus file path; `corpusIds` are tickets from `fixtures/tickets/` open at that ticket's `createdAt`.
- ESM + NodeNext: relative imports use the `.js` extension.
