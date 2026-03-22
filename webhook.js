'use strict';

const TIMEOUT_MS = 15_000;

async function pushToWebhook(webhookUrl, jobs, meta = {}) {
  if (!webhookUrl) {
    return { ok: false, error: 'No webhook URL configured' };
  }

  // 通知用のテキストメッセージを組み立てる
  const jobTexts = jobs.map(job => 
    `**${job.title}**\n` +
    `💰 Budget: ${job.budget || 'N/A'}\n` +
    `⚠️ Risk Score: ${job.risk_score} (Flags: ${job.risk_flags.length ? job.risk_flags.join(', ') : 'None'})\n` +
    `🔗 ${job.url}`
  ).join('\n\n---\n\n');

  const message = `🚀 **Upwork Scanner Found ${jobs.length} Jobs** (Scanned: ${meta.totalScanned || 0})\n\n${jobTexts}`;

  // Discord ('content') と Slack ('text') の両方に対応するペイロード
  const payload = {
    content: message,
    text: message
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, { //
      method:  'POST', //
      headers: { 'Content-Type': 'application/json' }, //
      body:    JSON.stringify(payload),
      signal:  controller.signal, //
    });

    return res.ok
      ? { ok: true } //
      : { ok: false, status: res.status }; //
  } catch (err) {
    return { ok: false, error: err.message }; //
  } finally {
    clearTimeout(timer); //
  }
}

module.exports = { pushToWebhook }; //