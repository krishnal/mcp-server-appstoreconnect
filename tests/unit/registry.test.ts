import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry } from '../../src/core/registry/capability-registry.js';
import { defineResource, defineResourceTemplate, defineTool } from '../../src/core/registry/define.js';
import { compileUriTemplate } from '../../src/core/registry/uri-template.js';

const dummyTool = (name: string) =>
  defineTool({
    name,
    description: 'test tool',
    inputSchema: z.object({ value: z.string().describe('a value') }),
    handler: () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });

describe('CapabilityRegistry', () => {
  it('converts Zod schemas to JSON Schema in tools/list entries', () => {
    const registry = new CapabilityRegistry();
    registry.registerTool(dummyTool('echo'));

    const [entry] = registry.listTools();
    expect(entry?.name).toBe('echo');
    expect(entry?.inputSchema['type']).toBe('object');
    const properties = entry?.inputSchema['properties'] as Record<string, unknown>;
    expect(properties['value']).toMatchObject({ type: 'string', description: 'a value' });
    expect(entry?.inputSchema['$schema']).toBeUndefined();
  });

  it('rejects duplicate and invalid tool names', () => {
    const registry = new CapabilityRegistry();
    registry.registerTool(dummyTool('echo'));
    expect(() => registry.registerTool(dummyTool('echo'))).toThrow(/already registered/);
    expect(() => registry.registerTool(dummyTool('bad name!'))).toThrow(/Invalid tool name/);
  });

  it('resolves direct resources and template matches', () => {
    const registry = new CapabilityRegistry();
    registry.registerResource(
      defineResource({
        uri: 'system://info',
        name: 'info',
        handler: () => [{ uri: 'system://info', text: '{}' }],
      }),
    );
    registry.registerResourceTemplate(
      defineResourceTemplate({
        uriTemplate: 'docs://{+path}',
        name: 'docs',
        handler: () => [],
      }),
    );

    expect(registry.findResource('system://info')?.kind).toBe('direct');
    const match = registry.findResource('docs://guides/setup.md');
    expect(match?.kind).toBe('template');
    if (match?.kind === 'template') {
      expect(match.params).toEqual({ path: 'guides/setup.md' });
    }
    expect(registry.findResource('nope://x')).toBeUndefined();
  });

  it('advertises capabilities based on what is registered', () => {
    const registry = new CapabilityRegistry();
    expect(registry.serverCapabilities().tools).toBeUndefined();
    registry.registerTool(dummyTool('echo'));
    expect(registry.serverCapabilities()).toMatchObject({
      tools: { listChanged: true },
      logging: {},
    });
  });

  it('emits list-changed events to subscribers', () => {
    const registry = new CapabilityRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.onListChanged(listener);
    registry.registerTool(dummyTool('echo'));
    expect(listener).toHaveBeenCalledWith('tools');
    unsubscribe();
    registry.registerTool(dummyTool('echo2'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('uri templates', () => {
  it('{var} matches a single segment only', () => {
    const compiled = compileUriTemplate('users://{id}/profile');
    expect(compiled.match('users://42/profile')).toEqual({ id: '42' });
    expect(compiled.match('users://42/extra/profile')).toBeUndefined();
  });

  it('{+var} matches across slashes and decodes URI escapes', () => {
    const compiled = compileUriTemplate('docs://{+path}');
    expect(compiled.match('docs://a/b/c.md')).toEqual({ path: 'a/b/c.md' });
    expect(compiled.match('docs://hello%20world.md')).toEqual({ path: 'hello world.md' });
  });
});
