# Role-Based Responses + Personality Design

## Goal
Give the bot two distinct response modes — one for CSAs (Customer Support Advocates) and one for Specialists — auto-detected from the agent's Slack profile title. Add personality: warm, confident colleague tone with agent name in greeting and redesigned Slack blocks.

## Role Detection

### How it works
On every query, `handleQuery` calls `client.users.info(userId)` in parallel with posting the thinking placeholder (zero added latency). The profile `title` field is checked against role patterns.

### Classification rules
```js
// CSA: title matches "Customer Support Advocate" (any variation)
/Customer Support Advocate/i

// Specialist: title contains both "Specialist" and "Integrat" (any order/variation)
/Specialist/i && /Integrat/i

// Unknown: anything else → CSA mode (safe default)
```

These patterns are intentionally broad — "Customer Support Advocate I", "II", "Senior Customer Support Advocate" all match CSA. "Associate Integrations Specialist", "Senior Specialist Integrations", "Specialist, Integrations" all match Specialist.

### dm.js
`dm.js` delegates entirely to `handleQuery` in `mention.js`. Role detection happens inside `handleQuery` and therefore applies automatically to DMs — no changes needed to `dm.js`.

### Fallback
If `users.info` fails for any reason (network error, missing scope): default to CSA mode. Log a warning at `warn` level including the error message so the failure is visible in logs: `[mention] users.info failed — defaulting to CSA mode: <error>`.

### Startup scope check
At startup in `src/index.js`, attempt a test `users.info` call. If it fails with `missing_scope`, log a clear error: `[startup] WARNING: users:read scope missing — role detection will always default to CSA mode.`

## Response Modes

### queryWithContext signature
```js
// Before:
export async function queryWithContext(userQuery)

// After:
export async function queryWithContext(userQuery, { role = 'csa', agentName = null } = {})
```

`role` is a string enum: `'csa'` | `'specialist'`. `agentName` is the agent's Slack display name for use in `intro_message`. Both are optional with safe defaults.

### CSA Response
Structured JSON adds two new fields: `intro_message` and `escalate_decision`.

```json
{
  "issue_title": "short title max 8 words",
  "integration_type": "specific integration name",
  "intro_message": "Hey Sarah, this one looks like it needs escalation — here's why and what to do.",
  "is_accounting_topic": false,
  "escalate_decision": {
    "should_escalate": true,
    "reason": "Requires backend API access that CSAs do not have",
    "escalation_path": "Live Assist → Integrations Specialist"
  },
  "agent_steps": [
    // Steps CSA can take BEFORE escalating (verification, info gathering)
    // If no escalation needed: full steps the CSA can action themselves
  ],
  "customer_email": { "subject": "...", "body": "...", "kb_links": [] },
  "slack_refs": [],
  "atlassian_refs": [],
  "sources_used": []
}
```

When `should_escalate: false`, `escalation_path` is omitted and `agent_steps` contains the full resolution steps the CSA can take.

### Specialist Response
Same JSON structure without `escalate_decision`. Fuller `agent_steps` with backend actions, root cause, all resolution paths.

```json
{
  "issue_title": "...",
  "integration_type": "...",
  "intro_message": "Hey Mike, classic API access issue — here's the full picture.",
  "is_accounting_topic": false,
  "agent_steps": [
    // Full technical deep-dive
    // Backend steps tagged "backend"
    // All resolution paths
    // Root cause noted
  ],
  "customer_email": { ... },
  "slack_refs": [],
  "atlassian_refs": [],
  "sources_used": []
}
```

### "Show Specialist Detail" button (CSA only)

**Button payload:**
```json
{
  "action_id": "show_specialist_detail",
  "value": "{\"threadTs\":\"1234567890.123456\",\"channelId\":\"CXXXXXXXX\",\"query\":\"<original query truncated to 800 chars>\"}"
}
```

**Handler (registered in `src/index.js`, logic implemented inline there):**
1. Parse `value` to get `threadTs`, `channelId`, `query`
2. Look up agent's `userId` from `body.user.id`
3. Call `users.info(userId)` to get `agentName`
4. Call `queryWithContext(query, { role: 'specialist', agentName })`
5. Post specialist response blocks as a new message in the thread (`thread_ts: threadTs`)
6. Append exchange to conversation history via `appendToHistory(threadTs, [...])`

**Button value size:** query is truncated to 800 chars to stay within Slack's 2000-char button value limit (leaving room for JSON overhead).

## Personality

### Character
Knowledgeable senior colleague. Warm, direct, occasionally light. Confident but never dismissive. Acknowledges tough issues. Never robotic.

### Rules
- Always use agent's Slack display name in `intro_message` (first name preferred if determinable, else full display name)
- `intro_message` max 2 sentences
- Step titles sound like advice from a colleague, not a manual entry
- Customer email warm and human — not boilerplate

### Examples by situation
- Tough issue: *"Hey Sarah, this one's a bit tricky — let me walk you through what to check."*
- Clean fix: *"Good news Mike, this is fixable — here's what needs to happen."*
- Escalation needed: *"Hey Jordan, this one's going to need a specialist — here's what to gather before you hand it off."*
- Uncertainty: *"Hey Alex, I couldn't find specific info on this one — recommend checking #ask-integrations or escalating."*

## Slack Blocks Layout

### CSA blocks
1. `intro_message` — section block (warm greeting + situation summary)
2. Escalate/Don't Escalate decision — section block with `should_escalate` and `reason`
3. If escalating: `escalation_path` prominently displayed
4. Agent steps
5. Customer email draft + Copy button (if `customer_email` present)
6. Sources (`slack_refs`, `atlassian_refs`)
7. "🔍 Show Specialist Detail" button (actions block)
8. Footer context

### Specialist blocks
1. `intro_message` — section block
2. Agent steps (full technical detail)
3. Customer email draft + Copy button
4. Sources
5. Footer context (no "Show Specialist Detail" button)

## Files Changed

| File | Change |
|------|--------|
| `src/handlers/mention.js` | Add `users.info` call in parallel with thinking placeholder. Detect role from title. Pass `role` and `agentName` to `queryWithContext`. |
| `src/claude/query.js` | Update `queryWithContext` signature to `(userQuery, { role = 'csa', agentName = null } = {})`. Select `SYSTEM_PROMPT_CSA` or `SYSTEM_PROMPT_SPECIALIST` based on role. Pass `agentName` into prompt. |
| `src/claude/prompts.js` | Add `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST`. Both include `intro_message` instructions and personality rules. CSA prompt includes `escalate_decision` field. Specialist prompt omits it. |
| `src/slack/blocks.js` | Add `intro_message` rendering. Add escalate decision block (CSA only). Add "Show Specialist Detail" button (CSA only). |
| `src/index.js` | Register `show_specialist_detail` action handler. Add startup `users:read` scope check. |
| `dm.js` | No changes — delegates to `handleQuery` which already handles role detection. |

## New Environment Variables
None. `users:read` scope being added in current Slack app reinstall.

## Testing
- `users.info` returns CSA title → `SYSTEM_PROMPT_CSA` used, `escalate_decision` in response
- `users.info` returns Specialist title → `SYSTEM_PROMPT_SPECIALIST` used, no `escalate_decision`
- `users.info` fails → defaults to CSA, warning logged
- `intro_message` renders as first block in Slack response
- Escalate decision block present in CSA response, absent in Specialist response
- "Show Specialist Detail" button present in CSA response only
- Button click → specialist response posted in same thread
- Conversation history updated after "Show Specialist Detail" action
