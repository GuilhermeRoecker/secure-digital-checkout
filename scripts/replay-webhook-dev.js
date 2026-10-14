// DEV: reproduz APENAS um evento já processado; não simula aprovação nova.
require('dotenv').config();
const pool = require('../src/config/database');

async function main() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Reprodução permitida somente em development.');
  const eventId = process.argv[2];
  if (!eventId || eventId.length > 255 || !/^[a-zA-Z0-9_&-]+$/.test(eventId)) throw new Error('Informe o ID técnico do evento real.');
  const result = await pool.query(
    `SELECT provider_event_id, event_type, checkout_id, checkout_status FROM webhook_events
     WHERE provider='ASAAS' AND provider_event_id=$1 AND status='PROCESSED'`, [eventId]
  );
  if (result.rowCount !== 1) throw new Error('Evento previamente processado não encontrado.');
  if (!process.env.ASAAS_WEBHOOK_TOKEN) throw new Error('Token não configurado.');
  const e = result.rows[0];
  const port = Number(process.env.PORT) || 3000;
  const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/asaas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN },
    body: JSON.stringify({ id: e.provider_event_id, event: e.event_type,
      checkout: { id: e.checkout_id, status: e.checkout_status } })
  });
  const body = await response.json();
  console.info('[DEV REPLAY]', JSON.stringify({ httpStatus: response.status, duplicate: body.duplicate === true }));
  if (response.status !== 200 || body.duplicate !== true) throw new Error('O endpoint não confirmou duplicidade.');
}
main().catch(() => { console.error('[DEV REPLAY] Falha; confira ambiente, ID processado, token e servidor local.'); process.exitCode = 1; })
  .finally(() => pool.end());
