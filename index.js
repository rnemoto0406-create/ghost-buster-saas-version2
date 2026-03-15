'use strict';

require('dotenv').config();

const { Client }      = require('pg');
const { createClient } = require('redis');
const { runScanner, randomIntervalMs } = require('./scraper');

const SCAN_INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes when no accounts/users

async function startSaaS() {
  const pgClient    = new Client({ connectionString: process.env.DATABASE_URL });
  const redisClient = createClient({ url: process.env.REDIS_URL });

  redisClient.on('error', (err) => console.error('⚠️ Redis error:', err.message));

  try {
    await pgClient.connect();
    await redisClient.connect();
    console.log('✅ DB Connected (Postgres & Redis)');
  } catch (err) {
    console.error('💀 Failed to connect to DBs:', err.message);
    process.exit(1); // Railway will auto-restart
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  while (true) {
    console.log(`\n🔄 [${new Date().toISOString()}] Starting scan round...`);

    try {
      // Fetch active account and users fresh every round
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

      // Try accounts in order until one succeeds
      let scanSuccess = false;
      for (const account of accounts) {
        try {
          await runScanner({ account, users, redis: redisClient, pg: pgClient });
          // Mark account as used
          await pgClient.query(
            'UPDATE burner_accounts SET last_used_at = NOW() WHERE id = $1',
            [account.id]
          );
          scanSuccess = true;
          break; // Success — no need to try more accounts
        } catch (scanErr) {
          // runScanner already handles ban marking; just try next account
          console.warn(`⚠️ Account ${account.email} failed, trying next...`);
        }
      }

      if (!scanSuccess) {
        console.error('❌ All accounts failed this round. Will retry in 5 min.');
      }
    } catch (err) {
      // DB query errors — transient, log and continue
      console.error('❌ Loop error:', err.message);
    }

    await sleep(randomIntervalMs());
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

startSaaS();