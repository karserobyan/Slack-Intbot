import { ACCOUNTING_REDIRECT_CHANNEL } from '../utils/accounting-filter.js';

const TAG_CIRCLE = {
  action:   '🔵',
  backend:  '🟠',
  verify:   '🟢',
  escalate: '🔴',
};

const CONFIDENCE_META = {
  high:   { icon: '🟢', label: 'High'   },
  medium: { icon: '🟡', label: 'Medium' },
  low:    { icon: '🔴', label: 'Low'    },
};

// Slack hard limits: section text ≤ 3000 chars, header plain_text ≤ 150.
// LLM-derived fields (issue_title, customer_message, diagnosis, step.detail) have
// no enforced upstream cap, so clamp defensively at render time — an over-long
// field would otherwise make chat.postMessage reject the whole payload with
// `invalid_blocks`, leaving the user with a stuck "thinking…" message.
const SECTION_MAX = 2900; // headroom under 3000 for surrounding markdown
const HEADER_MAX = 140;   // headroom under 150
function clamp(str, max = SECTION_MAX) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Builds the Block Kit payload for a successful (non-accounting) response.
 * Stays well under Slack's 50-block limit by capping steps and refs.
 *
 * @param {object} data - Parsed Claude response
 * @returns {Array} Slack blocks array
 */

// Builds the Sources button JSON value, fitting as many refs as possible within
// Slack's 2000-char button value limit. Tries 3 entries per type, falls back to 2 or 1.
function _buildSourcesButtonValue(slack_refs, atlassian_refs, kb_refs, diagnosis = null) {
  const capRef = (ref) => ({
    url:   (ref.url   ?? '').slice(0, 150),
    title: (ref.title ?? '').slice(0, 60),
    ...(ref.channel ? { channel: ref.channel.slice(0, 40) } : {}),
    ...(ref.type    ? { type:    ref.type }                 : {}),
    ...(ref.snippet ? { snippet: ref.snippet.slice(0, 80) } : {}),
  });
  const diagStr = diagnosis ? String(diagnosis).slice(0, 300) : null;
  for (let n = 3; n >= 1; n--) {
    const v = JSON.stringify({
      diagnosis:      diagStr,
      slack_refs:     slack_refs.slice(0, n).map(capRef),
      atlassian_refs: atlassian_refs.slice(0, n).map(capRef),
      kb_refs:        kb_refs.slice(0, n).map(capRef),
    });
    if (v.length <= 1990) return v;
  }
  return JSON.stringify({ diagnosis: diagStr, slack_refs: [], atlassian_refs: [], kb_refs: [] });
}

export function buildResponseBlocks(data, { isDm = false, role = 'csa' } = {}) {
  const blocks = [];
  const conf = CONFIDENCE_META[data.confidence] ?? CONFIDENCE_META.medium;

  const slackRefs     = data.slack_refs     ?? [];
  const atlassianRefs = data.atlassian_refs ?? [];
  const kbRefs        = data.kb_refs        ?? [];

  // Sensitive refs are hidden from CSAs; Specialists see everything
  const isSpecialist  = role === 'specialist';
  const visibleSlack      = isSpecialist ? slackRefs     : slackRefs.filter(r => !r.sensitive);
  const visibleAtlassian  = isSpecialist ? atlassianRefs : atlassianRefs.filter(r => !r.sensitive);
  const hiddenCount   = (slackRefs.length - visibleSlack.length) + (atlassianRefs.length - visibleAtlassian.length);

  // 1. Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: clamp(`${conf.icon} ${data.issue_title ?? 'Troubleshooting'}`, HEADER_MAX), emoji: true },
  });
  blocks.push({ type: 'divider' });

  // 2. Compact info line
  const sourcesText = (data.sources_used ?? []).join(', ') || 'none';
  let infoText;
  if (data.escalate_decision) {
    const ed = data.escalate_decision;
    const channel = data.channel_recommendation?.channel ?? 'ask-integrations';
    const reason = (data.channel_recommendation?.reason ?? ed.reason ?? '').slice(0, 120);
    if (ed.should_escalate) {
      infoText = `📢 Post in #${channel} · ${conf.icon} ${conf.label} · ${reason}`;
    } else if (data.confidence === 'low' || data.confidence === 'medium') {
      infoText = `🔎 Post to verify · ${conf.icon} ${conf.label} · ${reason}`;
    } else {
      infoText = `✅ Handle yourself · ${conf.icon} ${conf.label} · ${reason}`;
    }
  } else {
    infoText = `${conf.icon} ${conf.label} confidence · Sources: ${sourcesText}`;
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: infoText }],
  });

  if (data.findings_summary?.diagnosis) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔍 _${data.findings_summary.diagnosis}_` }],
    });
  }

  const chips = [];
  if (visibleAtlassian.some(r => r.type === 'confluence')) chips.push('📄 Confluence');
  if (visibleAtlassian.some(r => r.type === 'jira'))       chips.push('📄 Jira');
  if (visibleSlack.length > 0)                             chips.push('💬 Slack');
  if (kbRefs.length > 0)                                   chips.push('📖 KB');
  if (hiddenCount > 0)                                     chips.push(`_+${hiddenCount} specialist-only_`);
  if (chips.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: chips.join('  ·  ') }],
    });
  }

  // 3. Customer message
  if (data.customer_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `💬 _"${clamp(data.customer_message)}"_` },
    });
  }

  // 4. Steps header + steps
  const steps = (data.agent_steps ?? []).slice(0, 20);
  if (steps.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔧 What you do*' },
    });
    for (const step of steps) {
      const circle = TAG_CIRCLE[step.tag] ?? '⚪';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: clamp(`${circle} *${step.num}. ${clamp(step.title, 200)}*  \`${step.tag}\`\n${step.detail}`),
        },
      });
    }
  }

  // 5. Action buttons
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

  const totalVisibleRefs = visibleSlack.length + visibleAtlassian.length + kbRefs.length;
  if (totalVisibleRefs > 0) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Diagnosis + Sources', emoji: true },
      action_id: 'view_sources_modal',
      value: _buildSourcesButtonValue(
        visibleSlack,
        visibleAtlassian,
        kbRefs,
        data.findings_summary?.diagnosis ?? null,
      ),
    });
  }

  if (data._showSpecialistValue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
      action_id: 'show_specialist_detail',
      value: data._showSpecialistValue,
    });
  }

  if (data.escalate_decision?.should_escalate && data.suggested_channel_post) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📋 Channel post', emoji: true },
      action_id: 'copy_channel_post',
      value: (data.suggested_channel_post ?? '').slice(0, 2000),
    });
  }

  if (isDm) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '💬 New chat', emoji: true },
      action_id: 'new_chat',
      value: 'new_chat',
    });
  }

  blocks.push({ type: 'actions', elements: actionElements });
  blocks.push({ type: 'divider' });

  return blocks;
}

export function buildWelcomeCard() {
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: "*👋 Welcome to IntBot!*\nI diagnose integration issues and walk you through step-by-step fixes. Start a chat when you're ready." },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 New chat', emoji: true },
          action_id: 'new_chat',
          style: 'primary',
          value: 'new_chat',
        },
      ],
    },
  ];
}

export function buildSessionCard() {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🟢 Integration chat*\nReady when you are.' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Ask an integration question', emoji: true },
          action_id: 'start_chat_thread',
          value: 'start_chat_thread',
        },
      ],
    },
  ];
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
export function buildThinkingBlocks(_query) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*⚙️ Looking into this…*\n○ Team KB\n○ Confluence\n○ Jira',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Searching Confluence, Jira, Slack, and team KB_' }],
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
export function buildFollowUpBlocks(text, { label = 'Follow-up' } = {}) {
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${label}_` }],
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
        text: `*What I can't help with*\nAccounting integrations (QuickBooks, NetSuite, Sage Intacct, Xero, etc.) — those go to ${ACCOUNTING_REDIRECT_CHANNEL}.`,
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

/**
 * Builds the Sources modal shown when an agent clicks 📎 Sources.
 * Groups refs by type: Slack, Atlassian (Confluence + Jira), Knowledge Base.
 *
 * @param {object} data - { diagnosis, slack_refs, atlassian_refs, kb_refs }
 * @returns {object} Slack modal view payload
 */
export function buildSourcesModal({ diagnosis = null, slack_refs = [], atlassian_refs = [], kb_refs = [] } = {}) {
  const blocks = [];

  if (diagnosis) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clamp(`*🔍 Root Cause*\n${diagnosis}`) },
    });
    blocks.push({ type: 'divider' });
  }

  if (slack_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💬 Slack (${slack_refs.length})*` },
    });
    for (const ref of slack_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clamp(`• <${ref.url}|${ref.title}>\n  _${ref.channel}_`) },
      });
    }
  }

  if (atlassian_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📄 Atlassian (${atlassian_refs.length})*` },
    });
    for (const ref of atlassian_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clamp(`• <${ref.url}|${ref.title}>`) },
      });
    }
  }

  if (kb_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📚 Knowledge Base (${kb_refs.length})*` },
    });
    for (const ref of kb_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clamp(`• <${ref.url}|${ref.title}>\n  _${ref.snippet}_`) },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No specific sources were found for this answer.' },
    });
  }

  return {
    type: 'modal',
    callback_id: 'sources_view',
    title: { type: 'plain_text', text: '🔍 Diagnosis & Sources', emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    blocks,
  };
}

const CHAT_SOURCE_LABEL = { confluence: '📄 Confluence', jira: '📄 Jira', slack: '💬 Slack', kb: '📖 KB', knowledge: '📚 Team knowledge' };

export function buildChatResolutionBlocks(data) {
  const blocks = [];
  const isEscalation = data.escalate === true;

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: isEscalation ? '🔴 *Needs escalation*' : '✅ *Root cause found*' }],
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: clamp(`*${clamp(data.title, 200)}*\n_${data.diagnosis}_`) },
  });

  if (isEscalation && data.escalation_path) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📍 *Escalation path:* ${data.escalation_path}` }],
    });
  }

  for (const step of (data.steps ?? []).slice(0, 10)) {
    const circle = TAG_CIRCLE[step.tag] ?? '⚪';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clamp(`${circle} \`${step.tag}\` ${step.text}`) },
    });
  }

  const chips = (data.refs ?? [])
    .map(r => CHAT_SOURCE_LABEL[r.source])
    .filter(Boolean);
  if (chips.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Verified: ${chips.join('  ·  ')}_` }],
    });
  }

  blocks.push({ type: 'divider' });

  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({ query: (data.title ?? '').slice(0, 400), issueTitle: (data.title ?? '').slice(0, 100), integrationType: '' }),
    },
  ];

  if (isEscalation && data.suggested_channel_post) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📋 Channel post', emoji: true },
      action_id: 'copy_channel_post',
      value: (data.suggested_channel_post ?? '').slice(0, 2000),
    });
  }

  actionElements.push({
    type: 'button',
    text: { type: 'plain_text', text: '💬 New chat', emoji: true },
    action_id: 'new_chat',
    value: 'new_chat',
  });

  blocks.push({ type: 'actions', elements: actionElements });

  return blocks;
}

function capitalizeFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const TOOL_LABEL = { kb: 'Team KB', confluence: 'Confluence', jira: 'Jira' };
const KNOWN_TOOLS = ['kb', 'confluence', 'jira'];
const DEFAULT_STATUS = '_Searching Confluence, Jira, Slack, and team KB_';

function truncateQuery(q, max = 60) {
  if (!q) return '';
  const s = String(q).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function buildProgressBlocks(query, steps) {
  const toolStatus = {};
  let slackSearching = false;
  let isWriting = false;

  for (const step of steps) {
    const tool = (step.tool ?? '').toLowerCase();
    if (step.phase === 'writing') {
      isWriting = true;
    } else if (step.phase === 'tool_start') {
      if (tool === 'slack') slackSearching = true;
      else toolStatus[tool] = { phase: 'searching' };
    } else if (step.phase === 'tool_done') {
      if (tool === 'slack') slackSearching = false;
      else toolStatus[tool] = { phase: 'done', count: step.count };
    }
  }

  const lines = ['*⚙️ Looking into this…*'];

  for (const tool of KNOWN_TOOLS) {
    const label = TOOL_LABEL[tool];
    const status = toolStatus[tool];
    if (!status) {
      lines.push(`○ ${label}`);
    } else if (status.phase === 'searching') {
      lines.push(`⟳ ${label}  _searching…_`);
    } else {
      if (status.count === null) {
        lines.push(`✓ ${label}`);
      } else if (status.count === 0) {
        lines.push(`–  ${label}  · no results`);
      } else {
        const countLabel = status.count === 1 ? '1 result' : `${status.count} results`;
        lines.push(`✓ ${label}  · ${countLabel}`);
      }
    }
  }

  let statusLine = DEFAULT_STATUS;
  if (isWriting) {
    statusLine = '_Now: writing answer…_';
  } else if (slackSearching) {
    const q = truncateQuery(query);
    statusLine = q ? `_Now: searching Slack for "${q}"_` : '_Now: searching Slack…_';
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusLine }] },
  ];
}
