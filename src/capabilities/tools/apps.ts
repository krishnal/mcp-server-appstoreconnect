/**
 * list_apps — discovery entry point: resolves App Store Connect app ids so
 * users can set ASC_APP_ID (or pass appId per call).
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import { jsonResult, requireAsc } from './shared.js';

export const listAppsTool = defineTool({
  name: 'list_apps',
  title: 'List apps',
  description:
    'Lists apps in App Store Connect (id, name, bundle id). Use the id as appId in the feedback tools, or set ASC_APP_ID to skip passing it.',
  inputSchema: z.object({
    bundleId: z.string().optional().describe('Filter by exact bundle id, e.g. "com.example.app"'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ bundleId }, ctx) => {
    const asc = requireAsc(ctx);
    const apps = await asc.listApps({ bundleId }, ctx.signal);
    if (apps.length === 0) {
      return jsonResult({ apps: [], note: 'No apps visible to this API key.' });
    }
    return jsonResult({ apps });
  },
});
