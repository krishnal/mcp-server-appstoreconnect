#!/usr/bin/env node
/**
 * Bin entry point (`npx mcp-server-appstoreconnect`).
 *
 * MCP-host convention: a server launched via npx speaks stdio unless told
 * otherwise, so stdio is the default here — pass `--http` for the HTTP
 * transport. Configuration comes from the spawning host's env block (real
 * environment variables always win over any .env file).
 */
if (!process.argv.includes('--http')) {
  process.argv.push('--stdio');
}
await import('./server.js');
