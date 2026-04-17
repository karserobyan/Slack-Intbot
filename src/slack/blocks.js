import { ACCOUNTING_REDIRECT_CHANNEL } from '../utils/accounting-filter.js';

/**
 * Tag → emoji + label mapping for agent step tags.
 */
const TAG_DISPLAY = {
  action: '🔵 `action`',
  backend: '🟠 `backend`',
  verify: '🟢 `verify`',
  escalate: '🔴 `escalate`',
};

function tagLabel(tag) {
  return TAG_DISPLAY[tag] ?? `\`${tag}\``;
}

/**
 * Builds the Block Kit payload for a successful (non-accounting) response.
 * Stays well under Slack's 50-block limit by capping steps and refs.
 *
 * @param {object} data - Parsed Claude response
 * @returns {Array} Slack blocks array
 */
export function buildResponseBlocks(data) {
  const blocks = [];

  // ── Intro message (personality greeting) ────────────────────────────────
  if (data.intro_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.intro_message },
    });
  }

  // ── Header ──────────────────────────────────────────────────────────────
  const CONFIDENCE_DISPLAY = {
    high:   { icon: '🟢' },
    medium: { icon: '🟡' },
    low:    { icon: '🔴' },
  };
  const conf = CONFIDENCE_DISPLAY[data.confidence] ?? CONFIDENCE_DISPLAY.medium;

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${conf.icon} ${data.issue_title}`,
      emoji: true,
    },
  });

  blocks.push({ type: 'divider' });

  // ── Escalate decision (CSA only) ─────────────────────────────────────────
  if (data.escalate_decision) {
    const ed = data.escalate_decision;
    const icon = ed.should_escalate ? '🔴' : '🟢';
    const decision = ed.should_escalate ? '*Escalate this case*' : '*Handle this yourself*';
    let text = `${icon} ${decision}\n_${ed.reason}_`;
    if (ed.should_escalate && ed.escalation_path) {
      text += `\n*Escalation path:* ${ed.escalation_path}`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    blocks.push({ type: 'divider' });
  }

  // ── Channel recommendation (CSA only) ────────────────────────────────────
  if (data.channel_recommendation) {
    const cr = data.channel_recommendation;
    const icon = cr.channel === 'ks-integration' ? '💬' : '📢';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *Post this in #${cr.channel}*\n_${cr.reason}_`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // ── Section 1 — Agent Troubleshooting ───────────────────────────────────
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*🔧 Agent Troubleshooting*\n_Internal only — do not share with customer_',
    },
  });

  const steps = (data.agent_steps ?? []).slice(0, 20); // guard against huge lists
  for (const step of steps) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${step.num}.* *${step.title}*  ${tagLabel(step.tag)}\n${step.detail}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

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

  // ── Confidence context (small) ───────────────────────────────────────────────
  const CONFIDENCE_CONTEXT = {
    high:   { icon: '🟢', label: 'High', note: 'steps are directly sourced' },
    medium: { icon: '🟡', label: 'Medium', note: 'verify steps before actioning' },
    low:    { icon: '🔴', label: 'Low', note: 'no direct match — treat as a starting point' },
  };
  const confCtx = CONFIDENCE_CONTEXT[data.confidence] ?? CONFIDENCE_CONTEXT.medium;
  const sourcesText = (data.sources_used ?? []).join(', ') || 'none';
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${confCtx.icon} *${confCtx.label} confidence* · Sources: ${sourcesText} · _${confCtx.note}_`,
    }],
  });

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

  return blocks;
}

/**
 * Builds Block Kit blocks for the accounting topic redirect.
 */
export function buildAccountingRedirectBlocks(query) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⚠️ This question is outside this team's scope.*\n\nIt looks like your question is about an *accounting integration* (e.g. QuickBooks, Sage Intacct, NetSuite, Xero, or similar). Accounting integrations are handled by a different team.\n\nPlease post your question in ${ACCOUNTING_REDIRECT_CHANNEL} and tag the accounting integrations team there. They'll be able to help you out!\n\n_Original question: "${query.slice(0, 200)}${query.length > 200 ? '…' : ''}"_`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_IntegrationsBot • Accounting integrations out of scope_' },
      ],
    },
  ];
}

/**
 * Builds a "thinking…" placeholder block shown while Claude is working.
 */
export function buildThinkingBlocks(query) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔍 Checking knowledge sources…*\n\nLooking into: _"${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"_\n\nChecking Confluence, Jira, and past Slack threads — this usually takes 20–40 seconds.`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_IntegrationsBot is working on it…_' }],
    },
  ];
}

/**
 * Builds an error block for unexpected failures.
 */
export function buildErrorBlocks(query) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*❌ Something went wrong*\n\nI wasn't able to process your request. Please try again, or escalate manually.\n\n_Query: "${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"_`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_IntegrationsBot • Error • Please retry or escalate_' }],
    },
  ];
}

/**
 * Builds the modal for "Wrong Answer" feedback.
 *
 * @param {object} context - { query, issueTitle, integrationType }
 * @returns {object} Slack view payload
 */
export function buildFeedbackModal(context) {
  return {
    type: 'modal',
    callback_id: 'feedback_submission',
    title: { type: 'plain_text', text: '👎 Report Wrong Answer', emoji: true },
    submit: { type: 'plain_text', text: 'Submit Feedback', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: JSON.stringify(context),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Original query:*\n>${context.query || 'N/A'}\n\n*Bot answered:*\n>${context.issueTitle || 'N/A'} (${context.integrationType || 'N/A'})`,
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'feedback_type_block',
        label: { type: 'plain_text', text: 'What was wrong?', emoji: true },
        element: {
          type: 'static_select',
          action_id: 'feedback_type_select',
          placeholder: { type: 'plain_text', text: 'Select an option', emoji: true },
          options: [
            { text: { type: 'plain_text', text: 'Completely wrong answer', emoji: true }, value: 'wrong_answer' },
            { text: { type: 'plain_text', text: 'Partially correct but missing key steps', emoji: true }, value: 'partially_correct' },
            { text: { type: 'plain_text', text: 'Outdated information', emoji: true }, value: 'outdated' },
            { text: { type: 'plain_text', text: 'Wrong integration identified', emoji: true }, value: 'wrong_integration' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'correction_block',
        label: { type: 'plain_text', text: 'What is the correct answer / what should the bot have said?', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'correction_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'e.g. "The actual fix is to go to Settings > Integrations > ... and toggle XYZ. The bot missed the step where you need to..."',
            emoji: false,
          },
        },
      },
    ],
  };
}

/**
 * Builds Block Kit blocks for a follow-up conversational reply.
 * Middle-ground format: context label + markdown-enabled body.
 * Lighter than the initial structured response but clearly formatted.
 *
 * @param {string} text - Claude's plain text follow-up reply
 * @returns {Array} Slack blocks array
 */
export function buildFollowUpBlocks(text) {
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Follow-up_' }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];
}

/**
 * Builds the public help response shown to all roles when an agent asks "@bot help".
 * @returns {Array} Slack blocks array
 */
export function buildHelpBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🤖 IntegrationsBot — Help', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What I do*\nSearch Confluence, Jira, and past Slack threads to give you troubleshooting steps for integration issues. Describe the problem and I\'ll tell you what to do — or ask a clarifying question to narrow it down first.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Integrations I cover*\nZapier · Angi / Angi Leads · Reserve with Google (RwG) · ServiceChannel · Thumbtack · Procore · Chat-to-Text widget · and others',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What I can\'t help with*\nAccounting integrations (QuickBooks, NetSuite, Sage Intacct, Xero, etc.) — those go to #ask-partner-enabled-accounting-integrations.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Example queries*\n• _"Customer\'s Zapier integration shows no API access on their tenant"_\n• _"Angi leads stopped syncing after the tenant migration"_\n• _"Procore job cost export failing for one specific job type"_',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_IntegrationsBot · Tag me or DM me with an issue · Team support: #ask-integrations_' }],
    },
  ];
}

/**
 * Builds the Specialist-only full reference, sent as an ephemeral in channels
 * or appended to the thread in DMs.
 * @returns {Array} Slack blocks array
 */
export function buildHelpDetailBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📖 Full Reference — Specialists', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Confidence levels*\nEach answer shows a confidence indicator so you know how much to rely on it.\n🟢 *High* — every step traced directly to a search result. Act on it.\n🟡 *Medium* — partial match or drawn from built-in knowledge. Verify before actioning.\n🔴 *Low* — no direct match found. Treat as a starting point; escalate if unsure.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Wrong Answer feedback*\nClick 👎 Wrong Answer → describe the correct answer → goes to pending review in the feedback channel → if approved, the correction is injected into future Claude prompts for the same query type.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Show Specialist Detail button*\nAppears on CSA responses. Clicking it triggers a second Claude call in Specialist mode and posts the full technical response in the same thread — useful when a CSA wants more depth without re-asking.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Thread continuation*\nAfter my first response, any follow-up in the same thread enters guided diagnostic mode — I ask yes/no questions to narrow down the root cause, then deliver a final answer.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*"No direct match" escalations*\nWhen I output a single escalate step saying I couldn\'t find specific information — that\'s intentional honesty, not a failure. It means searches returned nothing specific for this integration + symptom combination.',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_This reference is visible to Specialists only_' }],
    },
  ];
}

