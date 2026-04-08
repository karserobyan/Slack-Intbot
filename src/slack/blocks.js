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
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🔌 ${data.issue_title}`,
      emoji: true,
    },
  });

  const CONFIDENCE_DISPLAY = {
    high:   { icon: '🟢', label: 'High confidence' },
    medium: { icon: '🟡', label: 'Medium confidence' },
    low:    { icon: '🔴', label: 'Low confidence — email draft suppressed' },
  };
  const conf = CONFIDENCE_DISPLAY[data.confidence] ?? CONFIDENCE_DISPLAY.medium;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Integration:* \`${data.integration_type}\`    *Sources:* ${(data.sources_used ?? []).map((s) => `\`${s}\``).join('  ')}    ${conf.icon} ${conf.label}`,
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

  // ── Section 2 — Customer Email Draft ────────────────────────────────────
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

  // ── Sources ──────────────────────────────────────────────────────────────
  const sourceLines = [];

  const slackRefs = (data.slack_refs ?? []).slice(0, 5);
  for (const ref of slackRefs) {
    const resolved = ref.was_resolved ? '✅' : '⏳';
    sourceLines.push(
      `${resolved} *#${ref.channel}*${ref.author ? ` (${ref.author})` : ''} — ${ref.issue_summary}`,
    );
  }

  const atlassianRefs = (data.atlassian_refs ?? []).slice(0, 5);
  for (const ref of atlassianRefs) {
    const icon = ref.type === 'jira' ? '🎟️' : '📄';
    const titleLink = ref.url ? `<${ref.url}|${ref.title}>` : ref.title;
    const statusPart = ref.status ? ` [${ref.status}]` : '';
    sourceLines.push(`${icon} ${titleLink}${statusPart} — ${ref.summary}`);
  }

  if (sourceLines.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📎 Sources Referenced*\n${sourceLines.join('\n')}`,
      },
    });
  }

  // Footer context block
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_IntegrationsBot • Sources searched: ${(data.sources_used ?? []).join(', ')} • Powered by Claude_`,
      },
    ],
  });

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
