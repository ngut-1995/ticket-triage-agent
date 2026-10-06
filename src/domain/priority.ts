import type { Impact, Priority, Urgency } from "./taxonomy.js";

// SPEC §3.3. The LLM never outputs a priority; it is always looked up here.
const MATRIX: Record<Impact, Record<Urgency, Priority>> = {
  org_wide: { blocked: "P1", degraded: "P1", minor: "P2" },
  team: { blocked: "P1", degraded: "P2", minor: "P3" },
  single_user: { blocked: "P2", degraded: "P3", minor: "P4" },
};

export function derivePriority(impact: Impact, urgency: Urgency): Priority {
  return MATRIX[impact][urgency];
}
