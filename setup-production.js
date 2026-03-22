const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:MGpihafFuuiCXNgpwhJicdYyyclkEWNP@gondola.proxy.rlwy.net:16560/railway'
});

client.connect()
  // 1. あなたのテスト用Webhookを削除（テスト通知を停止）
  .then(() => client.query("DELETE FROM users WHERE email = 'test@example.com'"))
  // 2. RossのWebhookを、リスクスコア40以下の本番設定で登録
  .then(() => client.query(
    'INSERT INTO users (email, webhook_url, max_risk, is_active) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, max_risk = EXCLUDED.max_risk, is_active = EXCLUDED.is_active',
    ['ross@example.com', 'ここにRossのDiscord/SlackのWebhook URLを貼り付けます', 40, true]
  ))
  .then(() => { 
    console.log('✅ テストのクリーンアップとRossの本番登録が完了しました。'); 
    client.end(); 
  })
  .catch(console.error);