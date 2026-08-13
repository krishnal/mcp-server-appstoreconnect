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
