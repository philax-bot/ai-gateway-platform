/**
 * Read-only usage analytics for the 用量驾驶舱 page.
 *
 * The endpoint aggregates the same ended calls that `CallSummary` counts, so the
 * two never disagree: only `call_logs` rows in the window are counted, unknown
 * usage is reported separately instead of being treated as zero, and
 * `pending_review` amounts never enter `confirmedAmount`.
 */
export interface UsageAnalyticsQuery {
  /** Inclusive ISO timestamp. Defaults to the start of the current month in the workspace time zone. */
  from?: string;
  /** Exclusive ISO timestamp. Defaults to the request time. */
  to?: string;
  /** Optional scope narrowing. Names are resolved by the client from the snapshot. */
  organizationId?: string;
  modelId?: string;
  purpose?: 'personal' | 'project' | 'application';
}

/** One aggregation bucket: a person, application, project, model, organization or day. */
export interface UsageBucket {
  /** subjectId / modelId / organizationId / projectId ('' when the call carried none) / YYYY-MM-DD. */
  key: string;
  /** Every ended call in the bucket (the same row count `CallSummary.ended` uses). */
  requests: number;
  /** Ended calls whose usage was never finalized; their tokens are not counted. */
  unknownUsage: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Sum of `actualAmount` where billableState is `confirmed`. */
  confirmedAmount: number;
  /** Ended calls still awaiting reconciliation. */
  pendingReview: number;
  /** Sum of `actualAmount` where billableState is `pending_review`; not income. */
  pendingAmount: number;
  /** Outcome is neither `completed` nor `client_cancelled`. */
  errors: number;
  /** Calls that actually reached the upstream; the denominator for upstream failures. */
  forwarded: number;
  upstreamFailures: number;
  lastActiveAt: string | null;
}

export interface UsageTotals extends Omit<UsageBucket, 'key' | 'lastActiveAt'> {
  activePeople: number;
  activeApplications: number;
}

/**
 * Aggregates for one window. Rows are sorted server-side (people/applications/
 * projects/models/organizations by confirmed amount, days ascending) and never
 * paginated: the window is capped at 93 days so the payload stays bounded.
 */
export interface UsageAnalytics {
  from: string;
  to: string;
  timezone: string;
  totals: UsageTotals;
  people: UsageBucket[];
  applications: UsageBucket[];
  /** Grouped by `projectId`; `''` collects project-less calls so sums still close. */
  projects: UsageBucket[];
  models: UsageBucket[];
  organizations: UsageBucket[];
  days: UsageBucket[];
  collectedAt: string;
}
