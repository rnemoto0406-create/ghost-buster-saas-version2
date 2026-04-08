'use strict';

function scoreJob(job) {
  let risk = 0;
  const flags = [];

  // UpHuntのデータ構造に対応
  const client     = job.client || {};
  const stats      = client.stats || {};
  const jobDetails = job.jobDetails || {};
  const clientInfo = jobDetails.clientInfo || {};

  // Payment verification
  const paymentVerified = client.paymentMethodVerified === true;
  if (!paymentVerified) {
    risk += 25;
    flags.push('Payment not verified');
  }

  // Total spent
  const totalSpent = stats.totalCharges?.amount || clientInfo.totalSpent || 0;
  if (!totalSpent || totalSpent === 0) {
    risk += 15;
    flags.push('$0 spent');
  }

  // Total hires
  const totalHires = stats.totalJobsWithHires || jobDetails.clientActivity?.totalHires || 0;
  if (!totalHires || totalHires === 0) {
    risk += 10;
    flags.push('No hires');
  }

  // Rating
  const totalFeedback = stats.score || clientInfo.totalFeedback || 0;
  const totalReviews  = stats.feedbackCount || clientInfo.totalReviews || 0;
  if (totalReviews === 0 && totalHires > 0) {
    risk += 10;
    flags.push('No reviews despite hires');
  }
  if (totalFeedback > 0 && totalFeedback < 3.5) {
    risk += 25;
    flags.push(`Low rating: ${totalFeedback.toFixed(1)}`);
  }

  return { risk: Math.min(risk, 100), flags };
}

function buildJobPayload(job) {
  const { risk, flags } = scoreJob(job);

  // Budget
  let budget       = null;
  let budgetAmount = 0;
  const b = job.budget || {};
  if (b.hourlyMin || b.hourlyMax) {
    budget       = `$${b.hourlyMin || 0}–$${b.hourlyMax || '?'}/hr`;
    budgetAmount = b.hourlyMin || b.hourlyMax || 0;
  } else if (b.fixedPrice) {
    budget       = `$${b.fixedPrice} fixed`;
    budgetAmount = b.fixedPrice;
  }

  // Skills
  const skills = (job.skills || [])
    .map(s => s.name || s.prettyName)
    .filter(Boolean)
    .join(', ');

  // URL
  const url = job.jobUrl
    || (job.ciphertext ? `https://www.upwork.com/jobs/${job.ciphertext}` : null)
    || job.url
    || '';

  // Client info
  const client     = job.client || {};
  const stats      = client.stats || {};
  const jobDetails = job.jobDetails || {};
  const clientInfo = jobDetails.clientInfo || {};

  return {
    title:         job.title || 'Untitled',
    url,
    description:   (job.description || '').slice(0, 300),
    budget,
    budget_amount: budgetAmount,
    skills,
    category:      jobDetails.category2 || null,
    posted_date:   job.publishTime || job.createTime || null,
    risk_score:    risk,
    risk_flags:    flags,
    client: {
      country:          client.location?.country || 'Unknown',
      total_hires:      stats.totalJobsWithHires || jobDetails.clientActivity?.totalHires || 0,
      total_spent:      stats.totalCharges?.amount || clientInfo.totalSpent || 0,
      total_feedback:   stats.score || clientInfo.totalFeedback || 0,
      total_reviews:    stats.feedbackCount || clientInfo.totalReviews || 0,
      payment_verified: client.paymentMethodVerified === true,
    },
  };
}

module.exports = { buildJobPayload, scoreJob };