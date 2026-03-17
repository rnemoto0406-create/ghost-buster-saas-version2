'use strict';

function scoreJob(client = {}) {
  let risk = 0;
  const flags = [];

  if (client.paymentVerificationStatus !== 2) {
    risk += 25;
    flags.push('Payment not verified');
  }
  if (!client.totalSpent || client.totalSpent === 0) {
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

  let budget       = null;
  let budgetAmount = 0;

  if (job.hourlyBudget?.min || job.hourlyBudget?.max) {
    budget       = `$${job.hourlyBudget.min || 0}–$${job.hourlyBudget.max || '?'}/hr`;
    budgetAmount = job.hourlyBudget.min || job.hourlyBudget.max || 0;
  } else if (job.amount?.amount) {
    budget       = `$${job.amount.amount} fixed`;
    budgetAmount = job.amount.amount;
  }

  const skills = (job.skills || [])
    .map((s) => s.prettyName || s.name)
    .filter(Boolean)
    .join(', ');

  const category = job.occupationalCategory
    || job.category2?.name
    || job.subcategory2?.name
    || null;

  const desc = job.description || '';

  return {
    title:         job.title || 'Untitled',
    url:           `https://www.upwork.com/jobs/${job.ciphertext}`,
    description:   desc.length > 300 ? desc.slice(0, 300) + '…' : desc,
    budget,
    budget_amount: budgetAmount,
    skills,
    category,
    posted_date:   job.publishedOn || job.createdOn || null,
    applicants:    job.proposalsTier || null,
    risk_score:    risk,
    risk_flags:    flags,
    client: {
      country:          client.location?.country || 'Unknown',
      total_hires:      client.totalHires      || 0,
      total_spent:      client.totalSpent      || 0,
      total_feedback:   client.totalFeedback   || 0,
      total_reviews:    client.totalReviews    || 0,
      payment_verified: client.paymentVerificationStatus === 2,
    },
  };
}

module.exports = { buildJobPayload, scoreJob };