/**
 * Minimal RFC 6570 (level 1 + reserved expansion) URI template matcher.
 *
 * `{var}`  matches one segment (no `/`);
 * `{+var}` matches greedily, including `/` — for path-like variables.
 */

export interface CompiledUriTemplate {
  readonly template: string;
  readonly variables: readonly string[];
  match(uri: string): Record<string, string> | undefined;
}

const VARIABLE_PATTERN = /\{(\+?)([A-Za-z0-9_]+)\}/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileUriTemplate(template: string): CompiledUriTemplate {
  const variables: string[] = [];
  let pattern = '^';
  let lastIndex = 0;

  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    pattern += escapeRegExp(template.slice(lastIndex, match.index));
    const [, plus, name] = match as unknown as [string, string, string];
    variables.push(name);
    pattern += plus === '+' ? '(.+)' : '([^/]+)';
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegExp(template.slice(lastIndex)) + '$';

  const regex = new RegExp(pattern);

  return {
    template,
    variables,
    match(uri: string): Record<string, string> | undefined {
      const result = regex.exec(uri);
      if (!result) return undefined;
      const params: Record<string, string> = {};
      variables.forEach((name, i) => {
        const raw = result[i + 1] ?? '';
        try {
          params[name] = decodeURIComponent(raw);
        } catch {
          params[name] = raw;
        }
      });
      return params;
    },
  };
}
