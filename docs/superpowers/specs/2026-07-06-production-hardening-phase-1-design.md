# Production Hardening Phase 1 Design

## Purpose

Production Hardening Phase 1 makes IntegrationsBot safer to operate before any new product roadmap work begins. This phase focuses on high-risk defects found in the audit: unauthorized moderation actions, persistence semantics that can falsely report success, unhandled Slack event failures, unsafe Slack markdown/link rendering, model-owned source sensitivity, and incomplete auto-answer Slack configuration guidance.

Product gaps and feature roadmap work are explicitly out of scope until this phase is implemented, tested, reviewed, and merged.

## Traceability Requirement

All meaningful work must be tracked in a separate chronological execution log:

`docs/superpowers/execution-log/2026-07-06-production-hardening.md`

Each entry must include:

- **Intent:** What we were trying to accomplish.
- **Action Taken:** What changed or what command/check was run.
- **Files Touched:** Exact files, or `None`.
- **Verification:** Test command/result, review result, or why verification was deferred.
- **Decision / Follow-up:** Any decision made, tradeoff accepted, or next action.

The execution log is the historical record of what actually happened. Specs describe intended behavior. Plans describe implementation tasks. The log records reality.

## Branch And Workflow Constraints

- Work must happen on a feature branch, not `main`.
- The initial branch for this effort is `codex/production-hardening-phase-1`.
- The repository requested `feature/<short-name>`, but local/sandbox branch creation failed for slash-prefixed branches until escalated; `codex/production-hardening-phase-1` was created successfully and must be recorded in the execution log.
- Existing uncommitted work must not be reverted or folded into unrelated commits.
- Each implementation task must run `node test.js`.
- Pull request creation waits until all tests pass with 0 failures.
- Product roadmap discussion resumes only after Phase 1 is clean.

## Scope

### In Scope

1. **Reviewer authorization**
   - Feedback approval/rejection and nomination approval/rejection must require an explicitly authorized moderator.
   - Unauthorized users must receive an ephemeral denial when possible.
   - Unauthorized attempts must be logged with user and action context, without leaking secrets.

2. **Durable feedback and nomination semantics**
   - Feedback save/approve/reject operations must not return success after persistence failure.
   - Nomination approval must not delete pending state until the knowledge write succeeds.
   - Callers must surface critical persistence failures to the submitting or reviewing user when possible.

3. **Top-level Slack handler failure control**
   - Mention event handling must catch unhandled errors at the event boundary.
   - A failed request must produce a controlled user-visible fallback when possible.
   - Logs must include enough context to debug the event: channel, thread timestamp, message timestamp, user, and action.

4. **Slack markdown and link safety**
   - User, model, Slack, Atlassian, KB, feedback, and nomination text rendered as `mrkdwn` must be escaped or intentionally formatted through a safe helper.
   - Source links must be allowlisted to known hosts before rendering as Slack links.
   - Unsafe links must degrade to escaped text, not clickable Slack links.

5. **Source sensitivity enforcement outside the model**
   - The model may suggest `sensitive: true`, but code must classify or preserve sensitivity before CSA rendering.
   - CSA views must not expose sensitive Slack or Atlassian refs.
   - Specialist views may show sensitive refs.

6. **Auto-answer Slack configuration and startup validation**
   - README and environment documentation must list the Slack scopes and event subscriptions required for auto-answer.
   - Startup validation must identify missing channel access or scope issues as clearly as possible using available Slack API errors.
   - Auto-answer must remain disabled by default.

### Out Of Scope

- Product roadmap features such as dashboards, digests, source governance UI, onboarding flows, analytics, or re-auth lifecycle automation.
- Redis/shared-state migration unless a Phase 1 fix absolutely requires it.
- Replacing Slack search with `assistant.search.context`.
- Large `handleQuery` architecture split beyond what is necessary to land Phase 1 safely.
- Dependency advisory scanning through external registries unless the user explicitly approves dependency inventory disclosure.

## Architecture

Phase 1 keeps the existing architecture mostly intact and adds narrow safety modules where boundaries are currently missing.

### New Or Updated Units

- `src/slack/moderation.js`
  - Owns moderator authorization.
  - Exports `isAuthorizedModerator(userId)` and `requireAuthorizedModerator(userId)`.
  - Reads `MODERATOR_USER_IDS` as a comma-separated list.
  - If no moderator list is configured, approval/rejection actions must fail closed.

- `src/slack/mrkdwn.js`
  - Owns Slack text escaping and safe link rendering.
  - Exports `escapeMrkdwn(value)` and `safeSlackLink(url, label)`.
  - Uses an allowlist for `servicetitan.slack.com`, `servicetitan.atlassian.net`, and `help.servicetitan.com`.

- `src/slack/source-policy.js`
  - Owns code-level source sensitivity policy.
  - Exports `classifySourceRef(ref)` and `filterRefsForRole(refs, role)`.
  - Preserves model-supplied `sensitive: true` and adds deterministic sensitivity for known internal patterns.

- Existing storage modules
  - `src/slack/feedback.js` must propagate persistence errors.
  - `src/slack/nominations.js` must approve only after successful knowledge writes.

- Existing Slack handlers
  - `src/index.js` must enforce authorization before approve/reject.
  - `src/handlers/mention.js` must catch event-boundary failures.
  - `src/handlers/auto-answer.js` and docs must clarify operational setup.

## Data Flow Changes

1. A moderator action enters through `src/index.js`.
2. The handler acknowledges Slack quickly.
3. The handler calls `requireAuthorizedModerator(body.user.id)`.
4. Unauthorized users receive an ephemeral denial and no state mutation happens.
5. Authorized users proceed to feedback or nomination persistence.
6. Persistence modules throw on critical write failures.
7. Handlers log and notify the reviewer when a critical write fails.

For response rendering:

1. Search/model refs enter Block Kit builders.
2. Source refs are classified by `source-policy`.
3. CSA rendering filters sensitive refs.
4. Text and links are rendered through `mrkdwn` helpers.
5. Unsafe links are displayed as escaped text.

## Error Handling And Logging

- Do not swallow persistence failures that affect user-visible state.
- Non-critical Slack notification failures may be logged and skipped, but state mutation failures must propagate.
- Logs must include operation names and stable identifiers: feedback ID, nomination ID, user ID, channel ID, thread timestamp, and message timestamp when available.
- Do not log token values, request authorization headers, or full customer payloads.

## Testing Requirements

All changes must be covered in `test.js`, matching the current no-framework `assert` style.

Required tests:

- Unauthorized feedback approval is rejected and does not mutate pending feedback.
- Unauthorized nomination approval is rejected and does not mutate pending nominations.
- Missing `MODERATOR_USER_IDS` fails closed.
- Feedback persistence failure causes `saveFeedback` or approval to reject.
- Nomination approval does not remove pending state when knowledge write fails.
- Mention handler top-level catch posts a fallback and releases dedupe state.
- `escapeMrkdwn` escapes `&`, `<`, and `>`.
- `safeSlackLink` allows known hosts and rejects unknown hosts.
- CSA source rendering filters sensitive refs even when the model omits or manipulates sensitivity fields.
- Auto-answer docs/env additions remain consistent with startup validation.

The full suite must pass:

```bash
node test.js
```

## Documentation Requirements

- Update `.env.example` with `MODERATOR_USER_IDS`.
- Update `README.md` with moderation configuration and auto-answer scope/event requirements.
- Maintain the execution log after each meaningful action.
- Product roadmap notes must be deferred to a later spec after Phase 1 completion.

## Acceptance Criteria

- All Phase 1 tests pass with `node test.js`.
- Unauthorized users cannot approve/reject feedback or nominations.
- Persistence failures do not result in false success messages or lost pending state.
- Slack rendering helpers prevent obvious mrkdwn/link injection vectors.
- CSA source views do not rely solely on model-provided sensitivity labels.
- Auto-answer setup docs identify required scopes and event subscriptions.
- The execution log contains a chronological record from branch creation through final verification.

