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

## Data
- `data/tickets/*.json`: 10 real-shaped tickets. File name = `<id>-<slug>.json`. Each must pass `TicketSchema` (`test/data-tickets.test.ts`).
- `data/labels.json`: hand-labeled expectations per ticket. `corpusIds` = tickets open at that ticket's `createdAt`.
- ESM + NodeNext: relative imports use the `.js` extension.
