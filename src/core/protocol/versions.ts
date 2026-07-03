/**
 * MCP protocol version negotiation.
 *
 * When the protocol evolves, add the new revision at the FRONT of
 * `SUPPORTED_PROTOCOL_VERSIONS` and implement any behavioral deltas where
 * needed — nothing else in the codebase hardcodes a revision string.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/**
 * Per spec: if the server supports the requested version it MUST echo it;
 * otherwise it responds with the latest version it supports (the client then
 * decides whether to proceed or disconnect).
 */
export function negotiateProtocolVersion(requested: string): string {
  return isSupportedProtocolVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
}
