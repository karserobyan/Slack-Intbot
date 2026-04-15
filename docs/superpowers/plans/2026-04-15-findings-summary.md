# Findings Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the customer email draft feature and replace it with a "Bottom Line" findings summary section — diagnosis sentence + action bullets + optional guidance note.

**Architecture:** `customer_email` is removed from both Claude prompt schemas and replaced with `findings_summary { diagnosis, actions, guidance }`. The email rendering section in `buildResponseBlocks` becomes a "Bottom Line" block. The `copy_email_modal` action and `buildEmailModal` function are deleted. Tests are updated to match the new contract.

**Tech Stack:** Node.js ESM, `@slack/bolt`, `@anthropic-ai/sdk`, prompt engineering in `src/claude/prompts.js`

---

## File Map

| File | Change |
|------|--------|
| `test.js` | Update fixtures + assertions; remove email tests; add findings_summary tests |
| `src/claude/prompts.js` | Replace `customer_email` with `findings_summary` in both schemas; update `SHARED_RULES`; update `summarizeResultForHistory` |
| `src/slack/blocks.js` | Replace email section with Bottom Line section; remove `buildEmailModal` |
| `src/index.js` | Remove `copy_email_modal` action handler; remove `buildEmailModal` import |

---

### Task 1: Update tests to reflect new contract

Update `test.js` so tests describe the new expected behavior. After this task, running `node test.js` will show failures on block-related assertions because the implementation still renders emails. That is expected.

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Remove `buildEmailModal` from the import block**

In `test.js`, find:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildEmailModal,
  buildFollowUpBlocks,
} from './src/slack/blocks.js';
```

Replace with:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
} from './src/slack/blocks.js';
```

- [ ] **Step 2: Replace `customer_email` with `findings_summary` in `sampleJson`**

In `test.js`, find:
```js
  customer_email: {
    subject: 'Re: Zapier Integration Setup — ServiceTitan Integrations Support',
    body: "Hi there,\n\nThank you for reaching out about your Zapier integration.\n\nWe've enabled API access on your account, which was the missing piece for getting Zapier connected. You should now be able to complete the setup on your end by following these steps:\n\n1. Log into your Zapier account\n2. Search for ServiceTitan in the app directory\n3. Follow the prompts to connect your account\n\nPlease let us know if you run into any issues during setup -- we're happy to help!\n\nBest regards,\nServiceTitan Integrations Support Team",
    kb_links: [
      { label: 'How to set up Zapier with ServiceTitan', url: 'https://help.servicetitan.com/how-to/zapier' },
    ],
  },
```

Replace with:
```js
  findings_summary: {
    diagnosis: 'The Zapier integration is failing because API access has not been enabled on the ServiceTitan backend for this tenant.',
    actions: [
      'Enable Zapier API access via the ST backend admin panel',
      'Have the customer re-authenticate their Zapier account',
      'Verify the first trigger fires successfully after re-auth',
    ],
    guidance: 'If re-auth still fails, check whether the tenant is on a legacy Zapier plan that requires manual re-provisioning.',
  },
```

- [ ] **Step 3: Remove `customer_email` from `resultWithEscalate` and update the assert that checked it**

In `test.js`, find:
```js
  customer_email: { subject: 'Re: Zapier Integration — ServiceTitan Support' },
  confidence: 'high',
```

Replace with:
```js
  findings_summary: {
    diagnosis: 'Zapier API access needs enabling on the backend.',
    actions: ['Enable Zapier API access', 'Ask customer to re-authenticate'],
  },
  confidence: 'high',
```

Then find and remove this assert (it checked email subject in history summary):
```js
assert(histSummary.includes('Re: Zapier Integration'), 'summary includes email subject');
```

Replace it with:
```js
assert(histSummary.includes('Zapier API access needs enabling'), 'summary includes findings_summary diagnosis');
```

- [ ] **Step 4: Remove `customer_email` from `specialistResult`**

In `test.js`, find:
```js
  customer_email: { subject: 'Re: Procore Export — ServiceTitan Support' },
  confidence: 'medium',
```

Replace with:
```js
  confidence: 'medium',
```

- [ ] **Step 5: Update the action button label assert**

In `test.js`, find:
```js
assert(responseBlocks.some(b => b.type === 'actions'), 'Contains copy email button');
```

Replace with:
```js
assert(responseBlocks.some(b => b.type === 'actions'), 'Contains action buttons');
```

- [ ] **Step 6: Remove the `buildEmailModal` test block**

In `test.js`, find and delete these 3 lines:
```js
// Email modal
const modal = buildEmailModal('Test Subject', 'Test body text');
assert(modal.type === 'modal', 'Modal has correct type');
assert(modal.blocks.length === 2, 'Modal has subject + body blocks');
```

- [ ] **Step 7: Replace email-rendering block tests with Bottom Line tests**

In `test.js`, find this entire block (lines that test low/high confidence email rendering):
```js
// low confidence: email draft suppressed, warning shown
const lowEmailBlock = lowConfBlocks.find(b => b.text?.text?.includes('Suppressed'));
assert(lowEmailBlock !== undefined, 'Low confidence suppresses email draft with notice');
const lowHasRealEmail = lowConfBlocks.some(b => b.text?.text?.startsWith('> '));
assert(lowHasRealEmail === false, 'Low confidence: no quoted email body rendered');

// low confidence: Wrong Answer button still present
const lowActions = lowConfBlocks.find(b => b.type === 'actions');
assert(lowActions !== undefined, 'Low confidence: action buttons still rendered');
const lowWrongBtn = lowActions?.elements?.find(e => e.action_id === 'wrong_answer_modal');
assert(lowWrongBtn !== undefined, 'Low confidence: Wrong Answer button present');

// high/medium: email renders normally
const highEmailBlock = highConfBlocks.find(b => b.text?.text?.startsWith('> '));
assert(highEmailBlock !== undefined, 'High confidence: email body rendered normally');
```

Replace with:
```js
// Bottom Line renders for all confidence levels
const lowBottomLine = lowConfBlocks.find(b => b.text?.text?.includes('Bottom Line'));
assert(lowBottomLine !== undefined, 'Low confidence: Bottom Line section still renders');
const highBottomLine = highConfBlocks.find(b => b.text?.text?.includes('Bottom Line'));
assert(highBottomLine !== undefined, 'High confidence: Bottom Line section renders');

// Bottom Line contains diagnosis (bold), actions (bullets), guidance (italic)
const bottomLineBlock = highBottomLine;
assert(bottomLineBlock.text.text.includes('*The Zapier integration is failing'), 'Bottom Line diagnosis is bold');
assert(bottomLineBlock.text.text.includes('• Enable Zapier API access'), 'Bottom Line contains action bullet');
assert(bottomLineBlock.text.text.includes('_If re-auth still fails'), 'Bottom Line guidance is italic');

// No quoted email body anywhere
const noQuotedEmail = highConfBlocks.every(b => !b.text?.text?.startsWith('> '));
assert(noQuotedEmail, 'No quoted email body in any block');

// Wrong Answer button still present
const highActions = highConfBlocks.find(b => b.type === 'actions');
assert(highActions !== undefined, 'Action buttons still rendered');
const highWrongBtn = highActions?.elements?.find(e => e.action_id === 'wrong_answer_modal');
assert(highWrongBtn !== undefined, 'Wrong Answer button present');

// No Copy Email button
const noCopyEmail = highConfBlocks.every(b =>
  b.type !== 'actions' || !b.elements?.some(e => e.action_id === 'copy_email_modal')
);
assert(noCopyEmail, 'No Copy Email button in any actions block');
```

- [ ] **Step 8: Update the `null customer_email` edge case test**

In `test.js`, find:
```js
// Missing customer_email
const noEmail = buildResponseBlocks({ ...sampleJson, customer_email: null });
assert(noEmail.length > 0, 'Handles null customer_email without crashing');
```

Replace with:
```js
// Missing findings_summary
const noSummary = buildResponseBlocks({ ...sampleJson, findings_summary: undefined });
assert(noSummary.length > 0, 'Handles missing findings_summary without crashing');
```

- [ ] **Step 9: Run tests — note failures but do not fix yet**

```bash
node test.js
```

Expected: Most tests pass. Failures will be on the new Bottom Line assertions (implementation still renders email). Note which assertions fail and continue to Task 2.

---

### Task 2: Update `src/claude/prompts.js`

Remove `customer_email` from both prompt schemas, add `findings_summary`, update `SHARED_RULES`, and update `summarizeResultForHistory`.

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Update the "low" confidence rule in `SHARED_RULES` — remove the email suppression sentence**

In `src/claude/prompts.js`, find:
```
- "low": Your searches returned nothing specifically matching this integration + symptom combination, or you are about to escalate because you genuinely don't know. When confidence is low, the customer email draft will be automatically suppressed by the system — do not invent steps to fill the gap.
```

Replace with:
```
- "low": Your searches returned nothing specifically matching this integration + symptom combination, or you are about to escalate because you genuinely don't know.
```

- [ ] **Step 2: Replace `customer_email` with `findings_summary` in `SYSTEM_PROMPT_CSA` schema**

In `src/claude/prompts.js`, find in the CSA full structured JSON block:
```
  "customer_email": {
    "subject": "Re: [Issue description] — ServiceTitan Integrations Support",
    "body": "Warm, human email body. Use \\n for line breaks. Sign off as:\\n\\nBest regards,\\nServiceTitan Integrations Support Team",
    "kb_links": [{ "label": "Link label", "url": "https://help.servicetitan.com/..." }]
  },
```

Replace with:
```
  "findings_summary": {
    "diagnosis": "One sentence: what is broken and why.",
    "actions": ["Action 1", "Action 2"],
    "guidance": "Optional: one watch-out or fallback if the fix does not work. Omit this field entirely if nothing noteworthy."
  },
```

- [ ] **Step 3: Update the accounting topic line in `SYSTEM_PROMPT_CSA`**

In `src/claude/prompts.js`, find:
```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "customer_email": null, "slack_refs": [], "atlassian_refs": [], "sources_used": [] }
```

Replace with:
```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "slack_refs": [], "atlassian_refs": [], "sources_used": [] }
```

- [ ] **Step 4: Replace `customer_email` with `findings_summary` in `SYSTEM_PROMPT_SPECIALIST` schema**

In `src/claude/prompts.js`, find in the Specialist full structured JSON block:
```
  "customer_email": {
    "subject": "Re: [Issue description] — ServiceTitan Integrations Support",
    "body": "Warm, professional email. Use \\n for line breaks. Sign off as:\\n\\nBest regards,\\nServiceTitan Integrations Support Team",
    "kb_links": [{ "label": "Link label", "url": "https://help.servicetitan.com/..." }]
  },
```

Replace with:
```
  "findings_summary": {
    "diagnosis": "One sentence: what is broken and why.",
    "actions": ["Action 1", "Action 2"],
    "guidance": "Optional: one watch-out or fallback if the fix does not work. Omit this field entirely if nothing noteworthy."
  },
```

- [ ] **Step 5: Update the accounting topic line in `SYSTEM_PROMPT_SPECIALIST`**

In `src/claude/prompts.js`, find:
```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "customer_email": null, "slack_refs": [], "atlassian_refs": [], "sources_used": [] }
```

Replace with:
```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "slack_refs": [], "atlassian_refs": [], "sources_used": [] }
```

- [ ] **Step 6: Update `summarizeResultForHistory` — remove email lines, add findings_summary**

In `src/claude/prompts.js`, find:
```js
  if (result.customer_email) {
    lines.push(`\nCustomer email drafted: "${result.customer_email.subject}"`);
  }
```

Replace with:
```js
  if (result.findings_summary) {
    const fs = result.findings_summary;
    lines.push(`\nBottom line: ${fs.diagnosis}`);
    if ((fs.actions ?? []).length > 0) {
      lines.push(`Actions: ${fs.actions.join('; ')}`);
    }
  }
```

- [ ] **Step 7: Run tests**

```bash
node test.js
```

Expected: The `summarizeResultForHistory` test now passes (`summary includes findings_summary diagnosis`). Block-related Bottom Line assertions still fail — that is expected. Fix in Task 3.

- [ ] **Step 8: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: replace customer_email with findings_summary in both prompt schemas and history summarizer"
```

---

### Task 3: Update `src/slack/blocks.js`

Replace the email rendering section with a Bottom Line section. Remove `buildEmailModal`.

**Files:**
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Replace the entire "Customer Email Draft" section with the Bottom Line section**

In `src/slack/blocks.js`, find this entire block — from the comment through the final divider push — and replace it:

Find:
```js
  // ── Section 2 — Customer Email Draft ────────────────────────────────────────
  if (data.confidence === 'low') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*✉️ Customer Email Draft*\n⚠️ *Suppressed — confidence is low.* The bot could not find specific information about this issue. Please verify the steps above with a Specialist or the relevant Slack channel before drafting a customer response.`,
      },
    });
    const lowConfButtons = [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
        action_id: 'wrong_answer_modal',
        style: 'danger',
        value: JSON.stringify({
          query: (data._originalQuery ?? '').slice(0, 400),
          issueTitle: (data.issue_title ?? '').slice(0, 100),
          integrationType: (data.integration_type ?? '').slice(0, 50),
        }),
      },
    ];
    if (data._showSpecialistValue) {
      lowConfButtons.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
        action_id: 'show_specialist_detail',
        value: data._showSpecialistValue,
      });
    }
    blocks.push({ type: 'actions', elements: lowConfButtons });
    blocks.push({ type: 'divider' });
  } else if (data.customer_email) {
    const email = data.customer_email;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*✉️ Customer Email Draft*\n*Subject:* ${email.subject}`,
      },
    });

    // Email body — use rich_text quote for easy visual separation
    // Slack's rich_text elements don't support full block-quote of arbitrary text,
    // so we use a section with mrkdwn > prefix lines, which renders as a quote.
    const quotedBody = email.body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: quotedBody,
      },
    });

    // KB links
    if (email.kb_links && email.kb_links.length > 0) {
      const linkLines = email.kb_links.map((l) => `• <${l.url}|${l.label}>`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📚 KB Articles to include:*\n${linkLines}`,
        },
      });
    }

    // Action buttons — copy email + wrong answer feedback + optional specialist detail
    const actionElements = [
      {
        type: 'button',
        text: { type: 'plain_text', text: '📋 Copy Email Draft', emoji: true },
        action_id: 'copy_email_modal',
        style: 'primary',
        value: JSON.stringify({
          subject: (email.subject ?? '').slice(0, 150),
          body: email.body.slice(0, 1800),
        }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
        action_id: 'wrong_answer_modal',
        style: 'danger',
        value: JSON.stringify({
          query: (data._originalQuery ?? '').slice(0, 400),
          issueTitle: (data.issue_title ?? '').slice(0, 100),
          integrationType: (data.integration_type ?? '').slice(0, 50),
        }),
      },
    ];

    if (data._showSpecialistValue) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
        action_id: 'show_specialist_detail',
        value: data._showSpecialistValue,
      });
    }

    blocks.push({ type: 'actions', elements: actionElements });

    blocks.push({ type: 'divider' });
  }
```

Replace with:
```js
  // ── Section 2 — Bottom Line ──────────────────────────────────────────────────
  if (data.findings_summary) {
    const fs = data.findings_summary;
    const actionLines = (fs.actions ?? []).map((a) => `• ${a}`).join('\n');
    let summaryText = `*💡 Bottom Line*\n*${fs.diagnosis}*`;
    if (actionLines) summaryText += `\n\n${actionLines}`;
    if (fs.guidance) summaryText += `\n\n_${fs.guidance}_`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
    });
  }

  // ── Action buttons ───────────────────────────────────────────────────────────
  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({
        query: (data._originalQuery ?? '').slice(0, 400),
        issueTitle: (data.issue_title ?? '').slice(0, 100),
        integrationType: (data.integration_type ?? '').slice(0, 50),
      }),
    },
  ];

  if (data._showSpecialistValue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
      action_id: 'show_specialist_detail',
      value: data._showSpecialistValue,
    });
  }

  blocks.push({ type: 'actions', elements: actionElements });
  blocks.push({ type: 'divider' });
```

- [ ] **Step 2: Remove the `buildEmailModal` function**

In `src/slack/blocks.js`, find and delete this entire function:
```js
/**
 * Builds the modal view shown when an agent clicks "Copy Email Draft".
 *
 * @param {string} subject
 * @param {string} body
 * @returns {object} Slack view payload
 */
export function buildEmailModal(subject, body) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Email Draft', emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Subject:* ${subject}`,
        },
      },
      {
        type: 'input',
        block_id: 'email_body_block',
        label: { type: 'plain_text', text: 'Email Body (select all and copy)', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'email_body_input',
          multiline: true,
          initial_value: body,
        },
        hint: {
          type: 'plain_text',
          text: 'Click into the text area and use Ctrl+A / Cmd+A to select all, then copy.',
          emoji: false,
        },
      },
    ],
  };
}
```

- [ ] **Step 3: Run tests — all should pass**

```bash
node test.js
```

Expected: `Results: N passed, 0 failed`

If any test still fails, re-read the failure message carefully — it will point to the exact assertion. Fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: replace email draft section with Bottom Line findings summary, remove buildEmailModal"
```

---

### Task 4: Remove `copy_email_modal` handler from `src/index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Remove `buildEmailModal` from the import**

In `src/index.js`, find:
```js
import { buildEmailModal, buildFeedbackModal, buildResponseBlocks } from './slack/blocks.js';
```

Replace with:
```js
import { buildFeedbackModal, buildResponseBlocks } from './slack/blocks.js';
```

- [ ] **Step 2: Remove the `copy_email_modal` action handler**

In `src/index.js`, find and delete this entire block:
```js
// ── "Copy Email Draft" button — opens a modal with the email text ────────────
app.action('copy_email_modal', async ({ ack, body, client, action }) => {
  await ack();

  let emailData = { subject: '', body: '' };
  try {
    emailData = JSON.parse(action.value);
  } catch {
    // value may be malformed — show empty modal rather than crash
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildEmailModal(emailData.subject, emailData.body),
  });
});
```

- [ ] **Step 3: Run tests — still all passing**

```bash
node test.js
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: remove copy_email_modal action handler and buildEmailModal import"
```

---

### Task 5: Manual end-to-end verification

- [ ] **Step 1: Start the bot**

```bash
npm run dev
```

- [ ] **Step 2: Test — response should show Bottom Line instead of email**

Send a specific query (DM or @mention):
> Zapier API access not enabled — customer re-authenticated but still getting 401

Expected:
- Bot searches, then renders a full structured response
- Below the numbered steps, there is a `💡 *Bottom Line*` section with a bold diagnosis sentence, bullet actions, and (if generated) an italic guidance note
- No "Customer Email Draft" section
- No "Copy Email Draft" button
- "Wrong Answer" button still present

- [ ] **Step 3: Test — vague query still triggers clarifying question**

Send:
> Zapier not working

Expected: Bot asks a yes/no question — no Bottom Line section (clarifying question path, not full response).

- [ ] **Step 4: Test — specialist mode also shows Bottom Line**

If you have a Specialist Slack profile title, @mention the bot with a specific query. The specialist response should also show `💡 Bottom Line` instead of an email draft.
