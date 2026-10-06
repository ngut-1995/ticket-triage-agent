import type { Ticket } from "../domain/schemas.js";

export interface Candidate {
  ticket: Ticket;
  score: number;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have i in is it its me my no not of on or " +
    "our so that the their them there they this to was we were what when where which who will with " +
    "you your"
  ).split(" "),
);

function tokens(ticket: Ticket): Set<string> {
  const words = `${ticket.title} ${ticket.body}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(words.filter((w) => w.length > 0 && !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// SPEC §4.3 step 1: top k corpus tickets with score > 0, never the input itself.
export function prefilterCandidates(ticket: Ticket, corpus: Ticket[], k = 10): Candidate[] {
  const input = tokens(ticket);
  return corpus
    .filter((t) => t.id !== ticket.id)
    .map((t) => ({ ticket: t, score: jaccard(input, tokens(t)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
