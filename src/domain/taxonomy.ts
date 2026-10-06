// SPEC §3.2. Changing the taxonomy means changing code, prompt definitions and tests together.

export const IMPACTS = ["single_user", "team", "org_wide"] as const;
export type Impact = (typeof IMPACTS)[number];

export const URGENCIES = ["blocked", "degraded", "minor"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];
