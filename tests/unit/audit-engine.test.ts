import { describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit/engine.js';
import { guidelineRules, RULE_PACK_LAST_REVIEWED } from '../../src/audit/guidelines/index.js';
import type { AppFacts, ProjectFacts } from '../../src/audit/types.js';

function baseFacts(overrides: Partial<AppFacts> = {}): AppFacts {
  return {
    appId: 'app-1',
    hasSubscriptions: false,
    hasCustomEula: false,
    privacyPolicyUrl: 'https://example.com/privacy',
    ageRating: { declared: true, inAppControls: 'NONE' },
    descriptions: [{ locale: 'en-US', text: 'A great app.' }],
    ...overrides,
  };
}

function projectFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    infoPlistPaths: ['/proj/App/Info.plist'],
    purposeStrings: { NSCameraUsageDescription: 'Scans recipes so you can save them as cards.' },
    entitlementKeys: [],
    privacyManifestFound: true,
    warnings: [],
    ...overrides,
  };
}

function finding(result: ReturnType<typeof runAudit>, ruleId: string) {
  const found = result.findings.find((f) => f.ruleId === ruleId);
  if (!found) throw new Error(`no finding ${ruleId}`);
  return found;
}

describe('rule pack metadata', () => {
  it('exposes a lastReviewed date and links on every rule', () => {
    expect(RULE_PACK_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const rule of guidelineRules) {
      expect(rule.link).toMatch(/^https:\/\/developer\.apple\.com\//);
      expect(rule.fix.length).toBeGreaterThan(10);
    }
  });
});

describe('project-dependent rules', () => {
  it('are skipped (not silently dropped) without project facts', () => {
    const result = runAudit(guidelineRules, baseFacts());
    const skippedIds = result.skippedChecks.map((s) => s.ruleId);
    expect(skippedIds).toContain('privacy.purpose-strings');
    expect(skippedIds).toContain('privacy.manifest-present');
    expect(result.findings.map((f) => f.ruleId)).not.toContain('privacy.purpose-strings');
  });

  it('purpose strings: empty value fails, non-empty needs judgment with facts attached', () => {
    const empty = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ purposeStrings: { NSPhotoLibraryUsageDescription: '  ' } }) }),
    );
    expect(finding(empty, 'privacy.purpose-strings')).toMatchObject({ status: 'fail' });
    expect(finding(empty, 'privacy.purpose-strings').detail).toMatch(/NSPhotoLibraryUsageDescription/);

    const quality = runAudit(guidelineRules, baseFacts({ project: projectFacts() }));
    const f = finding(quality, 'privacy.purpose-strings');
    expect(f.status).toBe('needs_judgment');
    expect(f.judgment?.guidance).toMatch(/microphone access/);
    expect(f.facts).toMatchObject({ NSCameraUsageDescription: expect.stringContaining('recipes') });
  });

  it('account deletion applies only with the Sign in with Apple entitlement', () => {
    const without = runAudit(guidelineRules, baseFacts({ project: projectFacts() }));
    expect(without.findings.map((f) => f.ruleId)).not.toContain('privacy.account-deletion');

    const withSiwa = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ entitlementKeys: ['com.apple.developer.applesignin'] }) }),
    );
    expect(finding(withSiwa, 'privacy.account-deletion').status).toBe('needs_judgment');
  });

  it('privacy manifest missing is a warn', () => {
    const result = runAudit(
      guidelineRules,
      baseFacts({ project: projectFacts({ privacyManifestFound: false }) }),
    );
    expect(finding(result, 'privacy.manifest-present').status).toBe('warn');
  });
});

describe('metadata rules', () => {
  it('fails when the age rating is undeclared', () => {
    const result = runAudit(guidelineRules, baseFacts({ ageRating: { declared: false } }));
    expect(finding(result, 'metadata.age-rating-declared').status).toBe('fail');
  });

  it('flags declared In-App Controls for judgment (guideline 2.3.6)', () => {
    const none = runAudit(guidelineRules, baseFacts());
    expect(none.findings.map((f) => f.ruleId)).not.toContain('metadata.in-app-controls');

    const declared = runAudit(
      guidelineRules,
      baseFacts({ ageRating: { declared: true, inAppControls: 'PARENTAL_CONTROLS' } }),
    );
    expect(finding(declared, 'metadata.in-app-controls')).toMatchObject({
      status: 'needs_judgment',
      guideline: '2.3.6',
    });
  });
});

describe('payments rules', () => {
  it('subscriptions without a Terms of Use link in the description fail 3.1.2', () => {
    const result = runAudit(guidelineRules, baseFacts({ hasSubscriptions: true }));
    expect(finding(result, 'payments.subscription-terms').status).toBe('fail');
  });

  it('passes with a Terms link in the description or a custom EULA', () => {
    const viaLink = runAudit(
      guidelineRules,
      baseFacts({
        hasSubscriptions: true,
        descriptions: [{ locale: 'en-US', text: 'Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' }],
      }),
    );
    expect(finding(viaLink, 'payments.subscription-terms').status).toBe('pass');

    const viaEula = runAudit(guidelineRules, baseFacts({ hasSubscriptions: true, hasCustomEula: true }));
    expect(finding(viaEula, 'payments.subscription-terms').status).toBe('pass');
  });

  it('does not apply payments rules to apps without subscriptions', () => {
    const result = runAudit(guidelineRules, baseFacts());
    expect(result.findings.map((f) => f.ruleId)).not.toContain('payments.subscription-terms');
  });
});

describe('completeness rules', () => {
  it('always raises the demo-account judgment item (guideline 2.1)', () => {
    const result = runAudit(guidelineRules, baseFacts());
    expect(finding(result, 'completeness.demo-account').status).toBe('needs_judgment');
  });
});
