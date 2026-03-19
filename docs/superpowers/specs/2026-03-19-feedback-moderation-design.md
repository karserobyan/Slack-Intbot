# Feedback Moderation Design

## Goal
Add a human approval layer to the Wrong Answer feedback system. Corrections submitted by agents go into a pending queue and are only applied to the bot after a designated reviewer approves them in Slack. Prevents deliberate or accidental poisoning of the bot's knowledge.

## Flow

### Submission (unchanged UX for agent)
1. Agent clicks "👎 Wrong Answer" button
2. Feedback modal opens (same as today)
3. Agent selects feedback type, enters correction, submits
4. Agent receives DM: *"Thanks for the feedback! It's been sent for review — if approved, it'll help improve the bot."*

### Review (new)
5. Bot posts to `#integrations-bot-reviews` channel with full context:
   - Original query
   - Bot's answer (issue title + integration type)
   - Agent's correction
   - Feedback type
   - Two buttons: **✅ Approve** / **❌ Reject**

### Approval
6a. Reviewer clicks **Approve**:
   - Entry moves from `data/feedback-pending.json` to `data/feedback.json`
   - Response cache entry for that query invalidated (same as today)
   - Review message updated: *"✅ Approved by [reviewer name]"*
   - Submitting agent receives DM: *"Your feedback was approved and applied — thanks for helping improve the bot!"*

6b. Reviewer clicks **Reject**:
   - Entry discarded from pending queue
   - Review message updated: *"❌ Rejected by [reviewer name]"*
   - Submitting agent receives DM: *"Your feedback was reviewed and not applied — thanks for flagging it."*

## Architecture

### New file: `data/feedback-pending.json`
Same structure as `feedback.json`. Entries live here until approved or rejected.

### Changes to `src/slack/feedback.js`
- `saveFeedback()` writes to `data/feedback-pending.json` instead of `data/feedback.json`
- `notifyFeedbackChannel()` posts the review card with Approve/Reject buttons to `FEEDBACK_REVIEW_CHANNEL_ID`
- New `approveFeedback(id)` — moves entry from pending to active, invalidates cache
- New `rejectFeedback(id)` — removes entry from pending
- `getRelevantFeedback()` reads only from `data/feedback.json` (approved only) — unchanged

### Changes to `src/index.js`
- Register `approve_feedback` action handler
- Register `reject_feedback` action handler
- Both handlers: verify reviewer is in review channel (Slack already enforces this via channel membership), call approve/reject, update review message, DM submitting agent

### Review card block structure
```
📝 Feedback Review — [feedback_type]

Agent: @agent_name
Integration: [integration_type]

Original query:
> [query]

Bot said:
> [issue_title]

Agent's correction:
> [correction]

[✅ Approve] [❌ Reject]
```

Button values carry the feedback `id` so the action handler knows which pending entry to process.

## Reviewer Management
Whoever is in `#integrations-bot-reviews` can approve or reject. Add/remove reviewers by adding/removing channel members. No code changes needed.

## Environment Variables
| Variable | Description |
|----------|-------------|
| `FEEDBACK_REVIEW_CHANNEL_ID` | Channel ID of the review channel (e.g. C0XXXXXXXX) |

`FEEDBACK_CHANNEL_ID` (existing) can be retired or repurposed — the review channel replaces it.

## Edge Cases
- **Reviewer not in channel:** Slack's channel membership means only members see the message and can click buttons. Non-members cannot interact.
- **Duplicate approval:** If two reviewers click simultaneously, the second action finds the entry already moved/removed and does nothing (idempotent).
- **Pending queue size cap:** Max 200 pending entries. If cap hit, oldest pending entry is discarded and submitter is notified their feedback could not be queued.
- **Bot restart:** Pending entries survive restart (persisted to disk).

## Testing
- Submit feedback → verify goes to pending, NOT active
- Verify review card posts to review channel
- Approve → verify moves to active, cache invalidated, both DMs sent
- Reject → verify removed from pending, both DMs sent
- Verify `getRelevantFeedback` only returns approved entries
