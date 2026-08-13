/**
 * The v1 rule pack. One file per guideline area; add a rule by appending to
 * the area file (or adding a new area file and spreading it here).
 * Bump RULE_PACK_LAST_REVIEWED whenever the pack is checked against Apple's
 * current guidelines — audit output surfaces it so staleness is visible.
 */

import type { GuidelineRule } from '../types.js';
import { completenessRules } from './completeness.js';
import { metadataRules } from './metadata.js';
import { paymentsRules } from './payments.js';
import { privacyRules } from './privacy.js';

export const RULE_PACK_LAST_REVIEWED = '2026-08-13';

export const guidelineRules: GuidelineRule[] = [
  ...privacyRules,
  ...metadataRules,
  ...paymentsRules,
  ...completenessRules,
];
