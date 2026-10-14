require('dotenv').config();

const app = require('./app');
const { startWebhookWorker } = require('./services/asaasWebhookService');
startWebhookWorker();
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Secure Digital Checkout disponível em http://localhost:${port}`);
});
