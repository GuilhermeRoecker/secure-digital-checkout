const { Pool } = require('pg');

const schema = process.env.DB_SCHEMA || 'secure_checkout';

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  throw new Error('DB_SCHEMA deve ser um identificador PostgreSQL simples em letras minúsculas.');
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'meu_banco',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || undefined,
  options: `-c search_path=${schema}`,
  max: 10,
  connectionTimeoutMillis: 5000
});

pool.on('error', (error) => {
  console.error('Erro inesperado no pool PostgreSQL:', error.code || 'UNKNOWN');
});

module.exports = pool;
