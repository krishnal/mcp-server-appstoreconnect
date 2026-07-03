/**
 * App Store Connect API types.
 *
 * Wire types cover only the slice of the JSON:API surface this server uses:
 * apps, beta feedback screenshot/crash submissions (App Store Connect API 4.0),
 * and crash logs. Domain types (`FeedbackItem`) are the normalized shape the
 * rest of the codebase works with — storage, analysis, and tools never touch
 * raw JSON:API resources.
 */

// ---------------------------------------------------------------------------
// Wire types (JSON:API)
// ---------------------------------------------------------------------------

export interface AscResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<
    string,
    { data?: { type: string; id: string } | { type: string; id: string }[] | null }
  >;
}

export interface AscListResponse<A = Record<string, unknown>> {
  data: AscResource<A>[];
  included?: AscResource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export interface AscSingleResponse<A = Record<string, unknown>> {
  data: AscResource<A>;
  included?: AscResource[];
}

export interface AscErrorBody {
  errors?: {
    id?: string;
    status?: string;
    code?: string;
    title?: string;
    detail?: string;
  }[];
}

export interface AppAttributes {
  name?: string;
  bundleId?: string;
  sku?: string;
  primaryLocale?: string;
}

export interface BuildAttributes {
  version?: string;
  uploadedDate?: string;
  expired?: boolean;
  processingState?: string;
}

/** Shared by screenshot and crash feedback submissions. */
export interface FeedbackSubmissionAttributes {
  createdDate?: string;
  comment?: string;
  email?: string;
  deviceModel?: string;
  osVersion?: string;
  locale?: string;
  timeZone?: string;
  architecture?: string;
  connectionType?: string;
  pairedAppleWatch?: string;
  appUptimeInMilliseconds?: number;
  diskBytesAvailable?: number;
  diskBytesTotal?: number;
  batteryPercentage?: number;
  screenWidthInPoints?: number;
  screenHeightInPoints?: number;
  appPlatform?: string;
  devicePlatform?: string;
  deviceFamily?: string;
  buildBundleId?: string;
  /** Screenshot submissions only. */
  screenshots?: ScreenshotImage[];
}

export interface ScreenshotImage {
  /** Signed CDN URL — expires; download promptly and persist locally. */
  url?: string;
  expirationDate?: string;
  width?: number;
  height?: number;
}

export interface CrashLogAttributes {
  logText?: string;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type FeedbackKind = 'screenshot' | 'crash';

export interface DeviceContext {
  model?: string;
  osVersion?: string;
  platform?: string;
  deviceFamily?: string;
  locale?: string;
  timeZone?: string;
  architecture?: string;
  connectionType?: string;
  batteryPercentage?: number;
  screenWidthInPoints?: number;
  screenHeightInPoints?: number;
  diskBytesAvailable?: number;
  diskBytesTotal?: number;
  appUptimeInMilliseconds?: number;
  pairedAppleWatch?: string;
}

/** Normalized TestFlight feedback item (screenshot or crash submission). */
export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  appId: string;
  createdDate: string;
  comment?: string;
  email?: string;
  /** Build number (e.g. "421") from the included build resource. */
  buildNumber?: string;
  buildId?: string;
  bundleId?: string;
  appPlatform?: string;
  device: DeviceContext;
  /** Screenshot submissions only; URLs are signed and expire. */
  screenshots: ScreenshotImage[];
}

export interface AppSummary {
  id: string;
  name?: string;
  bundleId?: string;
}

export interface FeedbackListFilters {
  build?: string;
  preReleaseVersion?: string;
  deviceModel?: string;
  osVersion?: string;
  devicePlatform?: string;
  /** Max items to return across pages (server page size is capped at 200). */
  limit?: number;
  sort?: 'createdDate' | '-createdDate';
}

/** Typed App Store Connect API error, safe to surface to the calling LLM. */
export class AscApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AscApiError';
  }
}
