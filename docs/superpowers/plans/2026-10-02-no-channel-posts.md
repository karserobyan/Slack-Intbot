# No channel posts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot names the channel that should receive an issue, and it never posts into that channel or any other channel.

**Architecture:** Channel choice stays a Haiku call over the live `conversations.list` result. The card shows that name. There is no Send handoff button and no Post to thread button. `chat.postMessage` stays only for the reply in the thread or DM that asked, and for the private auto-answer draft in `AUTO_ANSWER_TARGET_CHANNEL`.

**Tech Stack:** Node.js ESM, Slack Bolt, plain `assert` tests in `test.js`.

**Spec:** This file is the spec. The short copy agents must read first is the Standing plan in `.cursor/skills/integrationsbot/SKILL.md`.

## Global Constraints

- Node ESM. No CommonJS.
- No comments unless the WHY is non-obvious.
- Block Kit stays well under 50 blocks.
- Escape model text with `escapeMrkdwn`.
- Channel names are not hardcoded. The chooser may return only a channel on the live list. Unsure, unlisted, or a failed choice means `channel` is null.
- Do not restore CSA or Specialist mode. Do not build audit logs. Do not add step-level source lines.
- `node test.js` must finish with 0 failures.
- If Reply fails and the 60s cap has not fired, return the Resolver answer with no customer draft. If the cap has fired, the request still fails.

## Review Focus

- A card with `involvement.channel` set still has no `send_handoff` action.
- An auto-answer draft still has no `post_auto_answer` action.
- The involvement line still shows the channel name, so a person can post it themselves.
- Mention and DM replies still post in the conversation that asked.

## Standing decisions

1. The bot answers in the thread or DM where someone asked.
2. The bot does not post a handoff, a draft, or any other message into a different channel.
3. The card names the channel. A person posts there.
4. Follow-ups pass `[PRIOR CASE]` and do not repeat steps already given.
5. Accounting stays a keyword redirect. The reply tells the person the accounting channel. The bot does not post into it.
6. Auto-answer may still post a private draft into `AUTO_ANSWER_TARGET_CHANNEL`, because that channel was configured for review. It must not post into the original thread.
7. Parked, and not to be started from this plan: audit logs, CSA roles, and step-level source lines. If Reply fails before the 60s cap, the Resolver answer is kept and the customer draft is omitted.

## Task 1: Remove the posting actions

**Files:**
- Modify: `src/slack/blocks.js`
- Modify: `src/index.js`
- Modify: `src/handlers/auto-answer.js` only if it still passes `originalTs` solely for the button
- Modify: `test.js`
- Modify: `README.md`
- Modify: `.cursor/skills/integrationsbot/SKILL.md`

**Interfaces:**
- Consumes: `involvement.channel` from `settleInvolvement`
- Produces: response cards and auto-answer drafts with no action that posts elsewhere

- [x] **Step 1: Write the failing test**

In `test.js`, when `involvement.needed` is true and `channel` is `#ask-integrations`, assert there is no `send_handoff` element. Assert the involvement line still includes `#ask-integrations`. Assert `buildAutoAnswerBlocks` with `sourceChannelId` and `originalTs` has no `post_auto_answer` element.

- [x] **Step 2: Run `node test.js` and confirm those assertions fail**

- [x] **Step 3: Delete the Send handoff button, the Post to thread button, and both Bolt actions.** Do not replace them with another `chat.postMessage`.

- [x] **Step 4: Run `node test.js`**

Expected: 0 failed.

- [x] **Step 5: Commit**
