import { describe, expect, it } from 'vitest';
import { parseRejection } from '../../src/audit/rejection-parser.js';

const SAMPLE = `App Version
Guideline 5.1.1(ii) - Legal - Privacy - Data Collection and Storage
Issue Description

One or more purpose strings in the app do not sufficiently explain the use of protected resources.

Next Steps

Update the photo library purpose string to explain how the app will use the requested information.
Guideline 2.3.6 - Performance - Accurate Metadata

Issue Description

The content description selected for the app's Age Rating indicates that the app includes In-App Controls.

Next Steps

Update the Age Rating selections to "None" for "Parental Controls."
Guideline 2.1 - Information Needed

We need additional information about how the app uses face data.

Next Steps

Provide complete and detailed responses to the following questions:

- What face data does the app collect?
- Will the face data be shared with any third parties? Where will this information be stored?
- How long will face data be retained?

The submission offers auto-renewable subscriptions but does not include a functional link to the Terms of Use (EULA) in the app's metadata.`;

describe('parseRejection', () => {
  it('splits Apple-format messages into per-guideline items', () => {
    const items = parseRejection(SAMPLE);
    expect(items.map((i) => i.guideline)).toEqual([undefined, '5.1.1(ii)', '2.3.6', '2.1']);
    expect(items[0]!.heading).toBe('Preamble');
    expect(items[1]!.heading).toBe('Guideline 5.1.1(ii) - Legal - Privacy - Data Collection and Storage');
    expect(items[1]!.body).toMatch(/purpose strings/);
  });

  it('extracts reviewer questions', () => {
    const items = parseRejection(SAMPLE);
    const infoNeeded = items.find((i) => i.guideline === '2.1')!;
    expect(infoNeeded.questions).toEqual([
      'What face data does the app collect?',
      'Will the face data be shared with any third parties? Where will this information be stored?',
      'How long will face data be retained?',
    ]);
    // Trailing unheaded content (the EULA paragraph) stays in the last item's body.
    expect(infoNeeded.body).toMatch(/Terms of Use \(EULA\)/);
  });

  it('degrades to a single item for non-Apple-format text', () => {
    const items = parseRejection('Your app was rejected for reasons.');
    expect(items).toEqual([
      { heading: 'Rejection message', body: 'Your app was rejected for reasons.', questions: [] },
    ]);
  });

  it('returns no items for empty input', () => {
    expect(parseRejection('   ')).toEqual([]);
  });
});
