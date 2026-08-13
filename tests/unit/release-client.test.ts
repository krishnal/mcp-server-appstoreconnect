import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AscReleaseClient } from '../../src/asc/release-client.js';
import type { AscTokenProvider } from '../../src/asc/token-provider.js';
import { createSilentLogger } from '../../src/observability/logger.js';

const BASE = 'https://asc.test';

class FakeTokens {
  async getToken(): Promise<string> {
    return 'token-1';
  }
  invalidate(): void {}
}

let agent: MockAgent;
let original: Dispatcher;
let client: AscReleaseClient;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  client = new AscReleaseClient({
    baseUrl: BASE,
    tokenProvider: new FakeTokens() as unknown as AscTokenProvider,
    logger: createSilentLogger(),
  });
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

function pool() {
  return agent.get(BASE);
}

describe('read surface', () => {
  it('listBuilds maps build resources newest-first', async () => {
    pool()
      .intercept({ path: /\/v1\/builds\?.*filter%5Bapp%5D=app-1.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'builds',
            id: 'build-2',
            attributes: {
              version: '422',
              uploadedDate: '2026-08-10T00:00:00Z',
              processingState: 'VALID',
              expired: false,
              usesNonExemptEncryption: null,
            },
          },
        ],
      });

    const builds = await client.listBuilds('app-1');
    expect(builds).toEqual([
      {
        id: 'build-2',
        version: '422',
        uploadedDate: '2026-08-10T00:00:00Z',
        processingState: 'VALID',
        expired: false,
        usesNonExemptEncryption: null,
      },
    ]);
  });

  it('listVersions reads appVersionState with appStoreState fallback and includes the build', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appStoreVersions.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appStoreVersions',
            id: 'v-1',
            attributes: {
              versionString: '2.4.0',
              platform: 'IOS',
              appVersionState: 'PREPARE_FOR_SUBMISSION',
              releaseType: 'AFTER_APPROVAL',
              createdDate: '2026-08-01T00:00:00Z',
            },
            relationships: { build: { data: { type: 'builds', id: 'build-2' } } },
          },
          {
            type: 'appStoreVersions',
            id: 'v-0',
            attributes: { versionString: '2.3.0', appStoreState: 'READY_FOR_SALE' },
          },
        ],
        included: [{ type: 'builds', id: 'build-2', attributes: { version: '422' } }],
      });

    const versions = await client.listVersions('app-1');
    expect(versions[0]).toMatchObject({
      id: 'v-1',
      versionString: '2.4.0',
      state: 'PREPARE_FOR_SUBMISSION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-2',
      buildVersion: '422',
    });
    expect(versions[1]).toMatchObject({ id: 'v-0', state: 'READY_FOR_SALE' });
  });

  it('listScreenshotSets counts included screenshots per set', async () => {
    pool()
      .intercept({ path: /\/v1\/appStoreVersionLocalizations\/loc-1\/appScreenshotSets.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appScreenshotSets',
            id: 'set-1',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
            relationships: {
              appScreenshots: {
                data: [
                  { type: 'appScreenshots', id: 's1' },
                  { type: 'appScreenshots', id: 's2' },
                ],
              },
            },
          },
        ],
      });

    const sets = await client.listScreenshotSets('loc-1');
    expect(sets).toEqual([{ id: 'set-1', displayType: 'APP_IPHONE_67', screenshotCount: 2 }]);
  });

  it('getAppInfo combines localizations and the age rating declaration', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appInfos.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'appInfos', id: 'info-1', attributes: {} }] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/appInfoLocalizations.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'appInfoLocalizations',
            id: 'il-1',
            attributes: { locale: 'en-US', privacyPolicyUrl: 'https://example.com/privacy' },
          },
        ],
      });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/ageRatingDeclaration.*/, method: 'GET' })
      .reply(200, {
        data: { type: 'ageRatingDeclarations', id: 'ar-1', attributes: { inAppControls: 'PARENTAL_CONTROLS' } },
      });

    const info = await client.getAppInfo('app-1');
    expect(info).toEqual({
      appInfoId: 'info-1',
      privacyPolicyUrl: 'https://example.com/privacy',
      ageRating: { declared: true, inAppControls: 'PARENTAL_CONTROLS' },
    });
  });

  it('getAppInfo marks the age rating undeclared on 404', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/appInfos.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'appInfos', id: 'info-1', attributes: {} }] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/appInfoLocalizations.*/, method: 'GET' })
      .reply(200, { data: [] });
    pool()
      .intercept({ path: /\/v1\/appInfos\/info-1\/ageRatingDeclaration.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });

    const info = await client.getAppInfo('app-1');
    expect(info).toEqual({ appInfoId: 'info-1', privacyPolicyUrl: undefined, ageRating: { declared: false } });
  });

  it('hasSubscriptions / hasCustomEula map presence and 404', async () => {
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/subscriptionGroups.*/, method: 'GET' })
      .reply(200, { data: [{ type: 'subscriptionGroups', id: 'sg-1' }] });
    pool()
      .intercept({ path: /\/v1\/apps\/app-1\/endUserLicenseAgreement.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });

    expect(await client.hasSubscriptions('app-1')).toBe(true);
    expect(await client.hasCustomEula('app-1')).toBe(false);
  });

  it('getPhasedRelease and getBuildBetaDetail return undefined on 404', async () => {
    pool()
      .intercept({ path: /\/v1\/appStoreVersions\/v-1\/appStoreVersionPhasedRelease.*/, method: 'GET' })
      .reply(404, { errors: [{ status: '404' }] });
    pool()
      .intercept({ path: /\/v1\/builds\/b-1\/buildBetaDetail.*/, method: 'GET' })
      .reply(200, {
        data: { type: 'buildBetaDetails', id: 'bd-1', attributes: { externalBuildState: 'READY_FOR_BETA_SUBMISSION' } },
      });

    expect(await client.getPhasedRelease('v-1')).toBeUndefined();
    expect(await client.getBuildBetaDetail('b-1')).toMatchObject({
      externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    });
  });

  it('listReviewSubmissions filters by app', async () => {
    pool()
      .intercept({ path: /\/v1\/reviewSubmissions\?.*filter%5Bapp%5D=app-1.*/, method: 'GET' })
      .reply(200, {
        data: [
          {
            type: 'reviewSubmissions',
            id: 'rs-1',
            attributes: { state: 'WAITING_FOR_REVIEW', platform: 'IOS', submittedDate: '2026-08-11T00:00:00Z' },
          },
        ],
      });

    expect(await client.listReviewSubmissions('app-1')).toEqual([
      { id: 'rs-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS', submittedDate: '2026-08-11T00:00:00Z' },
    ]);
  });
});

describe('write surface', () => {
  function captureBody(path: string | RegExp, method: 'POST' | 'PATCH', statusCode: number, data: unknown) {
    const captured: { body?: unknown } = {};
    pool()
      .intercept({
        path,
        method,
        body: (b) => {
          captured.body = JSON.parse(b);
          return true;
        },
      })
      .reply(statusCode, data === undefined ? '' : { data });
    return captured;
  }

  it('createVersion posts the JSON:API document and returns a summary', async () => {
    const captured = captureBody('/v1/appStoreVersions', 'POST', 201, {
      type: 'appStoreVersions',
      id: 'v-9',
      attributes: { versionString: '2.4.0', appVersionState: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL' },
    });

    const version = await client.createVersion('app-1', {
      versionString: '2.4.0',
      platform: 'IOS',
      releaseType: 'MANUAL',
    });
    expect(version).toMatchObject({ id: 'v-9', versionString: '2.4.0', state: 'PREPARE_FOR_SUBMISSION' });
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersions',
        attributes: { versionString: '2.4.0', platform: 'IOS', releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });
  });

  it('setVersionBuild PATCHes the build relationship', async () => {
    const captured = captureBody('/v1/appStoreVersions/v-9/relationships/build', 'PATCH', 204, undefined);
    await client.setVersionBuild('v-9', 'build-2');
    expect(captured.body).toEqual({ data: { type: 'builds', id: 'build-2' } });
  });

  it('updateLocalization PATCHes whatsNew', async () => {
    const captured = captureBody('/v1/appStoreVersionLocalizations/loc-1', 'PATCH', 200, {
      type: 'appStoreVersionLocalizations',
      id: 'loc-1',
    });
    await client.updateLocalization('loc-1', { whatsNew: 'Bug fixes.' });
    expect(captured.body).toEqual({
      data: { type: 'appStoreVersionLocalizations', id: 'loc-1', attributes: { whatsNew: 'Bug fixes.' } },
    });
  });

  it('review submission lifecycle: create, add item, submit', async () => {
    const create = captureBody('/v1/reviewSubmissions', 'POST', 201, {
      type: 'reviewSubmissions',
      id: 'rs-9',
      attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS' },
    });
    const item = captureBody('/v1/reviewSubmissionItems', 'POST', 201, {
      type: 'reviewSubmissionItems',
      id: 'item-1',
    });
    const submit = captureBody('/v1/reviewSubmissions/rs-9', 'PATCH', 200, {
      type: 'reviewSubmissions',
      id: 'rs-9',
      attributes: { state: 'WAITING_FOR_REVIEW' },
    });

    const submission = await client.createReviewSubmission('app-1', 'IOS');
    expect(submission).toMatchObject({ id: 'rs-9', state: 'READY_FOR_REVIEW' });
    expect(create.body).toEqual({
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });

    await client.addReviewSubmissionItem('rs-9', 'v-9');
    expect(item.body).toEqual({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: 'rs-9' } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } },
        },
      },
    });

    const submitted = await client.submitReviewSubmission('rs-9');
    expect(submitted.state).toBe('WAITING_FOR_REVIEW');
    expect(submit.body).toEqual({
      data: { type: 'reviewSubmissions', id: 'rs-9', attributes: { submitted: true } },
    });
  });

  it('setExportCompliance PATCHes the build attribute', async () => {
    const captured = captureBody('/v1/builds/build-2', 'PATCH', 200, { type: 'builds', id: 'build-2' });
    await client.setExportCompliance('build-2', false);
    expect(captured.body).toEqual({
      data: { type: 'builds', id: 'build-2', attributes: { usesNonExemptEncryption: false } },
    });
  });

  it('submitForBetaReview and addBuildToBetaGroups post relationships', async () => {
    const beta = captureBody('/v1/betaAppReviewSubmissions', 'POST', 201, {
      type: 'betaAppReviewSubmissions',
      id: 'bars-1',
    });
    const groups = captureBody('/v1/builds/build-2/relationships/betaGroups', 'POST', 204, undefined);

    await client.submitForBetaReview('build-2');
    expect(beta.body).toEqual({
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: { build: { data: { type: 'builds', id: 'build-2' } } },
      },
    });

    await client.addBuildToBetaGroups('build-2', ['g-1', 'g-2']);
    expect(groups.body).toEqual({
      data: [
        { type: 'betaGroups', id: 'g-1' },
        { type: 'betaGroups', id: 'g-2' },
      ],
    });
  });

  it('createReleaseRequest posts the version relationship', async () => {
    const captured = captureBody('/v1/appStoreVersionReleaseRequests', 'POST', 201, {
      type: 'appStoreVersionReleaseRequests',
      id: 'rr-1',
    });
    await client.createReleaseRequest('v-9');
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } } },
      },
    });
  });

  it('createPhasedRelease posts the version relationship and returns state', async () => {
    const captured = captureBody('/v1/appStoreVersionPhasedReleases', 'POST', 201, {
      type: 'appStoreVersionPhasedReleases',
      id: 'pr-1',
      attributes: { phasedReleaseState: 'INACTIVE' },
    });
    const phased = await client.createPhasedRelease('v-9');
    expect(phased).toMatchObject({ id: 'pr-1', phasedReleaseState: 'INACTIVE' });
    expect(captured.body).toEqual({
      data: {
        type: 'appStoreVersionPhasedReleases',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-9' } } },
      },
    });
  });
});
