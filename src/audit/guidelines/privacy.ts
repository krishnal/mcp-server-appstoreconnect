/** Guideline 5.1.1 — privacy & data collection. */

import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage';

export const privacyRules: GuidelineRule[] = [
  {
    id: 'privacy.purpose-strings',
    guideline: '5.1.1(ii)',
    title: 'Purpose strings must explain use and give an example',
    link: LINK,
    needsProject: true,
    tools: ['audit_app_review'],
    appliesTo: (facts) => Object.keys(facts.project?.purposeStrings ?? {}).length > 0,
    check: (facts) => {
      const strings = facts.project?.purposeStrings ?? {};
      const empty = Object.entries(strings)
        .filter(([, value]) => !value.trim())
        .map(([key]) => key);
      if (empty.length > 0) {
        return { status: 'fail', detail: `Empty purpose strings: ${empty.join(', ')}.`, facts: strings };
      }
      return {
        status: 'needs_judgment',
        detail: 'Purpose strings are present — their quality needs review.',
        facts: strings,
      };
    },
    judgment: {
      question:
        'Does each purpose string clearly explain how the app uses the protected resource AND give a specific example?',
      guidance:
        'Apple rejects vague strings. Hypothetical strings that fail review: "App would like to access ' +
        'your Contacts", "App needs microphone access". A passing string names the feature and an ' +
        'example of use: "Uses the camera to scan handwritten recipes so you can save them as cards."',
    },
    fix:
      'Rewrite each …UsageDescription value in Info.plist to state the feature that uses the data and ' +
      'a concrete example, then rebuild and re-upload the binary.',
  },
  {
    id: 'privacy.policy-url',
    guideline: '5.1.1(i)',
    title: 'Privacy policy link required',
    link: LINK,
    tools: ['check_submission_readiness'],
    appliesTo: () => true,
    check: (facts) =>
      facts.privacyPolicyUrl
        ? { status: 'pass', detail: `Privacy policy: ${facts.privacyPolicyUrl}` }
        : { status: 'fail', detail: 'No privacy policy URL set in App Store Connect.' },
    fix: 'Add the privacy policy URL on the App Information page in App Store Connect.',
  },
  {
    id: 'privacy.account-deletion',
    guideline: '5.1.1(v)',
    title: 'Apps with account creation must offer in-app account deletion',
    link: LINK,
    needsProject: true,
    appliesTo: (facts) => (facts.project?.entitlementKeys ?? []).includes('com.apple.developer.applesignin'),
    judgment: {
      question:
        'The app has the Sign in with Apple entitlement, so it supports account creation. Can users ' +
        'initiate account deletion from within the app?',
      guidance:
        'Apple requires apps that support account creation to also let users initiate account deletion ' +
        'in-app. A link out is acceptable only if it leads directly to the deletion flow.',
    },
    fix: 'Add an in-app entry point that lets users delete their account and associated data.',
  },
  {
    id: 'privacy.manifest-present',
    guideline: '5.1.1',
    title: 'Privacy manifest (PrivacyInfo.xcprivacy) present',
    link: LINK,
    needsProject: true,
    appliesTo: () => true,
    check: (facts) =>
      facts.project?.privacyManifestFound
        ? { status: 'pass', detail: 'PrivacyInfo.xcprivacy found.' }
        : {
            status: 'warn',
            detail:
              'No PrivacyInfo.xcprivacy found. Required when the app or its SDKs use required-reason ' +
              'APIs or collect data.',
          },
    fix: 'Add a PrivacyInfo.xcprivacy manifest describing data collection and required-reason API usage.',
  },
];
