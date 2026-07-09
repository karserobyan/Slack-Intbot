import { escapeMrkdwn } from './mrkdwn.js';

export function buildChannelPostModal(text) {
  const safeText = text ? escapeMrkdwn(text) : '_No channel post text was generated._';
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
        text: { type: 'mrkdwn', text: safeText },
      },
    ],
  };
}
