/**
 * download_screenshot — persists tester screenshots locally (Apple's URLs are
 * signed and expire) and, by default, embeds them so the calling model can
 * look at them immediately.
 */
import { z } from 'zod';
import { defineTool } from '../../core/registry/define.js';
import {
  ensureScreenshots,
  errorResult,
  imageBlocks,
  jsonResult,
  loadFeedback,
  notFoundMessage,
} from './shared.js';

export const downloadScreenshotTool = defineTool({
  name: 'download_screenshot',
  title: 'Download screenshots',
  description:
    'Downloads all screenshots of a feedback item into SCREENSHOTS_DIR ' +
    '(default ~/.mcp-server-appstoreconnect/screenshots/<feedbackId>/) ' +
    'and returns the local file paths. By default also embeds the images so you can analyze them directly. ' +
    'Expired signed URLs are refreshed automatically.',
  inputSchema: z.object({
    feedbackId: z.string().describe('Screenshot feedback id'),
    embed: z
      .boolean()
      .default(true)
      .describe('Embed the images in the response (up to 3) in addition to returning paths'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ feedbackId, embed }, ctx) => {
    const stored = await loadFeedback(ctx, feedbackId);
    if (!stored) return errorResult(notFoundMessage(feedbackId));
    if (stored.item.kind !== 'screenshot') {
      return errorResult(
        `Feedback "${feedbackId}" is a crash report — it has no screenshots. Use get_crash_log instead.`,
      );
    }
    if (stored.item.screenshots.length === 0) {
      return jsonResult({
        feedbackId,
        screenshots: [],
        note: 'This feedback has no screenshots attached.',
      });
    }

    const shots = await ensureScreenshots(ctx, stored);
    const payload = {
      feedbackId,
      screenshots: shots.map((shot) => ({ index: shot.idx, path: shot.path })),
    };

    return {
      content: [
        { type: 'text', text: JSON.stringify(payload, null, 2) },
        ...(embed ? await imageBlocks(shots) : []),
      ],
    };
  },
});
