import { approveFeedback, rejectFeedback } from './feedback.js';
import { approveNomination, rejectNomination } from './nominations.js';
import { isAuthorizedModerator, sendUnauthorizedResponse } from './moderation.js';

async function getReviewerName(client, body) {
  let reviewerName = body?.user?.name ?? body?.user?.id ?? 'Reviewer';
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch {
  }
  return reviewerName;
}

async function denyIfUnauthorized({ body, client, respond, logger, actionName, env }) {
  if (isAuthorizedModerator(body?.user?.id, env)) return false;
  await sendUnauthorizedResponse({ body, client, respond, logger, actionName });
  return true;
}

export async function handleFeedbackReviewAction({
  decision,
  feedbackId,
  body,
  client,
  respond,
  logger,
  env = process.env,
  deps = { approveFeedback, rejectFeedback },
}) {
  const actionName = `${decision}_feedback`;
  if (await denyIfUnauthorized({ body, client, respond, logger, actionName, env })) {
    return { status: 'unauthorized' };
  }
  if (!feedbackId) return { status: 'bad_request' };

  const record = decision === 'approve'
    ? await deps.approveFeedback(feedbackId)
    : await deps.rejectFeedback(feedbackId);
  if (!record) return { status: 'not_found' };

  const reviewerName = await getReviewerName(client, body);
  const approved = decision === 'approve';
  const icon = approved ? '✅' : '❌';
  const verb = approved ? 'Approved' : 'Rejected';

  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `${icon} ${verb} by ${reviewerName}`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `${icon} *${verb} by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
      }],
    }).catch((err) => logger?.warn?.(`[feedback] Failed to update review card: ${err.message}`));
  }

  const dmText = approved
    ? `✅ Your feedback on *"${record.issueTitle}"* was approved and applied — thanks for helping improve the bot!`
    : `Your feedback on *"${record.issueTitle}"* was reviewed and not applied — thanks for flagging it.`;
  await client.chat.postMessage({ channel: record.agentId, text: dmText })
    .catch((err) => logger?.warn?.(`[feedback] Failed to DM agent after ${decision}: ${err.message}`));

  logger?.info?.(`[feedback] ${feedbackId} ${decision}d by ${reviewerName}`);
  return { status: decision === 'approve' ? 'approved' : 'rejected', record };
}

export async function handleNominationReviewAction({
  decision,
  nominationId,
  body,
  client,
  respond,
  logger,
  env = process.env,
  deps = { approveNomination, rejectNomination },
}) {
  const actionName = `${decision}_nomination`;
  if (await denyIfUnauthorized({ body, client, respond, logger, actionName, env })) {
    return { status: 'unauthorized' };
  }
  if (!nominationId) return { status: 'bad_request' };

  const reviewerName = await getReviewerName(client, body);
  const record = decision === 'approve'
    ? await deps.approveNomination(nominationId, client, reviewerName)
    : await deps.rejectNomination(nominationId, client, reviewerName);
  if (!record) return { status: 'not_found' };

  logger?.info?.(`[nominations] ${nominationId} ${decision}d by ${reviewerName}`);
  return { status: decision === 'approve' ? 'approved' : 'rejected', record };
}
