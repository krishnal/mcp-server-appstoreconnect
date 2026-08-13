import { describe, expect, it } from 'vitest';
import { buildReadinessReport, type ReadinessFacts } from '../../src/asc/readiness.js';

function readyFacts(): ReadinessFacts {
  return {
    version: {
      id: 'v-1',
      versionString: '2.4.0',
      state: 'PREPARE_FOR_SUBMISSION',
      buildId: 'build-2',
    },
    build: { id: 'build-2', version: '422', processingState: 'VALID', expired: false, usesNonExemptEncryption: false },
    localizations: [{ id: 'loc-1', locale: 'en-US', description: 'A great app.', whatsNew: 'Fixes.' }],
    screenshotSets: new Map([['loc-1', [{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 3 }]]]),
    reviewDetail: { id: 'rd-1', contactEmail: 'dev@example.com', contactFirstName: 'Dev' },
    appInfo: { appInfoId: 'info-1', privacyPolicyUrl: 'https://example.com/privacy', ageRating: { declared: true } },
  };
}

function checkByName(report: ReturnType<typeof buildReadinessReport>, name: string) {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`missing check ${name}`);
  return check;
}

describe('buildReadinessReport', () => {
  it('is ready when every check passes', () => {
    const report = buildReadinessReport(readyFacts());
    expect(report.ready).toBe(true);
    expect(report.versionId).toBe('v-1');
    expect(report.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('fails without an editable version and mentions prepare_app_store_version', () => {
    const report = buildReadinessReport({ ...readyFacts(), version: undefined, build: undefined });
    expect(report.ready).toBe(false);
    expect(checkByName(report, 'version-exists')).toMatchObject({ status: 'fail' });
    expect(checkByName(report, 'version-exists').detail).toMatch(/prepare_app_store_version/);
  });

  it('fails when no build is attached', () => {
    const facts = readyFacts();
    facts.version = { ...facts.version!, buildId: undefined };
    facts.build = undefined;
    const report = buildReadinessReport(facts);
    expect(checkByName(report, 'build-attached').status).toBe('fail');
  });

  it('fails on unprocessed or expired builds', () => {
    const facts = readyFacts();
    facts.build = { ...facts.build!, processingState: 'PROCESSING' };
    expect(checkByName(buildReadinessReport(facts), 'build-processed').status).toBe('fail');
    facts.build = { ...facts.build!, processingState: 'VALID', expired: true };
    expect(checkByName(buildReadinessReport(facts), 'build-processed').status).toBe('fail');
  });

  it('fails when export compliance is unanswered', () => {
    const facts = readyFacts();
    facts.build = { ...facts.build!, usesNonExemptEncryption: null };
    const check = checkByName(buildReadinessReport(facts), 'export-compliance');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/distribute_build/);
  });

  it('fails on missing description, privacy policy, review contact, age rating; warns on missing whatsNew and screenshots', () => {
    const facts = readyFacts();
    facts.localizations = [{ id: 'loc-1', locale: 'en-US' }];
    facts.screenshotSets = new Map([['loc-1', []]]);
    facts.reviewDetail = undefined;
    facts.appInfo = { appInfoId: 'info-1', ageRating: { declared: false } };
    const report = buildReadinessReport(facts);
    expect(checkByName(report, 'description').status).toBe('fail');
    expect(checkByName(report, 'whats-new').status).toBe('warn');
    expect(checkByName(report, 'screenshots').status).toBe('fail');
    expect(checkByName(report, 'privacy-policy').status).toBe('fail');
    expect(checkByName(report, 'review-contact').status).toBe('fail');
    expect(checkByName(report, 'age-rating').status).toBe('fail');
    expect(report.ready).toBe(false);
  });
});
