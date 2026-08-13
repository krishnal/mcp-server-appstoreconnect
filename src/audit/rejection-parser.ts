/**
 * Parse pasted App Review rejection text into structured per-guideline items.
 * Tolerant by design: Apple's "Guideline N.N.N - Area - Topic" headers split
 * the message; anything before the first header becomes a Preamble item;
 * unrecognized formats degrade to a single unstructured item. Reviewer
 * questions (bullet lines ending in "?") are extracted so callers know a
 * written reply is expected.
 */
export interface RejectionItem {
  guideline?: string;
  heading: string;
  body: string;
  questions: string[];
}

const HEADER = /^Guideline\s+(\d+(?:\.\d+)*(?:\([a-z]+\))?)\s*(?:-\s*(.+))?$/gim;

export function parseRejection(text: string): RejectionItem[] {
  const matches = [...text.matchAll(HEADER)];
  if (matches.length === 0) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ heading: 'Rejection message', body: trimmed, questions: extractQuestions(trimmed) }];
  }

  const items: RejectionItem[] = [];
  const preamble = text.slice(0, matches[0]!.index).trim();
  if (preamble) {
    items.push({ heading: 'Preamble', body: preamble, questions: extractQuestions(preamble) });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    const topic = match[2]?.trim();
    items.push({
      guideline: match[1],
      heading: topic ? `Guideline ${match[1]} - ${topic}` : `Guideline ${match[1]}`,
      body,
      questions: extractQuestions(body),
    });
  }
  return items;
}

function extractQuestions(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line.endsWith('?'));
}
