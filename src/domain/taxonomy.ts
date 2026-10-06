// SPEC §3.2. Changing the taxonomy means changing code, prompt definitions and tests together.
// Each `*_DEFINITIONS` record has one line per enum value; they are rendered into the prompt.

export const CATEGORIES = [
  "access",
  "hardware",
  "software_bug",
  "network",
  "feature_request",
  "how_to",
  "security",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_DEFINITIONS: Record<Category, string> = {
  access: "Accounts, sign-in, passwords, MFA, permissions or group membership.",
  hardware: "Physical devices: laptops, monitors, printers, peripherals, phones; repairs or replacements.",
  software_bug: "An application or system behaves incorrectly: errors, crashes, wrong results.",
  network: "Connectivity: VPN, Wi-Fi, wired network, DNS, internet access, unreachable network shares.",
  feature_request: "A request for new or changed functionality in an existing system.",
  how_to: "The reporter asks how to do something; nothing is broken.",
  security: "Phishing, malware, suspected compromise, leaked credentials or other security incidents.",
  other: "Anything that does not fit the categories above.",
};

export const TEAMS = ["service_desk", "identity_access", "endpoint", "network", "apps", "security"] as const;
export type Team = (typeof TEAMS)[number];

export const TEAM_DEFINITIONS: Record<Team, string> = {
  service_desk: "First-line support: how-to questions, general requests and anything uncategorized.",
  identity_access: "Identity and access management: accounts, passwords, MFA, permissions.",
  endpoint: "End-user devices: hardware, operating system and peripherals.",
  network: "Network infrastructure: VPN, Wi-Fi, LAN, DNS, firewalls.",
  apps: "Internal and business applications: bugs and feature requests.",
  security: "Security operations: incidents, phishing, malware, exposed secrets.",
};

export const DEFAULT_TEAM: Record<Category, Team> = {
  access: "identity_access",
  hardware: "endpoint",
  software_bug: "apps",
  network: "network",
  feature_request: "apps",
  how_to: "service_desk",
  security: "security",
  other: "service_desk",
};

export const IMPACTS = ["single_user", "team", "org_wide"] as const;
export type Impact = (typeof IMPACTS)[number];

export const IMPACT_DEFINITIONS: Record<Impact, string> = {
  single_user: "Affects only the reporter or one person.",
  team: "Affects several people, a team or a department.",
  org_wide: "Affects the whole organization or a service everyone depends on.",
};

export const URGENCIES = ["blocked", "degraded", "minor"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const URGENCY_DEFINITIONS: Record<Urgency, string> = {
  blocked: "The affected people cannot do the work at all and have no workaround.",
  degraded: "Work is possible but slower or harder, or only through a workaround.",
  minor: "An inconvenience or cosmetic issue; work is essentially unaffected.",
};

export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_DEFINITIONS: Record<Priority, string> = {
  P1: "Critical: handle immediately.",
  P2: "High: handle as soon as possible.",
  P3: "Medium: handle in normal queue order.",
  P4: "Low: handle when capacity allows.",
};

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CONFIDENCE_DEFINITIONS: Record<Confidence, string> = {
  low: "A best guess; the ticket gives little or conflicting support.",
  medium: "Likely, but the ticket leaves room for another reading.",
  high: "Clearly supported by what the ticket says.",
};

export const DISPOSITIONS = ["actionable", "needs_info", "suspected_duplicate", "not_actionable"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_DEFINITIONS: Record<Disposition, string> = {
  actionable: "Clear enough to state at least one verifiable end state.",
  needs_info: "Every requirement is blocked by at least one question to the reporter.",
  suspected_duplicate: "At least one candidate is a high-confidence duplicate; the ticket is still fully triaged.",
  not_actionable: "Spam, auto-reply, already resolved by the reporter, or empty with no recoverable intent.",
};

export const NOT_ACTIONABLE_REASONS = ["spam", "auto_reply", "resolved_by_reporter", "empty", "other"] as const;
export type NotActionableReason = (typeof NOT_ACTIONABLE_REASONS)[number];

export const NOT_ACTIONABLE_REASON_DEFINITIONS: Record<NotActionableReason, string> = {
  spam: "Unsolicited or irrelevant message, not a support request.",
  auto_reply: "Automatic reply such as an out-of-office or delivery notice.",
  resolved_by_reporter: 'The reporter says the problem is already solved ("thanks, it works now").',
  empty: "Empty or near-empty ticket with no recoverable intent.",
  other: "Not actionable for another reason, explained in reviewerNotes.",
};

// SPEC §3.4 MissingInfoQuestion.unblocks: the non-requirement targets a question may unblock.
export const UNBLOCK_FIELDS = ["category", "priority", "duplicate"] as const;
export type UnblockField = (typeof UNBLOCK_FIELDS)[number];

// SPEC §4.5 rule 4. Matched case-insensitively as whole words / phrases.
export const VAGUE_TERMS = [
  "fast",
  "quickly",
  "easy",
  "user-friendly",
  "intuitive",
  "ASAP",
  "properly",
  "correctly",
  "as expected",
  "better",
  "improve",
  "optimize",
  "etc.",
  "and/or",
] as const;
