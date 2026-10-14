# IntegrationsBot briefing

Read this at the start of a new chat before changing the bot. The working contract for edits is `.cursor/skills/integrationsbot/SKILL.md`. This page is the product summary.

Repo: `karserobyan/Slack-Intbot`. Tests: `node test.js`. Zero failures before a pull request. Open pull requests as ready for review.

## What it is

Internal Slack bot for ServiceTitan integrations support people who own the case. One audience. There is no CSA mode and no Specialist mode.

Someone mentions `@IntegrationsBot` in a channel, or DMs the bot. The bot answers in that same thread or DM. It searches Slack history, Confluence, Jira, and the ServiceTitan help center, then returns a card: diagnosis, steps, whether another team should take it, a customer draft only when a customer was mentioned, and sources.

## How a question runs

Hard cap is 60 seconds. One abort covers the whole run. Model calls do not use SDK retries.

1. **Intake** (Haiku). Understands the question and builds a search plan. On a first message it may ask one clarifying question when confidence is low. On a follow-up it does not ask again.
2. **Research.** Searches the plan. An evaluator may refine the search once.
3. **Resolver** (Sonnet, or `ANTHROPIC_MODEL`). Diagnosis, steps, confidence, and whether another team is needed. It does not write the customer draft, and it does not pick the channel.
4. **Handoff channel** (Haiku), only when another team is needed and Slack returned a channel list. It reads the issue against every channel from `conversations.list` (name, purpose, topic). Channel names are not stored in the bot.
5. **Reply** (Sonnet), only when Intake set `entities.customer_mentioned` to true. It writes `customer_message` from facts the Resolver and research already produced. If Reply fails before the 60-second cap, the diagnosis and steps still come back and the customer draft is omitted. If the cap has already fired, the request fails.

Follow-ups pass the earlier case in as `[PRIOR CASE]`. The Resolver must answer what is still open and must not repeat steps already given.

Accounting (QuickBooks, Sage Intacct, NetSuite, Xero, Viewpoint Vista, and the other names in `src/utils/accounting-filter.js`) is a keyword check before any model call. The reply in the asking thread points to `#ask-partner-enabled-accounting-integrations`. The bot does not post into that channel.

## The card

Order: title, diagnosis, steps (action, backend, verify, escalate), involvement, customer draft when present, source chips, buttons.

Buttons: Wrong Answer, Diagnosis + Sources when there are references, and New chat in DMs. Nothing on the card posts into another channel. There is no Send handoff button and no Post to thread button.

Involvement:

- The case owner can finish it: the card says so. No channel.
- One listed channel clearly owns it: the card names that channel.
- Several listed channels could receive it and none is clearly the one: the card says “Could go to” up to three of them. It does not collapse those into one guess.
- Nothing on the list fits, or the choice fails: the card names no channel.

A person posts into the channel. The bot does not.

## What still posts

- The answer in the thread or DM where someone asked.
- A private auto-answer draft into `AUTO_ANSWER_TARGET_CHANNEL`, only when `AUTO_ANSWER_ENABLED=true`. That draft is not posted back into the original thread. The bot must be a member of the source and target channels. Those settings are channel IDs.

Wrong-answer feedback and `knowledge.md` nominations stay human-approved (Steward). `MODERATOR_USER_IDS` has to be set or approvals fail closed.

## Decisions already made

- Customer Support Advocates and the Specialist audience are gone. Do not restore them. Escalation means another team, not “find an Integrations Specialist.”
- Do not hardcode a map of issue types to channel names. The live channel list is the source.
- Do not post a handoff, a draft, or any other message into a channel other than the conversation that asked, except the private auto-answer review channel above.
- Audit logs are parked. The old Kibana writeup is not the plan. It routes every mention through buttons and calls `query.js`, which is gone. Reserved and unread: `ES_MCP_URL` (`https://es-aux-mcp.st.dev/mcp`) and `ES_MCP_TOKEN`.
- Step-level source lines under each step are parked. Do not build them unless asked again.
- Quality-shadow sources that used to be `specialist_only` are `internal`. They still show on the card. They do not become customer-facing knowledge by themselves.

## Next change, not started

The card names where to post and does not post. A person still has to write the message. The next change is one copyable block on the card: the diagnosis, the steps already tried, and the customer draft when there is one. If the card lists a few channels, that same block is what they paste into whichever they choose.

## Where the code lives

| Piece | File |
|---|---|
| Bolt app and actions | `src/index.js` |
| Mention and DM | `src/handlers/mention.js`, `src/handlers/dm.js` |
| Pipeline order and the 60s cap | `src/claude/pipeline.js` |
| Resolver and Reply calls | `src/claude/answerer.js` |
| Handoff choice | `src/slack/handoff-channels.js`, `src/claude/handoff-chooser.js` |
| Cards | `src/slack/blocks.js` |
| Field names | `src/claude/answer-schema.js` |
| Tests | `test.js` |

Node.js ESM. No CommonJS. No comments unless the reason is non-obvious. Block Kit stays well under 50 blocks. Escape model text with `escapeMrkdwn`.

Models already chosen: Intake, evaluator, handoff choice, and KB web search use `claude-haiku-4-5-20251001`. Resolver and Reply use `ANTHROPIC_MODEL` or `claude-sonnet-4-6`. Do not switch these to Opus, adaptive thinking, or streaming unless a task says so.

## Recent merges

- #37 removed CSA mode and split Resolver from Reply.
- #38 parked audit logs.
- #39 dropped the leftover audience role.
- #40 keeps the Resolver answer when Reply fails.
- #41 names the handoff channel from the live list, continues follow-ups, and does not post the handoff.
- #42 suggests up to three channels when no single one owns the issue.
