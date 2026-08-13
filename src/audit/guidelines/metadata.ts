/** Guideline 2.3 — accurate metadata. */

import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#accurate-metadata';

export const metadataRules: GuidelineRule[] = [
  {
    id: 'metadata.age-rating-declared',
    guideline: '2.3.6',
    title: 'Age rating questionnaire completed',
    link: LINK,
    tools: ['check_submission_readiness'],
    appliesTo: () => true,
    check: (facts) =>
      facts.ageRating.declared
        ? { status: 'pass', detail: 'Age rating declared.' }
        : { status: 'fail', detail: 'Age rating questionnaire not completed in App Store Connect.' },
    fix: 'Complete the age rating questionnaire on the App Information page in App Store Connect.',
  },
  {
    id: 'metadata.in-app-controls',
    guideline: '2.3.6',
    title: 'In-App Controls declaration must match the app',
    link: LINK,
    appliesTo: (facts) => Boolean(facts.ageRating.inAppControls && facts.ageRating.inAppControls !== 'NONE'),
    judgment: {
      question:
        'The age rating declares In-App Controls (parental controls / age assurance). Does the app ' +
        'actually ship these mechanisms, and can a reviewer find them?',
      guidance:
        'Apple rejects apps whose Age Rating selects In-App Controls when reviewers cannot locate ' +
        'parental controls or age-assurance features. Either the app must ship them (and review notes ' +
        'should say where), or the selection must be set to "None".',
    },
    fix:
      'If the app ships these controls, explain where to find them in the review notes; otherwise set ' +
      '"Parental Controls" to "None" on the App Information page.',
  },
];
