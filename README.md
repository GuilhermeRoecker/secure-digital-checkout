# Secure Digital Checkout

PoC técnica em Node.js/Express, JavaScript puro e PostgreSQL (`pg`, sem ORM), exclusivamente no **Asaas Sandbox**. Gift Card fictício de R$100, sem fornecedor real. Demonstra dois modelos independentes; a entrega depende de webhook autenticado e processamento transacional, nunca do navegador.

## Fluxo A — Hosted Checkout

```text
Browser → POST /api/checkout → pedido local → POST /v3/checkouts
→ Checkout hospedado Asaas (cartão informado lá)
→ CHECKOUT_PAID → webhook durável → worker → CONFIRMED → Gift Card
```

Preservados payload, PNG Base64, callbacks, Axios e diagnóstico sanitizado existentes. `CHECKOUT_CREATED != pagamento confirmado`. As páginas `/checkout/success` e `/checkout/cancel` apenas consultam o backend. O UUID local continua sendo enviado como `externalReference`; o vínculo financeiro é `checkout.id → orders.asaas_checkout_id`.

A integração já havia sido homologada no Sandbox pelo usuário antes da adição do fluxo B. Nesta alteração, sua compatibilidade foi verificada localmente com mock do Asaas e PostgreSQL real; não foi repetido pagamento externo.

## Fluxo B — Direct Payment + 3DS

```text
Browser HTTPS → POST /api/payments/direct → pedido DIRECT_3DS
→ GET /v3/customers?cpfCnpj=... → reutiliza cliente ou POST /v3/customers
→ POST /v3/payments com creditCard, creditCardHolderInfo, threeDSecure e deviceInfo
→ payment.id persistido, entrega BLOQUEADA
→ se houver threeDSecureChallengeUrl: encaminha para o emissor
→ /payments/3ds/callback apenas consulta o pedido
→ PAYMENT_CONFIRMED ou PAYMENT_RECEIVED → webhook → worker
→ CONFIRMED + RELEASED → exatamente um Gift Card
```

| Aspecto | Checkout Asaas | Cartão + 3D Secure |
| --- | --- | --- |
| UX | Cartão na página do Asaas | Cartão nesta aplicação; possível redirecionamento ao emissor |
| API | `/v3/checkouts` | `/v3/payments`, à vista, R$100 |
| Controle | Jornada hospedada | Captura e tratamento pela aplicação |
| 3DS | Não solicitado explicitamente pela PoC neste fluxo | `threeDSecure.callbackUrl` e `deviceInfo` enviados |
| Segurança/PCI | Aplicação não recebe cartão | Aplicação recebe cartão transitoriamente |
| Associação | `asaas_checkout_id` | `asaas_payment_id`, com índice único |
| Entrega | Webhook autenticado de Checkout | Webhook autenticado de Payment |

Na página inicial, escolha **Checkout Asaas** ou **Cartão + 3D Secure**. O segundo abre `/payments/direct`, com dados do comprador/titular, cartão e explicação do 3DS. Nesta PoC comprador e titular devem ser a mesma pessoa. Nenhum cartão é pré-preenchido.

**Sandbox:** segundo o guia oficial 3DS, a autenticação é aprovada automaticamente e o desafio bancário não pode ser reproduzido nesse ambiente. A aplicação trata `threeDSecureChallengeUrl` real quando retornada: exige HTTPS sem credenciais na URL, oferece link e redireciona. Não há challenge falso. URL e seus tokens não são persistidos nem logados.

Não inferimos autenticação bancária ou transferência de responsabilidade a partir de uma tela, callback ou status síncrono. 3DS não elimina chargeback e não garante transferência de responsabilidade em todos os casos.

### PCI DSS e dados sensíveis

**Esta implementação é uma PoC em Sandbox. O pagamento direto faz nossa aplicação participar do fluxo de dados de cartão e pode ampliar o escopo PCI DSS. Antes de produção, a estratégia de captura/tokenização deve ser validada formalmente com o Asaas e com os requisitos PCI DSS aplicáveis. Esta PoC não é declarada automaticamente PCI compliant.**

PAN, validade, nome do cartão e CVV são usados apenas durante o envio. Não são gravados no PostgreSQL, timeline, eventos de webhook, arquivos, logs, cookies ou storage do navegador. Campos de cartão são limpos antes de aguardar a resposta e ao sair/retornar à página. JavaScript não garante zeroização física de memória. Configure também qualquer proxy/APM externo para não capturar corpos dessas requisições; esta PoC não configura ferramentas externas.

Respostas da API são listas explícitas de campos: UUID, estado local, acompanhamento e eventual URL de desafio. Erros diretos nunca propagam objetos Axios, stack, config, descrições arbitrárias ou payload do provedor. Erros de parse JSON também são genéricos, pois a mensagem do parser pode conter trechos do cartão.

## Estrutura e responsabilidades

- `src/services/asaasService.js`, `orderService.js`, `checkoutController.js`: fluxo hospedado preservado.
- `src/services/directPaymentService.js`, `directPaymentController.js`, `directPaymentRoutes.js`: cliente, pagamento direto, resposta sanitizada.
- `src/middleware/directPaymentSecurity.js`: HTTPS, origem do IP e rate limiting exclusivo do novo endpoint.
- `src/middleware/asaasWebhookAuth.js`, `webhookController.js`, `webhookRoutes.js`: autenticação e recebimento durável compartilhados.
- `src/services/asaasWebhookService.js`: normalização técnica, mapeamento de eventos e worker.
- `src/repositories/orderRepository.js`: persistência parametrizada, locks e entrega comum aos dois fluxos.
- `src/server.js`: inicia Express e worker; `src/app.js`: rotas e páginas.
- `src/public/`: páginas, CSS e JavaScript puros, sem frameworks.
- `database/`: schema final e migrations incrementais.
- `tests/`: integração com PostgreSQL isolado e mock Asaas; teste do JS do frontend.
- `scripts/replay-webhook-dev.js`: reprodução local de evento real já processado.

## Instalação e PostgreSQL

Node.js 18+, PostgreSQL e dependências do `package.json`:

```bash
npm install
test -f .env || cp .env.example .env
```

Não sobrescreva `.env` existente. Nunca versione chaves, senhas ou cartão.

**Database: `meu_banco`. Schema: `secure_checkout`.** `DB_SCHEMA` determina o `search_path`, com validação de identificador. O DDL usa o schema explicitamente; mantenha `DB_SCHEMA=secure_checkout`. Queries usam parâmetros `$1`, `$2`, etc. Não há ORM ou exclusão de dados na inicialização.

### Banco existente já atualizado até 002

Execute **somente a nova migration 003** antes de reiniciar Node:

```bash
psql -h localhost -p 5432 -U postgres -d meu_banco -v ON_ERROR_STOP=1 -1 -f database/migrations/003_direct_3ds.sql
```

Ela adiciona `orders.payment_flow` (padrão `HOSTED_CHECKOUT` para preservar pedidos antigos), `asaas_payment_id` com índice único e `asaas_customer_id`. Em `webhook_events`, adiciona `payment_status`, `billing_type` e `provider_created_at`. Sem `DROP`, sem apagar pedidos/eventos, reaplicável.

Se a instalação ainda não tiver 001/002, aplique antes:

```bash
psql -h localhost -p 5432 -U postgres -d meu_banco -v ON_ERROR_STOP=1 -1 -f database/migrations/001_webhook_delivery.sql
psql -h localhost -p 5432 -U postgres -d meu_banco -v ON_ERROR_STOP=1 -1 -f database/migrations/002_webhook_worker.sql
```

Instalação nova, com `meu_banco` já criado:

```bash
psql -h localhost -p 5432 -U postgres -d meu_banco -v ON_ERROR_STOP=1 -1 -f database/schema.sql
```

### Variáveis de ambiente

Mantenha `ASAAS_API_KEY`, `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`, `APP_BASE_URL`, `PORT` e todas as `DB_*` existentes. O código continua restrito ao Sandbox.

- `ASAAS_API_KEY`: autentica chamadas de saída com header `access_token`.
- `ASAAS_WEBHOOK_TOKEN`: segredo independente, 32–255 caracteres sem espaços; autentica entrada por `asaas-access-token`, comparação `timingSafeEqual`.
- **Nova:** `DIRECT_PAYMENT_TRUST_CLOUDFLARE=false` por padrão. Configure `true` somente quando `cloudflared` roda no mesmo host e acessa Node por loopback. Nesse cenário o backend aceita `CF-Connecting-IP` e `X-Forwarded-Proto` desse peer local para obter IP do pagador e verificar HTTPS. Headers enviados por conexão remota não são confiados. Não foi habilitado `trust proxy` global.

Use `APP_BASE_URL` HTTPS público do **Cloudflare Tunnel existente**. Não foi removido ou substituído o túnel. O fluxo direto exige acesso pela URL HTTPS pública; HTTP local é recusado, exceto nos testes com `NODE_ENV=test`. Não use `NODE_ENV=test` no servidor acessível pelo túnel. Se o túnel roda em outro host/container ou não fornece esses headers, valide e ajuste a topologia antes de habilitar pagamento direto; não envie IP fictício ou IP do servidor como se fosse o pagador.

### Limite de tentativas

Somente `POST /api/payments/direct`: cinco requisições por IP em dez minutos, com teto global de 30 no mesmo período, incluindo entradas inválidas. Responde `429` com `Retry-After`. Janela em memória, adequada à PoC de processo único; reiniciar Node zera os contadores. Webhook, Checkout hospedado, callbacks e consultas não recebem esse limite. Produção com múltiplas instâncias exige armazenamento compartilhado e controles adicionais.

## Cliente, tentativa e resultado incerto

Cliente Asaas: busca documentada por CPF/CNPJ, conferência exata do documento retornado, reutilização de ID ou criação com notificações desabilitadas. Buscas/criações simultâneas do mesmo documento compartilham a operação em andamento no processo Node. Isso reduz duplicações no desenvolvimento; não constitui unicidade distribuída entre instâncias. CPF não associa webhook a pedido.

O frontend gera um UUID de tentativa em memória. O pedido usa esse UUID e `ON CONFLICT` impede criar duas cobranças para a mesma tentativa, mesmo com requests concorrentes. O UUID também é enviado como `externalReference`. A resposta do Asaas vincula explicitamente `payment.id` ao pedido; webhooks usam **apenas o ID técnico persistido e o fluxo correspondente**.

O timeout de criação de pagamento é 65 segundos, respeitando a orientação oficial de pelo menos 60 segundos. Não há retry automático de `POST /payments`. Timeout/erro inconclusivo mantém o pedido em análise e orienta consultar o acompanhamento antes de tentar novamente. Se o provedor criou a cobrança mas a resposta com ID se perdeu, o webhook fica durável pendente sem entregar: é necessário reconciliar no Sandbox e validar/persistir o ID técnico mediante revisão. Não há reconciliação automática por dados pessoais ou apenas `externalReference`. Uma nova página gera outro UUID: não abra outra tentativa enquanto houver resultado incerto.

Uma resposta `400` do processamento direto é registrada como `REFUSED`, com categoria genérica `PAYMENT_REJECTED_OR_INVALID`; a referência informa que a cobrança não é persistida se não autorizada. A resposta não distingue sempre cartão recusado de dado inválido, portanto não se inventa diagnóstico. Cliente inválido, configuração, resposta inválida e indisponibilidade recebem categorias locais genéricas. Falha 3DS financeira definitiva vem do webhook.

## Webhook, worker e entrega

Endpoint único: **`POST APP_BASE_URL/api/webhooks/asaas`**.

```text
autenticar → validar id/event → extrair campos técnicos → INSERT + COMMIT → HTTP 200
→ worker: evento FOR UPDATE SKIP LOCKED → pedido FOR UPDATE
→ transição + timeline + entrega + evento PROCESSED → COMMIT
```

Persistidos: evento, tipo, IDs, estados, billing type, horário técnico e timestamps locais. Payload bruto, cartão e tokens do webhook são descartados. `provider_created_at` registra o horário textual do Asaas, sem presumir timezone não documentado; não é usado como ordem financeira.

Worker inicia com `src/server.js`, verifica até 20 eventos a cada dois segundos. Falha reverte a transação; pendência `RECEIVED` é retomada após 30 segundos e sobrevive a reinício. Webhook pode chegar antes de salvar o ID do pagamento: permanece pendente até o vínculo existir. Eventos sem pedido local, inclusive cobranças alheias à PoC, podem permanecer pendentes; monitore e investigue.

`UNIQUE(provider, provider_event_id)` evita evento repetido. Locks do pedido e `UNIQUE(order_id)` na entrega garantem um Gift Card por pedido, mesmo com IDs distintos confirmando a mesma cobrança. A confirmação e a entrega são a mesma regra de negócio para os dois fluxos. Código fictício gerado com `crypto.randomBytes`, nunca `Math.random`.

Código só é selecionado/devolvido com `order.status=CONFIRMED` **e** `delivery.status=RELEASED`. API de pedidos e admin usam `Cache-Control: no-store`. Um estorno bloqueia a consulta futura, mas não desfaz consumo ou visualização anterior do código.

### Eventos de Checkout — fluxo A preservado

| Evento | Estado esperado no payload | Estado local | Entrega |
| --- | --- | --- | --- |
| `CHECKOUT_CREATED` | `ACTIVE` | `PENDING` | Bloqueada |
| `CHECKOUT_PAID` | `PAID` | `CONFIRMED` | Liberada |
| `CHECKOUT_CANCELED` | `CANCELED` | `CANCELED` | Bloqueada |
| `CHECKOUT_EXPIRED` | `EXPIRED` | `EXPIRED` | Bloqueada |

Evento tardio de criação/cancelamento/expiração não regride confirmado. Pagamento confirmado pode superar cancelamento/expiração prévios neste fluxo, como já ocorria.

### Eventos de cobrança — apenas fluxo B com asaas_payment_id

| Evento oficial | Tratamento local | Entrega |
| --- | --- | --- |
| `PAYMENT_CREATED` | Pendente; nunca confirma, mesmo se snapshot disser CONFIRMED | Bloqueada |
| `PAYMENT_AWAITING_RISK_ANALYSIS` | `UNDER_REVIEW` | Bloqueada |
| `PAYMENT_CONFIRMED` + status `CONFIRMED` | `CONFIRMED`, captura aprovada | Libera |
| `PAYMENT_RECEIVED` + status `RECEIVED` | `CONFIRMED`, valor recebido | Libera |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` | `REFUSED`, `PAYMENT_REFUSED` | Bloqueia |
| `PAYMENT_REPROVED_BY_RISK_ANALYSIS` | `REFUSED` | Bloqueia |
| `PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED` | `REFUSED`, `THREE_DS_CHALLENGE_FAILED` | Bloqueia |
| `PAYMENT_DELETED` | `CANCELED` | Bloqueia |
| `PAYMENT_REFUND_IN_PROGRESS` / `PAYMENT_REFUNDED` / `PAYMENT_PARTIALLY_REFUNDED` | `CANCELED`, timeline do evento | Bloqueia |
| `PAYMENT_CHARGEBACK_REQUESTED` | `CANCELED` | Bloqueia |
| Demais, incluindo `PAYMENT_AUTHORIZED`, aprovação isolada de risco e `PAYMENT_UPDATED` | `IGNORED`, sem transição | Não libera |

A falha 3DS consta explicitamente do **guia 3DS**, embora a tabela geral de eventos para cobranças consultada não a enumere. Foi usada a definição específica do fluxo. Validar sua disponibilidade no cadastro de Webhooks da conta. Não foi criado evento inexistente `PAYMENT_REFUSED` do Asaas; esse é apenas um nome de timeline local.

Política conservadora do direto: `PENDING → UNDER_REVIEW → CONFIRMED`, sem regressão por evento antigo de criação/análise. Recusa, falha 3DS e cancelamento/estorno são bloqueios terminais para a entrega desta tentativa. Confirmação tardia não os desfaz. Isso pode bloquear uma cobrança válida em eventos contraditórios e exige revisão manual, preferindo não entregar indevidamente. Estados de challenge ficam na timeline, não criam novos estados permanentes de pedido.

Notificações autenticadas desconhecidas ou incompatíveis são persistidas, recebem `200` e ficam `IGNORED`. Token inválido retorna `401`; configuração ausente, `503`. A documentação difere entre páginas sobre aceitação de outros `2xx`; usamos sempre `200` após persistir. Após 15 falhas consecutivas a fila Asaas pode parar; corrija a causa e reative no painel. Depois do nosso `200`, recuperar pendências é responsabilidade do worker local.

## Homologação manual no Sandbox

### Preparação comum

1. Aplique migration 003 (e anteriores se necessário). Preserve o `.env`, chave Sandbox, `DB_NAME=meu_banco`, `DB_SCHEMA=secure_checkout`, URL HTTPS e token.
2. Configure `DIRECT_PAYMENT_TRUST_CLOUDFLARE=true` somente para a topologia local descrita acima.
3. Inicie Node: `npm run dev` ou `npm start`.
4. Inicie **o Cloudflare Tunnel existente** usando seu comando habitual, por exemplo `cloudflared tunnel run NOME_DO_TUNEL`. Abra `APP_BASE_URL` e confirme HTTPS.
5. No Sandbox, **Menu do usuário → Integrações → Webhooks**, edite a configuração existente. Mantenha URL `APP_BASE_URL/api/webhooks/asaas`, v3, habilitado, fila não interrompida, envio `SEQUENTIALLY` e Auth Token igual a `ASAAS_WEBHOOK_TOKEN`. Preserve os quatro eventos Checkout e acrescente os eventos Payment da tabela acima que a conta permitir selecionar. Não remova eventos do fluxo A.

### Fluxo A — Checkout hospedado

1. Na página inicial, escolha **Checkout Asaas**.
2. Preencha dados fictícios e crie pedido de R$100.
3. Abra o Checkout hospedado e informe cartão **somente na página Asaas**.
4. Use apenas [dados de teste oficiais do Asaas](https://docs.asaas.com/docs/testando-pagamento-com-cart%C3%A3o-de-cr%C3%A9dito). Não utilize cartão real.
5. Pague; observe `CHECKOUT_PAID`, recebimento `200`, worker `PROCESSED`, pedido confirmado e entrega liberada. Callbacks não aprovam pagamento.

### Fluxo B — Cartão + 3D Secure

1. Com Node e túnel iniciados, abra a aplicação pela **URL HTTPS pública**.
2. Escolha **Cartão + 3D Secure**.
3. Preencha comprador/titular e endereço fictícios. Consulte o guia oficial de dados de teste; não há cartão real ou pré-preenchido no código da interface.
4. Preencha cartão fictício, validade e código conforme a documentação oficial. Envie uma vez e aguarde: o request pode demorar mais de um minuto.
5. A aplicação informa envio 3DS e aguarda webhook. A resposta sanitizada contém UUID, estado local e acompanhamento. **Não exporte request bodies/HAR ou screenshots com cartão/CVV** para conferir o resultado.
6. No Sandbox, não se espera challenge bancário real: a autenticação é automática. Se um ambiente suportado retornar URL, o código encaminha ao emissor; o callback continua sem confirmar pagamento.
7. Em **Integrações → Logs de Webhooks**, confira ID técnico, `payment.id`, evento `PAYMENT_CONFIRMED` ou `PAYMENT_RECEIVED` e HTTP `200`. Evite copiar o payload completo, que pode conter dados desnecessários.
8. No terminal, espere `[Pagamento direto]` com `orderPublicId`, `paymentId`, `result: SUBMITTED`; depois `[Webhook Asaas]` com `RECEIVED` e `PROCESSED`. Duplicados mostram `DUPLICATE`; falhas locais mostram `RETRY`. Nunca são impressos cartão, CVV, token ou URL de challenge.
9. Abra `/order/UUID`. Confirme pagamento **Confirmado**, 3DS solicitado ao Sandbox, entrega **Liberada** e código. O acompanhamento atualiza a cada cinco segundos.
10. Em `/admin/orders`, confira o fluxo, status e timeline. Não deve aparecer cartão, token, dados pessoais completos ou código.
11. Execute as queries abaixo: uma entrega, um `PAYMENT_CONFIRMED` e um `DELIVERY_RELEASED` por pedido.
12. Reenvie o mesmo evento real pelo painel, se essa função estiver disponível. Confirme ID/código/horário de liberação e contagens inalterados. Se não houver função de reenvio, use o script DEV abaixo para reproduzir um evento já processado.
13. Retorne manualmente ao callback e recarregue: não pode criar confirmação ou entrega.

Falha/abandono real do desafio não é reproduzível normalmente no Sandbox. Recusa de captura com 3DS também pode ser afetada pela aprovação automática. Esses cenários são cobertos **somente com mocks locais** nesta entrega; registre como não homologados externamente quando a conta não permitir provocá-los. Nunca fabrique challenge ou evento como se viesse do banco.

### Queries úteis (psql)

```sql
\set pedido 'UUID_PUBLICO_DO_PEDIDO'
SELECT public_id, payment_flow, status, asaas_checkout_id, asaas_payment_id, updated_at
FROM secure_checkout.orders WHERE public_id=:'pedido'::uuid;

SELECT e.event_type, e.description, e.created_at
FROM secure_checkout.order_events e JOIN secure_checkout.orders o ON o.id=e.order_id
WHERE o.public_id=:'pedido'::uuid ORDER BY e.created_at,e.id;

SELECT w.provider_event_id,w.event_type,w.payment_id,w.checkout_id,w.payment_status,
       w.status,w.received_at,w.processed_at,w.next_attempt_at
FROM secure_checkout.webhook_events w LEFT JOIN secure_checkout.orders o ON o.id=w.order_id
WHERE o.public_id=:'pedido'::uuid
   OR w.payment_id=(SELECT asaas_payment_id FROM secure_checkout.orders WHERE public_id=:'pedido'::uuid)
ORDER BY w.id;

-- Conferir entrega sem expor o código no resultado SQL compartilhado.
SELECT d.id,d.status,d.created_at,d.released_at
FROM secure_checkout.digital_deliveries d JOIN secure_checkout.orders o ON o.id=d.order_id
WHERE o.public_id=:'pedido'::uuid;

SELECT COUNT(*) AS entregas FROM secure_checkout.digital_deliveries d
JOIN secure_checkout.orders o ON o.id=d.order_id WHERE o.public_id=:'pedido'::uuid;
SELECT e.event_type,COUNT(*) FROM secure_checkout.order_events e
JOIN secure_checkout.orders o ON o.id=e.order_id
WHERE o.public_id=:'pedido'::uuid AND e.event_type IN ('PAYMENT_CONFIRMED','DELIVERY_RELEASED')
GROUP BY e.event_type;

SELECT provider_event_id,event_type,payment_id,checkout_id,status,next_attempt_at
FROM secure_checkout.webhook_events WHERE status IN ('RECEIVED','IGNORED') ORDER BY id;
```

### Reproduzir evento processado sem nova cobrança

```bash
NODE_ENV=development node scripts/replay-webhook-dev.js ID_REAL_DO_EVENTO
```

O script aceita somente evento real já `PROCESSED`, envia para localhost usando autenticação real, não cria rota MOCK e não simula uma nova aprovação. A resposta deve indicar `duplicate: true`. Não representa nova entrega originada pelo Asaas. Compare contagens antes/depois.

## Testes locais — DEV/MOCK

Sem `.env`, credenciais reais ou acesso ao Asaas. Use PostgreSQL **isolado**, database `secure_checkout_test` e porta livre. Nunca `meu_banco`:

```bash
initdb -D /tmp/secure-checkout-pg -A trust --no-locale
pg_ctl -D /tmp/secure-checkout-pg -l /tmp/secure-checkout-pg.log -o '-h 127.0.0.1 -p 55439 -k /tmp' start
createdb -h 127.0.0.1 -p 55439 secure_checkout_test
DB_HOST=127.0.0.1 DB_PORT=55439 DB_NAME=secure_checkout_test DB_USER="$(id -un)" npm run test:integration
pg_ctl -D /tmp/secure-checkout-pg stop
```

Resultado da validação local desta alteração: **22 testes passaram**, usando PostgreSQL isolado e mocks; nenhuma chamada externa ao Asaas foi executada. Todos os arquivos JavaScript passaram por `node --check`.

Preservada suíte anterior de webhook/Checkout. Novos testes usam mock do adapter Axios apenas no processo de testes. Cobrem payload 3DS, cliente, ausência de entrega síncrona, callbacks, duplicidade, concorrência, ordem, recusas, falha 3DS, estorno após entrega, URL de challenge, timeout, proteção de JSON inválido, rate limiting, segredo inválido, persistência/logs/respostas sanitizados e Checkout hospedado ainda funcional. Teste do JavaScript do frontend verifica limpeza de cartão e redirecionamento real do código para URL mock HTTPS. Mocks não são homologação externa nem desafio bancário real.

## Limitações para revisão

- Pagamento externo, cadastro de eventos, túnel e comportamento real da conta ainda precisam ser homologados manualmente nesta alteração. Não foram usadas credenciais reais nesta execução.
- Challenge real e respectivas falhas não são reproduzidos no Sandbox; produção exige habilitação/validação formal com Asaas.
- A resposta completa das APIs pode conter token de cartão: é descartada, sem persistir ou repassar. Não foi implementada tokenização reutilizável.
- Sem reconciliação automática de timeout com ID perdido; entrega permanece bloqueada até investigação.
- Política terminal conservadora pode exigir revisão em eventos contraditórios. Reembolso/chargeback não recupera um produto já consumido.
- Admin segue sem autenticação. Oculta nomes e não devolve código, mas lista UUIDs que permitem abrir a página pública do pedido. Controle de acesso ao comprador continua necessário antes de uso real.
- Não há broker ou painel de alertas; monitore pendências antigas. Rate limiter e compartilhamento de criação de cliente são locais ao processo.
- Escopo atual: cobrança direta à vista de R$100; endpoints lean, parcelamento e pagamento de cobrança existente foram consultados como referência, mas não implementados como fluxos adicionais.

## Fontes oficiais

- [Criar cobrança com 3DS](https://docs.asaas.com/docs/criar-cobran%C3%A7a-com-3ds)
- [Criar cobrança com cartão](https://docs.asaas.com/reference/criar-cobranca-com-cartao-de-credito)
- [Resposta resumida](https://docs.asaas.com/reference/criar-cobranca-com-cartao-de-credito-com-dados-resumidos-na-resposta)
- [Parcelamento](https://docs.asaas.com/reference/criar-parcelamento-com-cart%C3%A3o-de-cr%C3%A9dito)
- [Pagar cobrança existente](https://docs.asaas.com/reference/pagar-uma-cobranca-com-cartao-de-credito)
- [Eventos de cobrança](https://docs.asaas.com/docs/webhook-para-cobrancas)
- [Eventos de Checkout](https://docs.asaas.com/docs/checkout-events)
- [Clientes: listar](https://docs.asaas.com/reference/listar-clientes) e [criar](https://docs.asaas.com/reference/criar-novo-cliente)
- [Autenticação e recebimento](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint)
- [Idempotência](https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks)
