/**
 * Capability manifest — THE plug-in point for new functionality.
 *
 * To add a capability:
 *   1. create a module under tools/, resources/ or prompts/
 *      (schema + handler; see the existing tools),
 *   2. register it here.
 * Nothing else changes: `tools/list` & friends, JSON Schema generation,
 * validation, auth scopes, metrics and tracing all light up automatically.
 */
import type { CapabilityRegistry } from '../core/registry/capability-registry.js';
import { triageFeedbackPrompt } from './prompts/triage-feedback.js';
import { feedbackResourceTemplate } from './resources/feedback.js';
import { analyzeFeedbackTool, saveAnalysisTool } from './tools/analyze.js';
import { listAppsTool } from './tools/apps.js';
import {
  getCrashLogTool,
  getFeedbackTool,
  listFeedbackTool,
  listUnprocessedTool,
  markProcessedTool,
  markUnprocessedTool,
} from './tools/feedback.js';
import { createIssueTool } from './tools/issues.js';
import { downloadScreenshotTool } from './tools/screenshots.js';
import {
  generateTodoTool,
  groupDuplicatesTool,
  prioritizeFeedbackTool,
} from './tools/triage.js';

export function registerAllCapabilities(registry: CapabilityRegistry): void {
  registry
    // Discovery & retrieval
    .registerTool(listAppsTool)
    .registerTool(listFeedbackTool)
    .registerTool(getFeedbackTool)
    .registerTool(getCrashLogTool)
    .registerTool(downloadScreenshotTool)
    // Local state
    .registerTool(listUnprocessedTool)
    .registerTool(markProcessedTool)
    .registerTool(markUnprocessedTool)
    // AI analysis & triage
    .registerTool(analyzeFeedbackTool)
    .registerTool(saveAnalysisTool)
    .registerTool(generateTodoTool)
    .registerTool(groupDuplicatesTool)
    .registerTool(prioritizeFeedbackTool)
    // Integrations
    .registerTool(createIssueTool)
    // Resources & prompts
    .registerResourceTemplate(feedbackResourceTemplate)
    .registerPrompt(triageFeedbackPrompt);
}
