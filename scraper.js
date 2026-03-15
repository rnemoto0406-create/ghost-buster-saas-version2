'use strict';

const { chromium }      = require('playwright');
const { pushToWebhook } = require('./webhook');
const { buildJobPayload } = require('./scorer');

const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;
const TARGET_URL      = 'https://www.upwork.com/nx/find-work/most-recent';

// ── User-Agent pool ────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Random scan interval: 4〜8分 ───────────────────────────────────────────
function randomIntervalMs() {
  const min = 4 * 60 * 1000;
  const max = 8 * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runScanner({ account, users, redis, pg }) {
  // session_json can be stored as a string or parsed JSONB
  const cookies = typeof account.session_json === 'string'
    ? JSON.parse(account.session_json)
    : account.session_json;

  const ua = randomUA();
  console.log(`🌐 Using UA: ${ua.slice(0, 60)}...`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-extensions',
    ],
  });

  const context = await browser.newContext({
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Referer': 'https://www.upwork.com/',
    },
  });

  try {
    await context.addCookies(cookies);
    const page = await context.newPage();

    // ── Navigate ────────────────────────────────────────────────────────────
    const response = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const currentUrl = page.url();

    // ── Ban / session expiry detection ──────────────────────────────────────
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/ab/account-security') ||
      (response && response.status() === 403)
    ) {
      await markBanned(pg, account);
      throw new Error(`BANNED: account ${account.email} redirected to ${currentUrl}`);
    }

    // ── CAPTCHA detection ───────────────────────────────────────────────────
    const isCaptcha = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      return (
        title.includes('captcha') ||
        title.includes('blocked') ||
        !!document.querySelector('iframe[src*="recaptcha"]') ||
        !!document.querySelector('[data-sitekey]')
      );
    });

    if (isCaptcha) {
      console.warn(`🤖 CAPTCHA detected for ${account.email}. Skipping round.`);
      throw new Error(`CAPTCHA: account ${account.email}`);
    }

    // ── Extract jobs from Nuxt state ─────────────────────────────────────────
    const jobs = await page.evaluate(() => {
      // Try primary Nuxt path
      const nuxt = window.__NUXT__?.state;
      if (nuxt) {
        return (
          nuxt.feedMostRecent?.jobs ||
          nuxt['feed-most-recent']?.jobs ||
          []
        );
      }
      return [];
    });

    console.log(`👀 [${account.email}] Scraped ${jobs.length} jobs.`);
    if (jobs.length === 0) {
      console.warn('⚠️ No jobs found — Upwork may have changed their Nuxt state structure.');
      return;
    }

    // ── Process jobs ─────────────────────────────────────────────────────────
    let newCount   = 0;
    let sentCount  = 0;

    for (const job of jobs) {
      if (!job.ciphertext) continue;

      // Per-job Redis key with 7-day TTL (memory-efficient, no global set bloat)
      const redisKey = `seen:${job.ciphertext}`;
      const isNew    = await redis.set(redisKey, '1', { NX: true, EX: JOB_TTL_SECONDS });
      if (!isNew) continue; // Already seen

      newCount++;
      const payload = buildJobPayload(job);

      // Fan-out to each matching user
      for (const user of users) {
        if (payload.risk_score <= user.max_risk) {
          const result = await pushToWebhook(user.webhook_url, [payload], {
            totalScanned: jobs.length,
          });
          if (result.ok) {
            sentCount++;
            console.log(`🎯 Sent "${payload.title.slice(0, 40)}..." → User ${user.id}`);
          } else {
            console.warn(`⚠️ Webhook failed for User ${user.id}:`, result.status || result.error);
          }
        }
      }
    }

    console.log(`✅ Round complete. New: ${newCount}, Sent: ${sentCount}`);
  } catch (err) {
    console.error(`❌ Scraper error [${account.email}]: ${err.message}`);
    throw err; // Bubble up so index.js can try next account
  } finally {
    await browser.close();
  }
}

async function markBanned(pg, account) {
  await pg.query(
    "UPDATE burner_accounts SET status = 'banned' WHERE id = $1",
    [account.id]
  );
  console.warn(`🚫 Account ${account.email} marked as banned in DB.`);
}

module.exports = { runScanner, randomIntervalMs };