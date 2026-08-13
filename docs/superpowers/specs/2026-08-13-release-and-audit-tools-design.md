# Release & Review-Audit Tools — Design

**Date:** 2026-08-13
**Status:** Approved design, pending implementation plan

## Overview

Extend the App Store Connect MCP server beyond TestFlight feedback into the
release side of the pipeline: pre-submission readiness and guideline auditing,
TestFlight beta distribution, App Store review submission, and production
release — all via the App Store Connect REST API.

## Scope decisions

| Decision | Choice |
| --- | --- |
| Build upload | **Out of scope.** The ASC REST API has no upload endpoint; uploads require local Apple tooling (Xcode/altool/Transporter) and stay outside this server. |
| Version setup depth | Tools create/update the version, attach a build, and set what's-new notes. Heavy metadata (descriptions, screenshots, privacy details) stays in the ASC UI; the readiness check reports what is missing there. |
| Release mode | Caller picks per submission: `AFTER_APPROVAL`, `MANUAL`, or `AFTER_APPROVAL` + phased rollout. A `release_version` tool triggers manually-held releases. |
| TestFlight distribution | **In scope**: take an already-uploaded build to external testers (export compliance, beta review, group assignment). |
| Safety model | Preflight gate: submit tools run the readiness check first and refuse on failure (overridable with `force: true`). Proper MCP annotations; no redundant confirm parameter. |
| Guideline audit | Both proactive (pre-submission audit) and reactive (rejection triage), powered by one curated rule pack. |
| Audit inputs | ASC metadata + optional local Xcode project scan (`projectPath`) for purpose strings, entitlements, and privacy manifests. Without a path, project-dependent checks are reported as skipped. |

## Tool surface

Nine new tools registered in `src/capabilities/index.ts`.

### Read-only

1. **`list_builds`** — uploaded builds with version, processing state, expiry,
   and export-compliance status. Discovery input for the write tools.
2. **`check_submission_readiness`** — completeness gate. Verifies: an App Store
   version exists in a submittable state, a processed build is attached,
   required metadata and screenshot sets are present, privacy declarations are
   published, and review contact details exist. Returns `{ready, checks[]}`
   where each check is `{name, status: pass|fail|warn, detail}`.
3. **`audit_app_review`** — guideline audit. Gathers `AppFacts` (ASC + optional
   project scan), filters the rule pack by applicability to this app's nature,
   runs deterministic checks, and returns
   `{findings[], skippedChecks[], rulePack: {lastReviewed}}`. Advisory only —
   never blocks submission.
4. **`triage_rejection`** — takes pasted Apple rejection text, splits it into
   per-guideline items, matches items to the rule pack, and returns per item:
   summary, fix steps, relevant MCP tools, and `replyNeeded` with extracted
   questions for information-request items (e.g. Guideline 2.1). Unmatched
   guidelines still come back as structured items with the parsed text.
5. **`get_release_status`** — post-submit tracking: review submission state,
   App Store version state, phased-release progress.

### Write

6. **`distribute_build`** — idempotent sequence: set export-compliance
   declaration if missing → submit for beta review if needed → assign to the
   given beta groups. Reports per-step outcomes.
7. **`prepare_app_store_version`** — create-or-update a version
   (`versionString`, `releaseType`, optional phased release), attach the chosen
   build, set what's-new text. Re-running updates in place.
8. **`submit_for_review`** — runs the readiness preflight and refuses on
   failing checks (returns them structurally) unless `force: true`; then
   creates the review submission, adds the version item, and submits.
9. **`release_version`** — releases an approved, manually-held version via an
   App Store version release request.

Annotations: read tools get `readOnlyHint: true`; write tools get
`readOnlyHint: false`, `openWorldHint: true`, and `idempotentHint: true` on
`prepare_app_store_version` and `distribute_build`.

## Architecture

```
src/asc/http.ts               extracted transport: JWT auth, 401 refresh-once,
                              429/5xx bounded retries, pagination, now with
                              POST/PATCH support
src/asc/client.ts             existing feedback client, unchanged public
                              surface, rebased onto AscHttp
src/asc/release-client.ts     new domain client: builds, appStoreVersions,
                              version localizations, review submissions,
                              phased releases, release requests, beta groups,
                              age rating declarations, IAP/subscriptions
src/audit/facts.ts            AppFacts gathering (parallel ASC calls +
                              optional project scan)
src/audit/project-scan.ts     Info.plist purpose strings, entitlements,
                              PrivacyInfo.xcprivacy
src/audit/engine.ts           applicability filtering + rule evaluation
src/audit/rejection-parser.ts pasted rejection text → structured items
src/audit/guidelines/*.ts     rule pack, one file per guideline area
src/capabilities/tools/release.ts, audit.ts   tool definitions
```

The transport extraction exists so the ASC client does not grow into one
~700-line class; the feedback client's behavior is unchanged and its existing
tests must pass unmodified.

## Audit knowledge base

Rule shape:

```ts
interface GuidelineRule {
  id: string;              // 'privacy.purpose-string.photo-library'
  guideline: string;       // '5.1.1(ii)'
  title: string;
  link: string;            // canonical URL to the official guideline section
  appliesTo: (facts: AppFacts) => boolean;
  check?: (facts: AppFacts) => CheckResult;   // deterministic pass/fail/warn
  judgment?: { question: string; guidance: string };  // for the calling LLM
  fix: string;             // concrete remediation steps
}
```

**Deterministic/judgment split.** Deterministic checks encode only stable,
mechanical requirements (e.g. subscriptions present but no Terms of Use link in
the description). Quality judgments (e.g. "is this purpose string sufficiently
explanatory?") return `needs_judgment` findings carrying the actual facts plus
Apple's guidance, so the calling LLM evaluates them in context. The rule pack
grounds the audit in app-specific facts; it is not a mirror of the guidelines.

**Freshness model.** Apple revises guidelines a few times a year, mostly
additively. Mitigations: (a) deterministic rules cover only years-stable
requirements; (b) judgment findings lean on the calling LLM's current knowledge
and carry the official guideline `link` for live lookup; (c) `triage_rejection`
reasons over Apple's own message text, so it is inherently current; (d) the
rule pack exposes a `lastReviewed` date in audit output so staleness is visible.
Maintenance expectation: skim Apple's changelog on announced updates (~2–3
times/year); a new rule is a ~20-line file.

**V1 rule pack** (~10–12 rules): 5.1.1 privacy/data collection (purpose strings
exist per protected resource used, account deletion for apps with sign-up,
privacy policy link), 2.3 accurate metadata (age rating consistency incl.
2.3.6 in-app controls), 3.1 payments (subscription Terms of Use/EULA link),
2.1 completeness/information-needed patterns, privacy-manifest presence.

## Data flow

- **`audit_app_review(appId, projectPath?)`** → gather AppFacts (parallel ASC
  reads; project scan when `projectPath` given) → filter rules via `appliesTo`
  → run deterministic checks → return findings + skipped checks.
- **`triage_rejection(rejectionText)`** → split on Apple's
  "Guideline N.N.N - Area - Topic" section format → match rules by guideline
  reference → attach fixes/tools/questions → return items (unknown format
  degrades to a single unstructured item).
- **`submit_for_review`** → readiness preflight → refuse-with-checklist or
  proceed → create review submission → add version item → submit.

## Error handling

- `AscApiError` (Apple's `detail` surfaced to the LLM) extends to writes, with
  actionable mappings: 409 version-exists → idempotent update path; 409
  submission-in-progress → point at `get_release_status`; 403 → explain the
  App Manager role requirement for write endpoints.
- Multi-step writes report per-step outcomes; idempotent steps check current
  state and skip completed work, so re-runs resume rather than duplicate.
- Preflight refusal returns the failing checks structurally.
- Project scan degrades: bad path → clear error; unparsable plist → the check
  moves to `skippedChecks` with a reason; ambiguous multi-target projects →
  candidates reported, no silent guessing. Build output and Pods directories
  are excluded from the scan.
- Rejection parser never fails hard: unrecognized text returns one
  unstructured item with the raw text.

## Testing

- **Refactor guard:** existing `asc-client.test.ts` passes unchanged after the
  `AscHttp` extraction.
- **Release client:** mocked-HTTP unit tests per endpoint — request shapes,
  inherited retry behavior, conflict mappings.
- **Audit engine:** pure-function tests with fixture `AppFacts`; golden cases
  per v1 rule (applies / not-applies / pass / fail / warn / needs_judgment).
- **Project scanner:** fixture Xcode-project tree (plists, entitlements,
  privacy manifest, decoy files in a build directory).
- **Rejection parser:** fixtures from real rejection messages —
  multi-guideline splitting, question extraction, EULA footer item,
  unknown-guideline fallback.
- **Tool level:** `mcp-test-client` tests — schema validation, preflight
  refusal path, `force` bypass, per-step partial-failure reporting.

## Out of scope

- Build upload (requires local Apple tooling; use Xcode/CI/fastlane).
- Full metadata management (descriptions, keywords, screenshot upload).
- Live scraping of Apple's guidelines page into rules.
- Resolution Center message retrieval (no public ASC API; rejection text is
  pasted by the user).
