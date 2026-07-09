function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return String(raw).toLowerCase() !== 'false';
}

function envPositiveInt(name, defaultValue) {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function isQualityLayerEnabled() {
  return envFlag('QUALITY_LAYER_ENABLED', false);
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
