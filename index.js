'use strict';

require('dotenv').config();

const { Client }  = require('pg');
const express     = require('express');
const { buildJobPayload } = require('./scorer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let pgClient;

async function startDB() {
  pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();
  console.log('✅ DB Connected (Postgres)');
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ghost Buster - Upwork Job Monitor</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
          .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.1); max-width: 480px; width: 100%; }
          h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
          p { color: #666; margin-bottom: 1.5rem; font-size: 0.95rem; }
          label { display: block; font-weight: 600; margin-bottom: 0.3rem; font-size: 0.9rem; }
          small { color: #888; font-size: 0.8rem; display: block; margin-bottom: 0.8rem; }
          input, select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.95rem; margin-bottom: 1rem; }
          button { width: 100%; padding: 12px; background: #14a800; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
          button:hover { background: #108a00; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🚀 Ghost Buster</h1>
          <p>Get instant Upwork job alerts delivered to your Discord or Slack. Never miss a great opportunity.</p>
          <form action="/register" method="POST">
            <label>Email</label>
            <input type="email" name="email" required placeholder="you@example.com" />
            <label>Webhook URL</label>
            <small>Discord or Slack webhook URL where you want to receive job alerts.</small>
            <input type="url" name="webhook_url" required placeholder="https://discord.com/api/webhooks/..." />
            <label>Keywords</label>
            <small>Comma-separated keywords. e.g. python, data entry, writing</small>
            <input type="text" name="keywords" placeholder="python, scraping, automation" />
            <label>Minimum Budget (USD)</label>
            <input type="number" name="min_budget" placeholder="0" min="0" value="0" />
            <label>Max Risk Score</label>
            <small>Jobs above this score will be filtered out. (0 = strictest, 100 = all jobs)</small>
            <select name="max_risk">
              <option value="20">20 - Very strict</option>
              <option value="40" selected>40 - Recommended</option>
              <option value="60">60 - Relaxed</option>
              <option value="100">100 - All jobs</option>
            </select>
            <button type="submit">Start Monitoring →</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/register', async (req, res) => {
  const { email, webhook_url, keywords, min_budget, max_risk } = req.body;
  try {
    await pgClient.query(
      `INSERT INTO users (email, webhook_url, max_risk, min_budget, keywords, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (email) DO UPDATE SET
         webhook_url = EXCLUDED.webhook_url,
         max_risk    = EXCLUDED.max_risk,
         min_budget  = EXCLUDED.min_budget,
         keywords    = EXCLUDED.keywords,
         is_active   = true`,
      [email, webhook_url, parseInt(max_risk) || 40, parseInt(min_budget) || 0, keywords || null]
    );
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Ghost Buster - Success</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:2rem;">
          <h2 style="color:#14a800;">✅ You're all set!</h2>
          <p>Job alerts will start arriving at your webhook shortly.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Registration failed.');
  }
});

app.post('/uphunt-webhook', async (req, res) => {
  try {
    const jobs = Array.isArray(req.body) ? req.body : [req.body];
    console.log(`📥 Received ${jobs.length} job(s) from UpHunt`);

    const { rows: users } = await pgClient.query(
      'SELECT * FROM users WHERE is_active = true'
    );

    for (const job of jobs) {
      const payload = buildJobPayload(job);
      console.log(`🔍 Job: "${(payload.title||'').slice(0, 50)}" Risk: ${payload.risk_score}`);

      for (const user of users) {
        if (!matchesUser(payload, user)) continue;
        const result = await sendWebhook(user.webhook_url, payload);
        if (result.ok) {
          console.log(`🎯 Sent to User ${user.id}`);
        } else {
          console.warn(`⚠️ Webhook failed for User ${user.id}:`, result.error || result.status);
        }
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).json({ ok: false });
  }
});

function matchesUser(payload, user) {
  if (payload.risk_score > user.max_risk) return false;
  if (user.min_budget && user.min_budget > 0) {
    if ((payload.budget_amount || 0) < user.min_budget) return false;
  }
  if (user.keywords) {
    const keywords = user.keywords.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const text = [payload.title, payload.description, payload.skills].join(' ').toLowerCase();
    if (!keywords.some(kw => text.includes(kw))) return false;
  }
  return true;
}

async function sendWebhook(webhookUrl, payload) {
  const message =
    `**${payload.title}**\n` +
    `💰 ${payload.budget || 'N/A'}\n` +
    `⚠️ Risk Score: ${payload.risk_score}${payload.risk_flags?.length ? ` (${payload.risk_flags.join(', ')})` : ''}\n` +
    `🔗 ${payload.url}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, text: message }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

startDB().catch(err => {
  console.error('💀 Failed to connect to DBs:', err.message);
  process.exit(1);
});