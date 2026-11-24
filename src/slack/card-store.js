import { shortId } from './cache.js';

const TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? '3600000', 10) || 3600000;
const MAX_ENTRIES = 50;

const store = new Map();

export function rememberCard(query, view) {
  const id = shortId(query);
  store.delete(id);
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(id, { data: view, expiresAt: Date.now() + TTL_MS });
}

export function getCardById(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(id);
    return null;
  }
  return entry.data;
}

export function forgetCard(query) {
  store.delete(shortId(query));
}
