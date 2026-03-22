'use strict';

require('dotenv').config();

const { Client }       = require('pg');
const { createClient } = require('redis');
const { runScanner, randomIntervalMs } = require('./scraper');
const express          = require('express');

const RETRY_INTERVAL_MS = 5 * 60 * 1000;

// ── Web registration server ───────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let pgClient, redisClient;

// Registration form
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
            <small>Comma-separated keywords to filter jobs. e.g. python, data entry, writing</small>
            <input type="text" name="keywords" placeholder="python, scraping, automation" />

            <label>Minimum Budget (USD)</label>
            <input type="number" name="min_budget" placeholder="0" min="0" value="0" />

            <label>Max Risk Score</label>
            <small>Jobs with a risk score above this will be filtered out. (0 = strictest, 100 = all jobs)</small>
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

// Handle registration
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
        <head><title>Ghost Buster - Success</title><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>* { box-sizing: border-box; } body { font-family: -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; } .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.1); max-width: 480px; width: 100%; text-align: center; } h1 { color: #14a800; margin-bottom: 1rem; } p { color: #666; }</style>
        </head>
        <body><div class="card"><h1>✅ You're all set!</h1><p>Job alerts will start arriving at your webhook shortly. You can close this page.</p></div></body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Error</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:2rem;">
          <h2 style="color:red;">❌ Registration failed</h2>
          <p>Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Registration server running on port ${PORT}`);
});

// ── DB connection ─────────────────────────────────────────────────────────
async function startDB() {
  pgClient    = new Client({ connectionString: process.env.DATABASE_URL });
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 500, 5000),
    },
  });

  redisClient.on('error', (err) => console.error('⚠️ Redis error:', err.message));

  await pgClient.connect();
  await redisClient.connect();
  console.log('✅ DB Connected (Postgres & Redis)');
}

// ── Main scan loop ────────────────────────────────────────────────────────
async function startSaaS() {
  try {
    await startDB();
  } catch (err) {
    console.error('💀 Failed to connect to DBs:', err.message);
    process.exit(1);
  }

  while (true) {
    console.log(`\n🔄 [${new Date().toISOString()}] Starting scan round...`);

    try {
      const { rows: users } = await pgClient.query(
        'SELECT * FROM users WHERE is_active = true'
      );

      if (users.length === 0) {
        console.warn('⚠️ No active users. Waiting...');
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      await runScanner({ users, redis: redisClient, pg: pgClient });

    } catch (err) {
      console.error('❌ Loop error:', err.message);
    }

    await sleep(randomIntervalMs());
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

startSaaS();
