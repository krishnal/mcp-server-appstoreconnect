/** Guideline 3.1 — payments, subscriptions. */

import type { GuidelineRule } from '../types.js';

const LINK = 'https://developer.apple.com/app-store/review/guidelines/#payments';
const TERMS_PATTERN = /terms of use|EULA|apple\.com\/legal\/internet-services\/itunes\/dev\/stdeula/i;

export const paymentsRules: GuidelineRule[] = [
  {
    id: 'payments.subscription-terms',
    guideline: '3.1.2',
    title: 'Subscriptions need a functional Terms of Use (EULA) link',
    link: LINK,
    tools: ['audit_app_review'],
    appliesTo: (facts) => facts.hasSubscriptions,
    check: (facts) => {
      if (facts.hasCustomEula) {
        return { status: 'pass', detail: 'Custom EULA configured in App Store Connect.' };
      }
      const hasLink = facts.descriptions.some((d) => d.text && TERMS_PATTERN.test(d.text));
      return hasLink
        ? { status: 'pass', detail: 'Terms of Use link found in the App Description.' }
        : {
            status: 'fail',
            detail:
              'App offers auto-renewable subscriptions but the App Description has no Terms of Use ' +
              '(EULA) link and no custom EULA is configured.',
          };
    },
    fix:
      'Using the standard Apple EULA: add a Terms of Use link (https://www.apple.com/legal/internet-services/itunes/dev/stdeula/) ' +
      'to the App Description in App Store Connect. Using a custom EULA: configure it in App Store Connect instead.',
  },
  {
    id: 'payments.external-purchase-links',
    guideline: '3.1.1',
    title: 'Digital content must use In-App Purchase',
    link: LINK,
    appliesTo: (facts) => facts.hasSubscriptions,
    judgment: {
      question:
        'Does the app unlock digital content or features through any mechanism other than In-App ' +
        'Purchase, or link out to external purchase flows without the required entitlement?',
      guidance:
        'Apps unlocking digital content must use IAP. External purchase links require the applicable ' +
        'entitlements and regional rules; steering users to external payment without them is rejected.',
    },
    fix: 'Route digital purchases through IAP, or adopt the external-purchase-link entitlements where eligible.',
  },
];
