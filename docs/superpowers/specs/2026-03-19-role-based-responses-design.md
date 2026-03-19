# Role-Based Responses + Personality Design

## Goal
Give the bot two distinct response modes — one for CSAs (Customer Support Advocates) and one for Specialists — auto-detected from the agent's Slack profile title. Add personality: warm, confident colleague tone with agent name in greeting and redesigned Slack blocks.

## Role Detection

### How it works
On every query, `handleQuery` calls `client.users.info(userId)` in parallel with posting the thinking placeholder (zero added latency). The profile `title` field is checked against role patterns.

### Classification rules
```
CSA:        title contains "Customer Support Advocate" (I or II)
Specialist: title contains "Specialist" AND "Integration" (any order, any variation)
Unknown:    anything else → defaults to CSA mode (safe default)
```

### Fallback
If `users.info` fails (network error, missing scope): default to CSA mode silently. Never block a query due to role lookup failure.

## Response Modes

### CSA Response
Structured JSON adds one new field: `escalate_decision`.

```json
{
  "issue_title": "...",
  "integration_type": "...",
  "intro_message": "Hey Sarah, this one looks like it needs escalation — here's why and what to do.",
  "escalate_decision": {
    "should_escalate": true,
    "reason": "Requires backend API access that CSAs do not have",
    "escalation_path": "Live Assist → Integrations Specialist"
  },
  "agent_steps": [
    // Steps CSA can take BEFORE escalating (verification, info gathering)
    // If no escalation: full steps the CSA can action themselves
  ],
  "customer_email": { ... },
  "slack_refs": [ ... ],
  "atlassian_refs": [ ... ],
  "sources_used": [ ... ]
}
```

**Slack blocks layout (CSA):**
1. Warm intro message (1-2 sentences, addresses agent by name)
2. Escalate / Don't Escalate decision — prominent, clear
3. Steps (pre-escalation info gathering OR self-resolution steps)
4. Customer email draft + Copy button
5. Sources
6. "Show Specialist Detail" button

### Specialist Response
Same JSON structure but without `escalate_decision`. Fuller, deeper `agent_steps` including backend actions, root cause analysis, all resolution paths.

```json
{
  "issue_title": "...",
  "integration_type": "...",
  "intro_message": "Hey Mike, classic API access issue — here's the full picture.",
  "agent_steps": [
    // Full technical deep-dive
    // Backend steps tagged "backend"
    // All resolution paths covered
    // Root cause noted
  ],
  "customer_email": { ... },
  "slack_refs": [ ... ],
  "atlassian_refs": [ ... ],
  "sources_used": [ ... ]
}
```

**Slack blocks layout (Specialist):**
1. Warm intro message
2. Steps (full technical detail)
3. Customer email draft + Copy button
4. Sources

### "Show Specialist Detail" button (CSA only)
When a CSA clicks this button, the bot replies in the same thread with the full specialist-level response. Uses `queryWithContext` again with `role: specialist` forced. Appended to conversation history so follow-up chat mode has full context.

## Personality

### Character
Knowledgeable senior colleague. Warm, direct, occasionally light. Confident but never dismissive. Acknowledges tough issues. Never robotic or manual-sounding.

### Examples
- Tough issue: *"Hey Sarah, this one's a bit tricky — let me walk you through what to check."*
- Clean fix: *"Good news Mike, this is fixable — here's what needs to happen."*
- Uncertainty: *"Hey Jordan, I couldn't find specific information on this one — recommend checking #ask-integrations or escalating."*

### Rules
- Always address agent by display name in `intro_message`
- `intro_message` max 2 sentences
- Step titles sound like advice from a colleague, not a manual
- Customer email warm and human — not boilerplate

## Files Changed

| File | Change |
|------|--------|
| `src/handlers/mention.js` | Add `users.info` call, detect role, pass role to `queryWithContext` |
| `src/claude/query.js` | Accept `role` param in `queryWithContext`, pass to prompt builder |
| `src/claude/prompts.js` | Add `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST`, update `intro_message` instructions |
| `src/slack/blocks.js` | Add `intro_message` block, escalate decision block, "Show Specialist Detail" button |
| `src/index.js` | Register "show_specialist_detail" action handler |

## New Environment Variables
None required. `users:read` scope already being added in current reinstall.

## Testing
- Mock `users.info` returning CSA title → verify CSA prompt used
- Mock `users.info` returning Specialist title → verify Specialist prompt used
- Mock `users.info` failure → verify defaults to CSA without error
- Verify `intro_message` renders in blocks
- Verify escalate decision block renders for CSA, absent for Specialist
- Verify "Show Specialist Detail" button present in CSA response only
