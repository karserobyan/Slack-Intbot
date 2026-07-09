export function getModeratorIds(env = process.env) {
  return new Set(
    String(env.MODERATOR_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAuthorizedModerator(userId, env = process.env) {
  if (!userId) return false;
  return getModeratorIds(env).has(userId);
}

export function requireAuthorizedModerator(userId, env = process.env) {
  if (isAuthorizedModerator(userId, env)) return true;
  const err = new Error(`User ${userId ?? '(missing)'} is not authorized to review IntegrationsBot feedback.`);
  err.code = 'not_authorized';
  err.userId = userId ?? null;
  throw err;
}

export async function sendUnauthorizedResponse({ body, client, respond, logger, actionName }) {
  const userId = body?.user?.id;
  logger?.warn?.(`[moderation] unauthorized ${actionName} by ${userId ?? '(missing user)'}`);
  const text = 'You are not authorized to approve or reject IntegrationsBot review items.';

  if (respond) {
    try {
      await respond({ response_type: 'ephemeral', text });
      return;
    } catch (err) {
      logger?.warn?.(`[moderation] respond failed for unauthorized ${actionName}: ${err.message}`);
    }
  }

  const channel = body?.channel?.id;
  if (client?.chat?.postEphemeral && channel && userId) {
    await client.chat.postEphemeral({ channel, user: userId, text }).catch((err) => {
      logger?.warn?.(`[moderation] postEphemeral failed for unauthorized ${actionName}: ${err.message}`);
    });
  }
}
