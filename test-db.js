require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect()
  .then(() => {
    console.log("✅ Database Connected Successfully");
    return client.end();
  })
  .catch((err) => {
    console.error("❌ Connection Failed:", err.message);
  });