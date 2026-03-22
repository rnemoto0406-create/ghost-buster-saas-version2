'use strict';

function scoreJob(client = {}) {
  let risk = 0;
  const flags = [];

  if (client.paymentVerificationStatus !== 2) {
    risk += 25;
    flags.push('Payment not verified');
  }
  if (!client.totalSpent?.amount || client.totalSpent.amount === 0) {
    risk += 15;
    flags.push('$0 spent');
  }
  if (!client.totalHires || client.totalHires === 0) {
    risk += 10;
    flags.push('No hires');
  }
  if (client.totalReviews === 0 && client.totalHires > 0) {
    risk += 10;
    flags.push('No reviews despite hires');
  }
  if (client.totalFeedback > 0 && client.totalFeedback < 3.5) {
    risk += 25;
    flags.push(`Low rating: ${client.totalFeedback.toFixed(1)}`);
  }

  return { risk: Math.min(risk, 100), flags };
}

function buildJobPayload(job) {
  const client          = job.client || {};
  const { risk, flags } = scoreJob(client);

  return {
    title:         job.title        || 'Untitled',
    url:           job.url          || `https://www.upwork.com/jobs/${job.ciphertext}`,
    description:   job.description  || '',
    budget:        job.budget       || null,
    budget_amount: job.budgetAmount || 0,
    skills:        job.skills       || '',
    category:      job.category     || null,
    posted_date:   job.publishedOn  || null,
    risk_score:    risk,
    risk_flags:    flags,
    client: {
      country:          client.location?.country  || 'Unknown',
      total_hires:      client.totalHires         || 0,
      total_spent:      client.totalSpent?.amount || 0,
      total_feedback:   client.totalFeedback      || 0,
      total_reviews:    client.totalReviews       || 0,
      payment_verified: client.paymentVerificationStatus === 2,
    },
  };
}

module.exports = { buildJobPayload, scoreJob };
