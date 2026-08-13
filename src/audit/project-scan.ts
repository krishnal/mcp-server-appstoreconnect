/**
 * Local Xcode-project scan for audit facts the ASC API cannot provide:
 * purpose strings (Info.plist), entitlements, and privacy manifests. The scan
 * degrades, never crashes the audit: unreadable/unparsable files become
 * `warnings`; only an unreadable root path throws. Info.plist purpose strings
 * are merged across app targets; every plist path found is reported so an
 * ambiguous multi-target project is visible to the caller.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parsePlist } from 'plist';
import type { ProjectFacts } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'Pods',
  'Carthage',
  'DerivedData',
  'build',
  'Build',
  '.build',
  'dist',
]);
const MAX_DEPTH = 8;

export async function scanProject(projectPath: string): Promise<ProjectFacts> {
  const infoPlistPaths: string[] = [];
  const entitlementPaths: string[] = [];
  let privacyManifestFound = false;
  const warnings: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) {
        throw new Error(`Cannot read projectPath "${projectPath}": ${(err as Error).message}`);
      }
      warnings.push(`Unreadable directory skipped: ${dir}`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.name === 'Info.plist') {
        infoPlistPaths.push(full);
      } else if (entry.name.endsWith('.entitlements')) {
        entitlementPaths.push(full);
      } else if (entry.name === 'PrivacyInfo.xcprivacy') {
        privacyManifestFound = true;
      }
    }
  }
  await walk(projectPath, 0);

  const purposeStrings: Record<string, string> = {};
  for (const path of infoPlistPaths) {
    const parsed = await parsePlistFile(path, warnings);
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (key.endsWith('UsageDescription') && typeof value === 'string') {
        purposeStrings[key] = value;
      }
    }
  }

  const entitlementKeys = new Set<string>();
  for (const path of entitlementPaths) {
    const parsed = await parsePlistFile(path, warnings);
    for (const key of Object.keys(parsed ?? {})) entitlementKeys.add(key);
  }

  return {
    infoPlistPaths,
    purposeStrings,
    entitlementKeys: [...entitlementKeys],
    privacyManifestFound,
    warnings,
  };
}

async function parsePlistFile(
  path: string,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = parsePlist(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnings.push(`Not a dictionary plist: ${path}`);
    return undefined;
  } catch (err) {
    warnings.push(`Could not parse ${path}: ${(err as Error).message}`);
    return undefined;
  }
}
