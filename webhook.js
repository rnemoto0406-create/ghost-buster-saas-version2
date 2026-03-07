'use strict';

const TIMEOUT_MS = 15_000;

async function pushToWebhook(webhookUrl, jobs, meta = {}) {
  if (!webhookUrl) {
    return { ok: false, error: 'No webhook URL configured' };
  }

  const payload = {
    source:         'Ghost Buster Server',
    timestamp:      new Date().toISOString(),
    total_scanned:  meta.totalScanned || 0,
    low_risk_count: jobs.length,
    jobs,
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    return res.ok
      ? { ok: true }
      : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pushToWebhook };
