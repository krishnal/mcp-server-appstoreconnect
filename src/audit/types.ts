/**
 * Audit domain types.
 *
 * `AppFacts` is the single input every guideline rule sees: ASC metadata plus
 * (optionally) facts scanned from the local Xcode project. Rules are data +
 * two small functions; the deterministic `check` handles mechanical
 * requirements, while `judgment` items carry the facts and Apple's guidance
 * for the calling LLM to evaluate — the rule pack grounds the audit, the LLM
 * does the reasoning.
 */

export interface ProjectFacts {
  infoPlistPaths: string[];
  purposeStrings: Record<string, string>;
  entitlementKeys: string[];
  privacyManifestFound: boolean;
  warnings: string[];
}

export interface AppFacts {
  appId: string;
  hasSubscriptions: boolean;
  hasCustomEula: boolean;
  privacyPolicyUrl?: string;
  ageRating: { declared: boolean; inAppControls?: string | null };
  descriptions: { locale?: string; text?: string }[];
  project?: ProjectFacts;
}

export type FindingStatus = 'pass' | 'fail' | 'warn' | 'needs_judgment';

export interface CheckOutcome {
  status: FindingStatus;
  detail: string;
  facts?: unknown;
}

export interface Finding {
  ruleId: string;
  guideline: string;
  title: string;
  link: string;
  status: FindingStatus;
  detail: string;
  facts?: unknown;
  judgment?: { question: string; guidance: string };
  fix: string;
}

export interface SkippedCheck {
  ruleId: string;
  guideline: string;
  reason: string;
}

export interface GuidelineRule {
  id: string;
  guideline: string;
  title: string;
  link: string;
  needsProject?: boolean;
  tools?: string[];
  appliesTo(facts: AppFacts): boolean;
  check?(facts: AppFacts): CheckOutcome;
  judgment?: { question: string; guidance: string };
  fix: string;
}
