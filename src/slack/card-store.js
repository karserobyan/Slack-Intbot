import { randomBytes } from 'node:crypto';

const MAX_ENTRIES = 300;

const store = new Map();

function ttlMs() {
  return parseInt(process.env.CARD_TTL_MS ?? '86400000', 10) || 86400000;
}

export function rememberCard(view) {
  const id = randomBytes(6).toString('hex');
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(id, { data: { ...view }, expiresAt: Date.now() + ttlMs() });
  return id;
}

export function getCardById(id) {
  if (typeof id !== 'string') return null;
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(id);
    return null;
  }
  return entry.data;
}

export function cardStoreSize() {
  return store.size;
}

export function forgetCard(id) {
  store.delete(id);
}
