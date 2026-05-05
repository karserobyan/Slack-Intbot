/**
 * Builds the Slack modal for collecting audit log query parameters.
 *
 * @param {{ channelId: string, threadTs: string }} params
 * @returns {object} Slack view payload for use with client.views.open()
 */
export function buildAuditLogModal({ channelId, threadTs }) {
  return {
    type: 'modal',
    callback_id: 'audit_log_submission',
    title: { type: 'plain_text', text: '📋 Log Request', emoji: true },
    submit: { type: 'plain_text', text: 'Search logs', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: JSON.stringify({ channelId, threadTs }),
    blocks: [
      {
        type: 'input',
        block_id: 'tenant_block',
        label: { type: 'plain_text', text: 'Tenant name', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'tenant_input',
          placeholder: { type: 'plain_text', text: 'e.g. Acme Corp' },
        },
      },
      {
        type: 'input',
        block_id: 'question_block',
        optional: true,
        label: { type: 'plain_text', text: 'What are you looking for?', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'question_input',
          placeholder: { type: 'plain_text', text: 'e.g. Zapier stopped working yesterday' },
        },
      },
      {
        type: 'input',
        block_id: 'time_range_block',
        optional: true,
        label: { type: 'plain_text', text: 'Time range', emoji: true },
        element: {
          type: 'static_select',
          action_id: 'time_range_select',
          initial_option: { text: { type: 'plain_text', text: 'Last 14 days', emoji: true }, value: '14' },
          options: [
            { text: { type: 'plain_text', text: 'Last 7 days',  emoji: true }, value: '7'  },
            { text: { type: 'plain_text', text: 'Last 14 days', emoji: true }, value: '14' },
            { text: { type: 'plain_text', text: 'Last 30 days', emoji: true }, value: '30' },
            { text: { type: 'plain_text', text: 'Last 90 days', emoji: true }, value: '90' },
          ],
        },
      },
    ],
  };
}

export function buildChannelPostModal(text) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '📋 Channel post', emoji: true },
    close:  { type: 'plain_text', text: 'Close', emoji: true },
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Select all and copy — then paste in the appropriate channel._' }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}
