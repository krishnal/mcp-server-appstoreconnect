/** Guideline 2.1 — app completeness / information needed. */

import type { GuidelineRule } from '../types.js';

export const completenessRules: GuidelineRule[] = [
  {
    id: 'completeness.demo-account',
    guideline: '2.1',
    title: 'Reviewers must be able to access all features',
    link: 'https://developer.apple.com/app-store/review/guidelines/#app-completeness',
    appliesTo: () => true,
    judgment: {
      question:
        'Does the app require sign-in or special setup? If so, is a working demo account (or demo ' +
        'mode) provided in App Review Information?',
      guidance:
        'Guideline 2.1 rejections commonly cite inaccessible features. Reviewers cannot receive SMS ' +
        'codes or create accounts requiring external verification — provide demo credentials that ' +
        'bypass 2FA, or a fully featured demo mode.',
    },
    fix: 'Fill in demo account credentials under App Review Information for the version before submitting.',
  },
];
