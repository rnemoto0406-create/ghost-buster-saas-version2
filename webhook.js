'use strict';

const TIMEOUT_MS = 15_000;

async function pushToWebhook(webhookUrl, jobs, meta = {}) {
  if (!webhookUrl) return { ok: false, error: 'No webhook URL' };

  const jobTexts = jobs.map(job =>
    `**${job.title}**\n💰 ${job.budget || 'N/A'}\n⚠️ Risk: ${job.risk_score}\n🔗 ${job.url}`
  ).join('\n\n---\n\n');

  const message = `🚀 **New Upwork Jobs** (${jobs.length} found)\n\n${jobTexts}`;
  const payload = { content: message, text: message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pushToWebhook };