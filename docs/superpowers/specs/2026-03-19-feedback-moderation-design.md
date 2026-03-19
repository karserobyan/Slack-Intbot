# Feedback Moderation Design

## Goal
Add a human approval layer to the Wrong Answer feedback system. Corrections submitted by agents go into a pending queue and are only applied to the bot after a designated reviewer approves them in Slack. Prevents deliberate or accidental poisoning of the bot's knowledge.

## Pending Entry Schema

Each pending entry has the following structure (extends existing feedback schema):

```json
{
  "id": "fb_1234567890_abc123",
  "timestamp": "2026-03-20T10:00:00.000Z",
  "query": "original agent query",
  "issueTitle": "bot's issue title",
  "integrationType": "Zapier",
  "feedbackType": "wrong_answer",
  "correction": "agent's correction text",
  "agentId": "U06S3SW2PFV",
  "agentName": "Karen Serobyan",
  "reviewMessageTs": "1234567890.123456",
  "reviewChannelId": "CXXXXXXXX"
}
```

`reviewMessageTs` and `reviewChannelId` are added when the review card is posted, enabling the handler to call `chat.update` on the review message after approval/rejection.

## Flow

### Submission (unchanged UX for agent)
1. Agent clicks "👎 Wrong Answer" button
2. Feedback modal opens (unchanged)
3. Agent selects feedback type, enters correction, submits
4. Entry saved to `data/feedback-pending.json` with `agentId`, `agentName`, and placeholder `reviewMessageTs: null`
5. Review card posted to `FEEDBACK_REVIEW_CHANNEL_ID`
6. After post, `reviewMessageTs` and `reviewChannelId` updated on the pending entry
7. Agent receives DM: *"Thanks for the feedback! It's been sent for review — if approved, it'll help improve the bot."*

### Review card posted to review channel
```
📝 Feedback Review — [feedback_type]

Agent: @agent_name  |  Integration: [integration_type]

Original query:
> [query]

Bot said:
> [issue_title]

Agent's correction:
> [correction]

[✅ Approve]  [❌ Reject]
```

Button values (JSON-encoded, max 2000 chars):
```json
{ "feedbackId": "fb_1234567890_abc123" }
```

### Approval handler (approve_feedback action)
1. Parse `feedbackId` from button value
2. Load pending entry by `id`
3. If not found (already processed): do nothing — idempotent
4. Move entry to `data/feedback.json` (active)
5. Invalidate response cache for `entry.query`
6. Update review card: replace buttons with *"✅ Approved by [reviewer display name]"*
7. DM `entry.agentId`: *"Your feedback was approved and applied — the bot will use it to improve future answers!"*

### Rejection handler (reject_feedback action)
1. Parse `feedbackId` from button value
2. Load pending entry by `id`
3. If not found: do nothing — idempotent
4. Remove entry from `data/feedback-pending.json`
5. Update review card: replace buttons with *"❌ Rejected by [reviewer display name]"*
6. DM `entry.agentId`: *"Your feedback was reviewed and not applied — thanks for flagging it."*

## Architecture

### Files changed

| File | Change |
|------|--------|
| `src/slack/feedback.js` | `saveFeedback()` writes to pending file. `notifyFeedbackChannel()` replaced: posts review card with Approve/Reject buttons to `FEEDBACK_REVIEW_CHANNEL_ID`, then updates pending entry with `reviewMessageTs` + `reviewChannelId`. New `approveFeedback(id)` — moves pending→active, invalidates cache. New `rejectFeedback(id)` — removes from pending. Old `FEEDBACK_CHANNEL` / `FEEDBACK_CHANNEL_ID` logic retired. |
| `src/index.js` | Register `approve_feedback` action handler. Register `reject_feedback` action handler. |

### New files
- `data/feedback-pending.json` — created automatically on first submission (same as how `feedback.json` is created)

### Unchanged
- `getRelevantFeedback()` — reads only from `data/feedback.json` (approved entries only). No change.
- `dm.js`, `mention.js` — no changes needed.

## Pending Queue

- **Cap:** 200 pending entries. If cap is hit, oldest pending entry is silently discarded (no DM to submitter — this is an edge case for extreme abuse scenarios and does not warrant extra notification complexity).
- **Persistence:** Pending entries survive bot restarts (written to disk).
- **Write queue:** Same serialised Promise-chain pattern as `feedback.json` to prevent concurrent write races.
- **In-memory cache:** Same pattern — loaded once, invalidated on every write.

## Reviewer Management
Whoever is in `FEEDBACK_REVIEW_CHANNEL_ID` channel can click Approve/Reject. Add/remove reviewers by adding/removing them from the channel. No code changes needed.

## Environment Variables

| Variable | Status | Description |
|----------|--------|-------------|
| `FEEDBACK_REVIEW_CHANNEL_ID` | Required (new) | Channel ID of the review channel (e.g. CXXXXXXXX) |
| `FEEDBACK_CHANNEL_ID` | Retired | Replaced by `FEEDBACK_REVIEW_CHANNEL_ID` |

## Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| Two reviewers click Approve simultaneously | Second handler finds entry already moved — does nothing |
| Two reviewers click Approve then Reject | Approve processed first (race unlikely but handled by idempotency) |
| Pending queue hits 200 cap | Oldest entry silently discarded |
| Bot restarts with pending entries | Entries survive — written to disk |
| Review channel not configured | `saveFeedback` still saves to pending, but no review card is posted. Bot logs a warning. |
| `users.info` fails when getting reviewer name | Falls back to reviewer's user ID in the update message |

## Testing

- Submit feedback → entry in `feedback-pending.json`, NOT `feedback.json`
- Review card posts to review channel with Approve/Reject buttons
- Submitter receives DM after submission
- Approve → entry moves to `feedback.json`, cache invalidated, review card updated, submitter DMed
- Reject → entry removed from pending, review card updated, submitter DMed
- Double-approve → second action is a no-op
- `getRelevantFeedback` returns only approved entries
- Pending cap at 200 — 201st entry evicts oldest
