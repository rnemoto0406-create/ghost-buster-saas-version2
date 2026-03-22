'use strict';

const { parseStringPromise } = require('xml2js');
const { pushToWebhook }      = require('./webhook');
const { buildJobPayload }    = require('./scorer');

const RSS_BASE   = 'https://www.upwork.com/ab/feed/jobs/rss';
const TIMEOUT_MS = 15_000;

function randomIntervalMs() {
  const min = 4 * 60 * 1000;
  const max = 8 * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function fetchRSSJobs(keywords = '') {
  const params = new URLSearchParams({ q: keywords || '', sort: 'recency' });
  const url    = `${RSS_BASE}?${params}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml  = await res.text();
    const data = await parseStringPromise(xml, { explicitArray: false });
    const items = data?.rss?.channel?.item || [];
    return Array.isArray(items) ? items : [items];
  } finally {
    clearTimeout(timer);
  }
}

function extractJobId(item) {
  const link = item.link || '';
  const match = link.match(/jobs\/([^?&\s]+)/);
  return match ? match[1] : null;
}

function extractClientInfo(description) {
  const text = description.replace(/<[^>]+>/g, ' ');
  const paymentVerified = /payment\s+verified/i.test(text);
  const spentMatch      = text.match(/\$([\d,]+(?:\.\d+)?)\s*total\s*spent/i);
  const totalSpent      = spentMatch ? parseFloat(spentMatch[1].replace(/,/g, '')) : 0;
  const hiresMatch      = text.match(/(\d+)\s*hire/i);
  const totalHires      = hiresMatch ? parseInt(hiresMatch[1]) : 0;
  const ratingMatch     = text.match(/([\d.]+)\s*of\s*5/i);
  const totalFeedback   = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
  const reviewMatch     = text.match(/(\d+)\s*review/i);
  const totalReviews    = reviewMatch ? parseInt(reviewMatch[1]) : 0;
  let country = 'Unknown';
  const countryMatch = text.match(/(?:Location|Client Location):\s*([^\n<]+)/i);
  if (countryMatch) country = countryMatch[1].trim();
  return {
    paymentVerificationStatus: paymentVerified ? 2 : 0,
    totalSpent,
    totalHires,
    totalFeedback,
    totalReviews,
    location: { country },
  };
}

function rssItemToJob(item) {
  const title      = item.title || '';
  const rawDesc    = item['content:encoded'] || item.description || '';
  const cleanDesc  = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const link       = item.link || '';
  const jobId      = extractJobId(item);
  const category   = Array.isArray(item.category) ? item.category[0] : (item.category || null);
  const clientInfo = extractClientInfo(rawDesc);

  let budget = null, budgetAmount = 0;
  const hourlyMatch = rawDesc.match(/\$([\d,]+(?:\.\d+)?)\s*[-–]\s*\$([\d,]+(?:\.\d+)?)\s*(?:\/hr|hourly)/i);
  const fixedMatch  = rawDesc.match(/Budget:\s*\$([\d,]+(?:\.\d+)?)/i);
  const anyMatch    = rawDesc.match(/\$([\d,]+(?:\.\d+)?)/);
  if (hourlyMatch) {
    budgetAmount = parseFloat(hourlyMatch[1].replace(/,/g, ''));
    budget = `$${hourlyMatch[1]}–$${hourlyMatch[2]}/hr`;
  } else if (fixedMatch) {
    budgetAmount = parseFloat(fixedMatch[1].replace(/,/g, ''));
    budget = `$${fixedMatch[1]} fixed`;
  } else if (anyMatch) {
    budgetAmount = parseFloat(anyMatch[1].replace(/,/g, ''));
    budget = `$${anyMatch[1]}`;
  }

  const skillsMatch = rawDesc.match(/Skills\s*:\s*([^<\n]+)/i);
  const skills      = skillsMatch ? skillsMatch[1].trim() : '';

  return {
    ciphertext: jobId, title,
    description: cleanDesc.slice(0, 300),
    url: link, budget, budgetAmount, skills, category,
    publishedOn: item.pubDate || null,
    client: clientInfo,
  };
}

function matchesUser(payload, user, fetchedKeywords) {
  if (payload.risk_score > user.max_risk) return false;
  if (user.min_budget && user.min_budget > 0) {
    if ((payload.budget_amount || 0) < user.min_budget) return false;
  }
  if (user.keywords) {
    const userKws    = user.keywords.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const fetchedKws = (fetchedKeywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    const hasMatch   = userKws.some(kw => fetchedKws.some(fk => fk.includes(kw) || kw.includes(fk)));
    if (!hasMatch) return false;
  }
  if (user.categories && payload.category) {
    const cats   = user.categories.toLowerCase().split(',').map(c => c.trim()).filter(Boolean);
    const jobCat = payload.category.toLowerCase();
    if (!cats.some(c => jobCat.includes(c))) return false;
  }
  return true;
}

async function runScanner({ users, redis }) {
  const keywordSets = [...new Set(
    users.map(u => (u.keywords || '').toLowerCase().trim()).filter(Boolean)
  )];
  if (users.some(u => !u.keywords)) keywordSets.unshift('');

  let totalNew = 0, totalSent = 0;

  for (const keywords of keywordSets) {
    console.log(`🔍 Fetching RSS: "${keywords || '(no keyword)'}"`);
    let items;
    try {
      items = await fetchRSSJobs(keywords);
    } catch (err) {
      console.error(`❌ RSS fetch error: ${err.message}`);
      continue;
    }
    console.log(`👀 Got ${items.length} jobs`);

    for (const item of items) {
      const jobId = extractJobId(item);
      if (!jobId) continue;
      const redisKey = `seen:${jobId}`;
      const isNew    = await redis.set(redisKey, '1', { NX: true, EX: 60 * 60 * 24 * 7 });
      if (!isNew) continue;
      totalNew++;
      const job     = rssItemToJob(item);
      const payload = buildJobPayload(job);
      for (const user of users) {
        if (matchesUser(payload, user, keywords)) {
          const result = await pushToWebhook(user.webhook_url, [payload], { totalScanned: items.length });
          if (result.ok) {
            totalSent++;
            console.log(`🎯 Sent "${payload.title.slice(0, 40)}..." → User ${user.id}`);
          } else {
            console.warn(`⚠️ Webhook failed for User ${user.id}:`, result.status || result.error);
          }
        }
      }
    }
  }
  console.log(`✅ Round complete. New: ${totalNew}, Sent: ${totalSent}`);
}

module.exports = { runScanner, randomIntervalMs };
