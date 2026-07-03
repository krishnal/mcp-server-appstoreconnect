/**
 * AI feedback analysis — dual-mode by design.
 *
 * The MCP host (Claude Code, Claude Desktop, ...) IS a vision model, so the
 * default mode needs no API key: `analyze_feedback` hands the host the
 * screenshots + device context + the instructions in `hostAnalysisPrompt()`,
 * and the host persists its own analysis via `save_analysis`.
 *
 * When ANTHROPIC_API_KEY is configured, this class analyzes autonomously by
 * calling Claude with vision + structured outputs (`messages.parse` validates
 * the response against the shared Zod schema). Both paths store the same
 * shape — downstream consumers never know the difference.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { FeedbackItem } from '../asc/types.js';
import type { Logger } from '../observability/logger.js';
import { analysisSchema, type FeedbackAnalysis } from './schema.js';

export interface AnalyzerImage {
  /** base64-encoded image data */
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface AnalyzerOptions {
  apiKey?: string;
  model: string;
  logger: Logger;
}

const SYSTEM_PROMPT =
  'You are a senior mobile engineer triaging TestFlight beta feedback. ' +
  'Analyze the tester\'s screenshot(s), comment, and device context, and produce a precise, ' +
  'actionable structured analysis. Identify the visible screen, the concrete problem ' +
  '(UI defect, layout break, wrong data, crash, ...), the likely component, a severity, and a fix approach. ' +
  'Be specific about what is visible in the screenshot; do not speculate beyond the evidence.';

export class FeedbackAnalyzer {
  private readonly client: Anthropic | undefined;
  readonly model: string;
  private readonly logger: Logger;

  constructor(options: AnalyzerOptions) {
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : undefined;
    this.model = options.model;
    this.logger = options.logger;
  }

  /** True when server-side (autonomous) analysis is available. */
  get enabled(): boolean {
    return this.client !== undefined;
  }

  /** Autonomous analysis via the Claude API. Requires ANTHROPIC_API_KEY. */
  async analyze(
    item: FeedbackItem,
    images: AnalyzerImage[],
    crashLog?: string,
    signal?: AbortSignal,
  ): Promise<FeedbackAnalysis> {
    if (!this.client) {
      throw new Error(
        'Server-side analysis is not configured (set ANTHROPIC_API_KEY), ' +
          'or perform the analysis yourself and persist it with save_analysis.',
      );
    }

    const content: Anthropic.ContentBlockParam[] = images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }));
    content.push({ type: 'text', text: buildContextText(item, crashLog) });

    this.logger.info({ feedbackId: item.id, images: images.length }, 'analyzing feedback via Claude');

    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          output_config: { format: zodOutputFormat(analysisSchema) },
        },
        { signal },
      );
      if (!response.parsed_output) {
        throw new Error('Claude returned no parseable analysis — try again or analyze manually');
      }
      return response.parsed_output;
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error('Claude API rate limit hit — retry shortly');
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error('ANTHROPIC_API_KEY is invalid');
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Claude API error (${String(err.status)}): ${err.message}`);
      }
      throw err;
    }
  }
}

/** Device/feedback context shared by both analysis modes. */
export function buildContextText(item: FeedbackItem, crashLog?: string): string {
  const device = item.device;
  const lines = [
    `TestFlight ${item.kind} feedback ${item.id}`,
    `Submitted: ${item.createdDate}`,
    item.buildNumber ? `Build: ${item.buildNumber}` : undefined,
    item.bundleId ? `Bundle: ${item.bundleId}` : undefined,
    device.model ? `Device: ${device.model} (${device.deviceFamily ?? 'unknown family'})` : undefined,
    device.osVersion ? `OS: ${device.platform ?? ''} ${device.osVersion}`.trim() : undefined,
    device.locale ? `Locale: ${device.locale} · TZ: ${device.timeZone ?? '?'}` : undefined,
    device.connectionType ? `Connection: ${device.connectionType}` : undefined,
    device.batteryPercentage !== undefined ? `Battery: ${device.batteryPercentage}%` : undefined,
    device.appUptimeInMilliseconds !== undefined
      ? `App uptime: ${Math.round(device.appUptimeInMilliseconds / 1000)}s`
      : undefined,
    device.diskBytesAvailable !== undefined
      ? `Disk free: ${(device.diskBytesAvailable / 1e9).toFixed(1)} GB of ${((device.diskBytesTotal ?? 0) / 1e9).toFixed(1)} GB`
      : undefined,
    '',
    item.comment ? `Tester comment:\n${item.comment}` : 'No tester comment provided.',
  ].filter((line): line is string => line !== undefined);

  if (crashLog) {
    lines.push('', 'Crash log (truncated):', crashLog.slice(0, 20_000));
  }
  return lines.join('\n');
}

/**
 * Instructions handed to the MCP host model in host-delegated mode.
 * The host sees the screenshots as image blocks in the same tool result.
 */
export function hostAnalysisPrompt(feedbackId: string): string {
  return [
    'Analyze this TestFlight feedback using the screenshot(s) and context above.',
    'Determine: the affected screen/feature, the concrete problem, the suspected UI component,',
    'a severity (critical | high | medium | low), your confidence (0.0-1.0), and a suggested fix approach.',
    `Then persist your analysis by calling the save_analysis tool with feedbackId "${feedbackId}".`,
  ].join(' ');
}
