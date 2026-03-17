const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:MGpihafFuuiCXNgpwhJicdYyyclkEWNP@gondola.proxy.rlwy.net:16560/railway'
});

// ── ここを編集してください ────────────────────────────────────────────────
const USER = {
  email:       'ross@example.com',         // メアド
  webhook_url: 'https://...',              // Discord/Slack Webhook URL
  max_risk:    40,                         // リスクスコア上限（0-100）
  min_budget:  0,                          // 予算下限（ドル）例: 50
  keywords:    'python, data entry',       // キーワード（カンマ区切り）例: 'python, scraping'
  categories:  '',                         // カテゴリ（カンマ区切り）例: 'web development, writing'
};
// ─────────────────────────────────────────────────────────────────────────

client.connect()
  .then(() => client.query(
    `INSERT INTO users (email, webhook_url, max_risk, min_budget, keywords, categories, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (email) DO UPDATE SET
       webhook_url = EXCLUDED.webhook_url,
       max_risk    = EXCLUDED.max_risk,
       min_budget  = EXCLUDED.min_budget,
       keywords    = EXCLUDED.keywords,
       categories  = EXCLUDED.categories,
       is_active   = EXCLUDED.is_active`,
    [USER.email, USER.webhook_url, USER.max_risk, USER.min_budget, USER.keywords || null, USER.categories || null]
  ))
  .then(() => {
    console.log('✅ ユーザー登録完了');
    client.end();
  })
  .catch(console.error);