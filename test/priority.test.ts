import { describe, expect, it } from "vitest";
import { derivePriority } from "../src/domain/priority.js";
import type { Impact, Priority, Urgency } from "../src/domain/taxonomy.js";

// SPEC §3.3, copied cell by cell from the table.
const MATRIX: [Impact, Urgency, Priority][] = [
  ["org_wide", "blocked", "P1"],
  ["org_wide", "degraded", "P1"],
  ["org_wide", "minor", "P2"],
  ["team", "blocked", "P1"],
  ["team", "degraded", "P2"],
  ["team", "minor", "P3"],
  ["single_user", "blocked", "P2"],
  ["single_user", "degraded", "P3"],
  ["single_user", "minor", "P4"],
];

describe("derivePriority", () => {
  it.each(MATRIX)("%s + %s → %s", (impact, urgency, expected) => {
    expect(derivePriority(impact, urgency)).toBe(expected);
  });
});
