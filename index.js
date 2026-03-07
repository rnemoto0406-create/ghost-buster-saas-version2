'use strict';

require('dotenv').config();

const { Client }      = require('pg');
const { createClient } = require('redis');
const { runScanner }  = require('./scraper');
const express         = require('express');

const SCAN_INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Webサーバーの設定 ---
const app = express();
app.use(express.urlencoded({ extended: true }));

let pgClient, redisClient;

async function startDB() {
  pgClient    = new Client({ connectionString: process.env.DATABASE_URL });
  redisClient = createClient({ url: process.env.REDIS_URL });

  redisClient.on('error', (err) => console.error('⚠️ Redis error:', err.message));

  try {
    await pgClient.connect();
    await redisClient.connect();
    console.log('✅ DB Connected (Postgres & Redis)');
  } catch (err) {
    console.error('💀 Failed to connect to DBs:', err.message);
    process.exit(1);
  }
}

// 登録フォーム画面（Ross氏がアクセスする入り口）
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Upwork Scanner Setup</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family: sans-serif; padding: 2rem; max-width: 600px; margin: 0 auto;">
        <h2>SaaS Webhook Registration</h2>
        <p>Please enter your Discord or Slack Webhook URL below to start receiving Upwork job notifications.</p>
        <form action="/register" method="POST">
          <input type="hidden" name="email" value="ross@example.com" />
          <label style="font-weight: bold;">Webhook URL:</label><br/>
          <input type="url" name="webhook_url" required style="width: 100%; padding: 10px; margin-top: 8px; margin-bottom: 20px; box-sizing: border-box;" placeholder="https://..." />
          <button type="submit" style="padding: 10px 20px; font-size: 16px; cursor: pointer; background-color: #0056b3; color: white; border: none; border-radius: 4px;">Start Monitoring</button>
        </form>
      </body>
    </html>
  `);
});

// フォーム送信時のDB登録処理
app.post('/register', async (req, res) => {
  const { email, webhook_url } = req.body;
  try {
    await pgClient.query(
      'INSERT INTO users (email, webhook_url, max_risk, is_active) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, max_risk = EXCLUDED.max_risk, is_active = EXCLUDED.is_active',
      [email, webhook_url, 40, true]
    );
    res.send('<div style="font-family: sans-serif; padding: 2rem; text-align: center;"><h2 style="color: green;">✅ Registration Complete!</h2><p>You can close this window. The scanner will now send jobs to your webhook.</p></div>');
  } catch (error) {
    console.error(error);
    res.send('<div style="font-family: sans-serif; padding: 2rem; text-align: center;"><h2 style="color: red;">❌ Registration Failed</h2><p>Please contact support.</p></div>');
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Registration Server running on port ${PORT}`);
});

// --- 従来のスクレイピングループ処理 ---
async function startSaaS() {
  await startDB();
  
  while (true) {
    console.log(`\n🔄 [${new Date().toISOString()}] Starting scan round...`);
    try {
      const { rows: accounts } = await pgClient.query(
        "SELECT * FROM burner_accounts WHERE status = 'active' ORDER BY last_used_at ASC NULLS FIRST LIMIT 5"
      );
      const { rows: users } = await pgClient.query(
        'SELECT * FROM users WHERE is_active = true'
      );

      if (accounts.length === 0) {
        console.warn('⚠️ No active burner accounts. Waiting...');
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }
      if (users.length === 0) {
        console.warn('⚠️ No active users. Waiting...');
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      let scanSuccess = false;
      for (const account of accounts) {
        try {
          await runScanner({ account, users, redis: redisClient, pg: pgClient });
          await pgClient.query(
            'UPDATE burner_accounts SET last_used_at = NOW() WHERE id = $1',
            [account.id]
          );
          scanSuccess = true;
          break;
        } catch (scanErr) {
          console.warn(`⚠️ Account ${account.email} failed. Error details:`, scanErr.message);
        }
      }

      if (!scanSuccess) {
        console.error('❌ All accounts failed this round. Will retry in 5 min.');
      }
    } catch (err) {
      console.error('❌ Loop error:', err.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

startSaaS();