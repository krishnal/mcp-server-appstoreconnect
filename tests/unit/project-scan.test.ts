import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/audit/project-scan.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-project');

describe('scanProject', () => {
  it('collects purpose strings, entitlements, and the privacy manifest', async () => {
    const facts = await scanProject(FIXTURE);
    expect(facts.purposeStrings).toEqual({
      NSCameraUsageDescription: 'Uses the camera to scan handwritten recipes so you can save them as cards.',
      NSPhotoLibraryUsageDescription: '',
    });
    expect(facts.entitlementKeys).toContain('com.apple.developer.applesignin');
    expect(facts.privacyManifestFound).toBe(true);
    expect(facts.infoPlistPaths).toHaveLength(1);
    expect(facts.warnings).toEqual([]);
  });

  it('ignores build output directories', async () => {
    const facts = await scanProject(FIXTURE);
    expect(facts.purposeStrings).not.toHaveProperty('NSDecoyUsageDescription');
  });

  it('throws a readable error for a missing path', async () => {
    await expect(scanProject(join(FIXTURE, 'no-such-dir'))).rejects.toThrow(/projectPath/);
  });
});
