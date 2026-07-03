/**
 * Core MCP method registration.
 *
 * To add a protocol method (new spec revision, experimental extension):
 * write a `MethodDefinition` module and register it here — one line.
 */
import {
  initializeMethod,
  initializedNotification,
  pingMethod,
  setLoggingLevelMethod,
} from './lifecycle.js';
import {
  promptsGetMethod,
  promptsListMethod,
} from './prompts.js';
import {
  resourceTemplatesListMethod,
  resourcesListMethod,
  resourcesReadMethod,
  resourcesSubscribeMethod,
  resourcesUnsubscribeMethod,
} from './resources.js';
import { toolsCallMethod, toolsListMethod } from './tools.js';
import { MethodRegistry } from './types.js';

export function createCoreMethodRegistry(): MethodRegistry {
  return new MethodRegistry()
    .register(initializeMethod)
    .register(initializedNotification)
    .register(pingMethod)
    .register(setLoggingLevelMethod)
    .register(toolsListMethod)
    .register(toolsCallMethod)
    .register(resourcesListMethod)
    .register(resourceTemplatesListMethod)
    .register(resourcesReadMethod)
    .register(resourcesSubscribeMethod)
    .register(resourcesUnsubscribeMethod)
    .register(promptsListMethod)
    .register(promptsGetMethod);
}

export { MethodRegistry } from './types.js';
export type { MethodContext, MethodDefinition, MethodDependencies } from './types.js';
