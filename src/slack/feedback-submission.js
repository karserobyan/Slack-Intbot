import { notifyFeedbackChannel, saveFeedback } from './feedback.js';

export async function handleFeedbackSubmission({
  body,
  view,
  client,
  logger,
  deps = { saveFeedback, notifyFeedbackChannel },
}) {
  let context = {};
  try {
    context = JSON.parse(view.private_metadata || '{}');
  } catch {
    logger?.warn?.('[feedback] Could not parse private_metadata — proceeding with empty context');
  }

  const values = view.state.values;
  const feedbackType = values.feedback_type_block?.feedback_type_select?.selected_option?.value ?? 'wrong_answer';
  const correction = values.correction_block?.correction_input?.value ?? '';
  const submitterId = body.user?.id ?? 'unknown';
  const submitterName = body.user?.name ?? submitterId;

  let record;
  try {
    record = await deps.saveFeedback({
      query: context.query,
      issueTitle: context.issueTitle,
      integrationType: context.integrationType,
      feedbackType,
      correction,
      agentId: submitterId,
      agentName: submitterName,
    });
  } catch (err) {
    logger?.error?.(`[feedback] Failed to save submission from ${submitterName} (${submitterId}) for ${context.integrationType ?? 'unknown integration'} / ${context.issueTitle ?? 'unknown issue'} [${feedbackType}]: ${err.message}`);
    await client.chat.postMessage({
      channel: submitterId,
      text: `I couldn't save your feedback just now. Please try again in a moment.`,
    }).catch((dmErr) => logger?.warn?.(`[feedback] Could not DM save failure to ${submitterName} (${submitterId}): ${dmErr.message}`));
    return { status: 'save_failed' };
  }

  logger?.info?.(`[feedback] Saved ${record.id} from ${submitterName}: ${feedbackType}`);

  await deps.notifyFeedbackChannel(client, record);

  try {
    await client.chat.postMessage({
      channel: submitterId,
      text: `Thanks for the feedback! It's been sent for review — if approved, it'll help improve the bot.`,
    });
  } catch (err) {
    logger?.warn?.(`[feedback] Could not DM submission confirmation to ${submitterName}: ${err.message}`);
  }

  return { status: 'saved', record };
}
