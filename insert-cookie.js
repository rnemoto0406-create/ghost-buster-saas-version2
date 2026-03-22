const { Client } = require('pg');
const fs = require('fs');

const cookies = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
const client = new Client({
  connectionString: 'postgresql://postgres:MGpihafFuuiCXNgpwhJicdYyyclkEWNP@gondola.proxy.rlwy.net:16560/railway'
});

client.connect()
  .then(() => client.query(
    'INSERT INTO burner_accounts (email, session_json) VALUES ($1, $2)',
    ['rnemoto0406@gmail.com', JSON.stringify(cookies)]
  ))
  .then(() => { console.log('✅ 完了'); client.end(); })
  .catch(console.error);