function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return String(raw).toLowerCase() !== 'false';
}

function envStrictTrue(name) {
  return String(process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function envPositiveInt(name, defaultValue) {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function isQualityLayerEnabled() {
  return envStrictTrue('QUALITY_LAYER_ENABLED');
}

export function isQualityShadowMode() {
  return envFlag('QUALITY_LAYER_SHADOW_MODE', true);
}

export function getQualityShadowRetention() {
  return {
    maxRecords: envPositiveInt('QUALITY_SHADOW_MAX_RECORDS', 2000),
    maxAgeDays: envPositiveInt('QUALITY_SHADOW_MAX_AGE_DAYS', 14),
    maxBytes: envPositiveInt('QUALITY_SHADOW_MAX_BYTES', 5 * 1024 * 1024),
  };
}
