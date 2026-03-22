const { Client } = require('pg');
const fs = require('fs');

const client = new Client({
  connectionString: 'postgresql://postgres:MGpihafFuuiCXNgpwhJicdYyyclkEWNP@gondola.proxy.rlwy.net:16560/railway'
});

async function addAccount() {
  await client.connect();
  const cookies = fs.readFileSync('cookies.json', 'utf8');

  // 新しいアカウントのメールアドレスを指定して登録
  await client.query(
    "INSERT INTO burner_accounts (email, session_json, status) VALUES ($1, $2, 'active')",
    ['nemotaro001@gmail.com', cookies]
  );
  
  console.log('✅ 新しいアカウントを追加しました');
  await client.end();
}

addAccount();