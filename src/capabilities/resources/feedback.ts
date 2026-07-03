/**
 * feedback://{id} — feedback as an MCP resource, so hosts can attach items to
 * conversations without a tool round-trip. Served from the local cache
 * (populate it with list_feedback / get_feedback).
 */
import { JsonRpcError } from '../../core/jsonrpc/errors.js';
import { defineResourceTemplate } from '../../core/registry/define.js';

export const feedbackResourceTemplate = defineResourceTemplate({
  uriTemplate: 'feedback://{id}',
  name: 'testflight-feedback',
  title: 'TestFlight feedback item',
  description:
    'A cached TestFlight feedback item as JSON, including processed state, analysis, TODO and linked issues.',
  mimeType: 'application/json',
  handler: (uri, params, ctx) => {
    const id = params['id'] ?? '';
    const stored = ctx.services.store.getFeedback(id);
    if (!stored) throw JsonRpcError.resourceNotFound(uri);
    return [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            ...stored.item,
            processed: stored.processed,
            processedAt: stored.processedAt,
            processedNote: stored.processedNote,
            analysis: ctx.services.store.getAnalysis(id)?.analysis,
            todo: ctx.services.store.getTodo(id),
            issues: ctx.services.store.getIssues(id),
          },
          null,
          2,
        ),
      },
    ];
  },
});
