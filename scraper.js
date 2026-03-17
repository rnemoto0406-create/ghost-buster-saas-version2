'use strict';

const { chromium }        = require('playwright');
const { pushToWebhook }   = require('./webhook');
const { buildJobPayload } = require('./scorer');

const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;
const TARGET_URL      = 'https://www.upwork.com/nx/find-work/most-recent';

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

function randomIntervalMs() {
  const min = 4 * 60 * 1000;
  const max = 8 * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── ユーザーの条件と案件がマッチするか判定 ────────────────────────────────
function matchesUser(payload, user) {
  // リスクスコアチェック
  if (payload.risk_score > user.max_risk) return false;

  // 予算下限チェック
  if (user.min_budget && user.min_budget > 0) {
    if (payload.budget_amount < user.min_budget) return false;
  }

  // キーワードチェック（title + description + skills のいずれかに含まれるか）
  if (user.keywords) {
    const keywords = user.keywords.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const searchText = [
      payload.title,
      payload.description,
      payload.skills,
    ].join(' ').toLowerCase();

    const hasKeyword = keywords.some(kw => searchText.includes(kw));
    if (!hasKeyword) return false;
  }

  // カテゴリチェック
  if (user.categories && payload.category) {
    const categories = user.categories.toLowerCase().split(',').map(c => c.trim()).filter(Boolean);
    const jobCategory = payload.category.toLowerCase();
    const hasCategory = categories.some(cat => jobCategory.includes(cat));
    if (!hasCategory) return false;
  }

  return true;
}

async function runScanner({ account, users, redis, pg }) {
  const rawCookies = typeof account.session_json === 'string'
    ? JSON.parse(account.session_json)
    : account.session_json;

  const validCookies = rawCookies.map(cookie => {
    const c = { ...cookie };
    if (c.sameSite === 'no_restriction') c.sameSite = 'None';
    if (c.sameSite === 'unspecified' || !['Strict', 'Lax', 'None'].includes(c.sameSite)) {
      delete c.sameSite;
    }
    return c;
  });

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
    await context.addCookies(validCookies);
    const page = await context.newPage();

    const response = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const currentUrl = page.url();

    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/ab/account-security') ||
      (response && response.status() === 403)
    ) {
      await markBanned(pg, account);
      throw new Error(`BANNED: account ${account.email} redirected to ${currentUrl}`);
    }

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

    const jobs = await page.evaluate(() => {
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

    let newCount  = 0;
    let sentCount = 0;

    for (const job of jobs) {
      if (!job.ciphertext) continue;

      const redisKey = `seen:${job.ciphertext}`;
      const isNew    = await redis.set(redisKey, '1', { NX: true, EX: JOB_TTL_SECONDS });
      if (!isNew) continue;

      newCount++;
      const payload = buildJobPayload(job);

      for (const user of users) {
        if (matchesUser(payload, user)) {
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
    throw err;
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