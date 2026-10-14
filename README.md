# Secure Digital Checkout

Prova de conceito de uma aplicação de venda de **Gift Card Digital fictício**, integrada ao **Asaas Sandbox**.

O projeto foi desenvolvido para explorar dois modelos de integração de pagamentos com cartão:

- **Checkout hospedado pelo Asaas**
- **Pagamento direto com suporte a 3D Secure (3DS)**

Além da integração com o gateway, a aplicação demonstra um fluxo completo de pedidos, persistência em PostgreSQL, processamento de webhooks, idempotência e liberação controlada de um produto digital após confirmação financeira.

> Este projeto utiliza exclusivamente o ambiente Sandbox do Asaas e não realiza transações financeiras reais.

---

## Objetivo

A aplicação simula a venda de um Gift Card Digital de **R$ 100,00**.

O objetivo principal é demonstrar como uma aplicação pode integrar pagamentos com o Asaas sem utilizar a resposta inicial da API ou o retorno do navegador como autorização para entregar o produto.

A liberação do Gift Card ocorre somente após o backend receber e processar uma confirmação financeira válida através dos webhooks do Asaas.

Durante o desenvolvimento foram implementados dois fluxos distintos para comparar suas características e responsabilidades de segurança.

---

## Funcionalidades

- Criação e acompanhamento de pedidos.
- Checkout hospedado pelo Asaas.
- Pagamento direto com cartão e suporte ao fluxo 3D Secure.
- Integração com Asaas Sandbox.
- Associação entre pedidos e identificadores financeiros do Asaas.
- Webhooks autenticados.
- Persistência durável dos eventos recebidos.
- Processamento assíncrono através de worker.
- Histórico de eventos do pedido.
- Liberação transacional do Gift Card.
- Proteção contra processamento duplicado.
- Tratamento de eventos recebidos fora de ordem.
- Tratamento de pagamentos recusados.
- Tratamento de cancelamentos, estornos e chargebacks.
- Rate limiting no endpoint de pagamento direto.
- Página de acompanhamento do pedido.
- Painel administrativo para demonstração.
- Testes automatizados dos principais fluxos.

---

# Fluxos de pagamento

## 1. Checkout hospedado

O primeiro modelo utiliza:

`POST /v3/checkouts`

Nesse fluxo, a aplicação cria o pedido e solicita ao Asaas a criação de um Checkout.

O comprador é então encaminhado para a página hospedada pelo próprio Asaas, onde informa os dados do cartão.

```text
Cliente
   │
   ▼
Aplicação
   │
   │ POST /v3/checkouts
   ▼
Asaas Checkout
   │
   │ Pagamento
   ▼
Asaas
   │
   │ Webhook
   ▼
Aplicação
   │
   ▼
Gift Card
```

Uma característica importante desse modelo é que **os dados do cartão não são informados diretamente à aplicação**.

A captura acontece no ambiente hospedado pelo Asaas.

O Gift Card somente é liberado quando um evento financeiro compatível é recebido e processado pelo backend.

No fluxo implementado, `CHECKOUT_PAID` com status `PAID` permite a confirmação do pedido.

---

## 2. Pagamento direto + 3D Secure

O segundo modelo utiliza a API de pagamentos:

`POST /v3/payments`

O suporte explícito ao fluxo 3D Secure foi implementado através dessa integração.

Nesse modelo, a aplicação envia ao Asaas os dados necessários para realizar a cobrança, juntamente com as informações de dispositivo e parâmetros necessários ao 3DS.

```text
Cliente
   │
   ▼
Aplicação
   │
   │ Cartão + 3DS + Device Info
   ▼
Asaas Payments API
   │
   ├── Autenticação 3DS, quando necessária
   │
   ▼
Processamento do pagamento
   │
   │ Webhook
   ▼
Aplicação
   │
   ▼
Gift Card
```

Caso o Asaas retorne uma `threeDSecureChallengeUrl` HTTPS válida, a aplicação está preparada para encaminhar o comprador para o processo de autenticação do emissor.

No ambiente Sandbox, o challenge bancário real normalmente não é reproduzido. O tratamento desse redirecionamento é validado através dos testes automatizados.

No fluxo direto, a confirmação do pedido pode ocorrer através de:

- `PAYMENT_CONFIRMED` com status `CONFIRMED`;
- `PAYMENT_RECEIVED` com status `RECEIVED`.

Uma tentativa de pagamento, uma resposta inicial da API ou o retorno do callback 3DS **não são suficientes para liberar o produto**.

---

## Comparação dos fluxos

| Característica | Checkout hospedado | Pagamento direto + 3DS |
| --- | --- | --- |
| API principal | `/v3/checkouts` | `/v3/payments` |
| Página de pagamento | Asaas | Aplicação |
| Cartão informado à aplicação | Não | Sim |
| Identificador financeiro | `asaas_checkout_id` | `asaas_payment_id` |
| Confirmação | Webhook de Checkout | Webhook de Payment |
| Controle da experiência | Menor | Maior |
| Exposição a dados de cartão | Menor | Maior |
| Integração explícita com 3DS | Não implementada neste fluxo | Sim |

O Checkout hospedado reduz a exposição da aplicação aos dados sensíveis do cartão.

Já o pagamento direto oferece maior controle sobre o processo e permite implementar explicitamente o fluxo 3DS, porém aumenta as responsabilidades de segurança da aplicação.

---

# Confirmação e entrega

A aplicação separa três conceitos:

```text
Tentativa de pagamento
        │
        ▼
Processamento financeiro
        │
        ▼
Confirmação financeira
        │
        ▼
Entrega do produto
```

Criar um Checkout ou uma cobrança **não significa que o produto foi pago**.

Da mesma forma, retornar para uma URL de sucesso ou callback não autoriza a entrega.

O fluxo utilizado pela aplicação é:

```text
Comprador
    │
    ▼
Interface
    │
    ▼
Backend Express
    │
    ├────────────► PostgreSQL
    │
    ▼
Asaas Sandbox
    │
    ▼
Webhook
    │
    ▼
Evento persistido
    │
    ▼
Worker
    │
    ▼
Regra financeira
    │
    ├── Confirmado ──► Gift Card liberado
    │
    └── Não confirmado ──► Entrega bloqueada
```

Essa separação é especialmente importante para produtos digitais, pois impede que uma simples tentativa de pagamento resulte na entrega imediata do produto.

---

# Webhooks

A aplicação utiliza um único endpoint para receber os eventos do Asaas:

```text
POST /api/webhooks/asaas
```

O endpoint:

1. autentica a requisição;
2. identifica o evento recebido;
3. persiste o evento no PostgreSQL;
4. responde ao provedor;
5. deixa o processamento da regra financeira para o worker.

Essa abordagem separa o recebimento do webhook do processamento do pedido.

---

## Idempotência

Provedores de pagamento podem reenviar notificações.

Por isso, os eventos recebidos possuem controle de unicidade.

Se o mesmo evento for enviado mais de uma vez:

```text
PAYMENT_CONFIRMED
PAYMENT_CONFIRMED
PAYMENT_CONFIRMED
```

a aplicação continua produzindo:

```text
1 pedido
1 confirmação
1 entrega
1 Gift Card
```

A entrega digital também possui uma restrição de unicidade por pedido.

---

## Eventos fora de ordem

A aplicação não assume que os eventos serão recebidos exatamente na ordem em que ocorreram.

As transições de estado são protegidas para evitar que eventos antigos regressem um pedido que já atingiu um estado financeiro mais avançado.

Por exemplo, um evento de criação recebido após uma confirmação não transforma novamente um pedido confirmado em pendente.

---

# Banco de dados

O projeto utiliza PostgreSQL sem ORM.

As principais estruturas são:

### `orders`

Representa o estado atual do pedido.

Também armazena os identificadores técnicos utilizados para associar o pedido aos recursos criados no Asaas.

---

### `webhook_events`

Funciona como armazenamento durável dos eventos recebidos pelo webhook.

Permite controlar:

- eventos recebidos;
- processamento;
- tentativas;
- erros;
- duplicidade.

---

### `order_events`

Mantém o histórico das alterações relevantes do pedido.

É utilizado para apresentar a timeline da compra.

---

### `digital_deliveries`

Representa a entrega do produto digital.

Existe uma única entrega por pedido.

O código somente pode ser retornado quando o pedido estiver confirmado e a entrega estiver liberada.

---

# Tecnologias

### Backend

- Node.js 18+
- Express
- Axios
- Helmet
- dotenv

### Banco de dados

- PostgreSQL
- `pg`
- SQL parametrizado
- Sem ORM

### Frontend

- HTML
- CSS
- JavaScript

### Testes

- `node:test`
- PostgreSQL isolado para integração
- Mocks da API do Asaas

---

# Estrutura do projeto

```text
src/
├── app.js
├── server.js
│
├── config/
│   ├── Configuração do PostgreSQL
│   └── Configuração do Asaas
│
├── controllers/
│   └── Validação e respostas HTTP
│
├── middleware/
│   └── Segurança, webhook e rate limiting
│
├── routes/
│   └── Rotas HTTP
│
├── services/
│   └── Integração Asaas e regras de negócio
│
├── repositories/
│   └── Persistência e transações
│
└── public/
    ├── HTML
    ├── CSS
    └── JavaScript

database/
├── schema.sql
└── migrations/

scripts/
└── replay-webhook-dev.js

tests/
└── Testes de integração e frontend
```

---

# Executando o projeto

## Requisitos

Para executar a aplicação é necessário:

- Node.js 18 ou superior;
- npm;
- PostgreSQL;
- conta no Asaas Sandbox;
- chave de API do Asaas Sandbox;
- URL pública HTTPS para callbacks e webhooks.

Para desenvolvimento local, a URL pública pode ser disponibilizada utilizando a solução de túnel ou reverse proxy de sua preferência.

---

## Instalação

Clone o repositório:

```bash
git clone <URL_DO_REPOSITORIO>
cd secure-digital-checkout
```

Instale as dependências:

```bash
npm install
```

Crie o arquivo de configuração:

```bash
cp .env.example .env
```

---

# Configuração

Configure o `.env` de acordo com seu ambiente.

As principais variáveis são:

| Variável | Descrição |
| --- | --- |
| `ASAAS_API_KEY` | Chave da API do Asaas Sandbox |
| `ASAAS_BASE_URL` | URL base da API Sandbox |
| `ASAAS_WEBHOOK_TOKEN` | Token utilizado para autenticar webhooks |
| `APP_BASE_URL` | URL pública HTTPS da aplicação |
| `PORT` | Porta utilizada pelo servidor |
| `DB_HOST` | Host do PostgreSQL |
| `DB_PORT` | Porta do PostgreSQL |
| `DB_NAME` | Banco utilizado pela aplicação |
| `DB_USER` | Usuário do PostgreSQL |
| `DB_PASSWORD` | Senha do PostgreSQL |
| `DB_SCHEMA` | Schema utilizado pela aplicação |

Exemplo:

```env
PORT=3000

ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3
ASAAS_API_KEY=
ASAAS_WEBHOOK_TOKEN=

APP_BASE_URL=https://seu-dominio-de-desenvolvimento.example

DB_HOST=localhost
DB_PORT=5432
DB_NAME=secure_checkout
DB_USER=postgres
DB_PASSWORD=
DB_SCHEMA=secure_checkout
```

> Nunca versione o arquivo `.env`.

A chave da API e o token do webhook possuem funções diferentes.

A chave autentica as chamadas realizadas **pela aplicação para o Asaas**.

O token do webhook autentica as notificações enviadas **pelo Asaas para a aplicação**.

---

# Preparando o banco

Crie um banco PostgreSQL para a aplicação.

Depois execute:

```bash
psql \
  -h <DB_HOST> \
  -p <DB_PORT> \
  -U <DB_USER> \
  -d <DB_NAME> \
  -v ON_ERROR_STOP=1 \
  -1 \
  -f database/schema.sql
```

O arquivo:

```text
database/schema.sql
```

contém a estrutura completa necessária para uma instalação nova.

A pasta:

```text
database/migrations/
```

contém as alterações incrementais utilizadas durante a evolução do projeto e pode ser utilizada para atualizar instalações existentes.

Não é necessário executar todas as migrations após aplicar o `schema.sql` em uma instalação nova.

---

# Iniciando a aplicação

Para desenvolvimento:

```bash
npm run dev
```

Para executar normalmente:

```bash
npm start
```

O servidor HTTP e o worker de processamento são iniciados juntos.

Por padrão, a aplicação estará disponível em:

```text
http://localhost:3000
```

ou na porta configurada através de `PORT`.

---

# Configurando o webhook

No painel do Asaas Sandbox, configure um webhook apontando para:

```text
https://SEU_DOMINIO/api/webhooks/asaas
```

Utilize como token de autenticação o mesmo valor configurado em:

```text
ASAAS_WEBHOOK_TOKEN
```

Habilite os eventos necessários para os fluxos utilizados pela aplicação.

Entre eles estão os eventos relacionados a:

- criação e pagamento de Checkout;
- confirmação e recebimento de pagamento;
- análise de risco;
- recusa;
- cancelamento;
- estorno;
- chargeback.

Os eventos reconhecidos pela aplicação podem ser consultados em:

```text
src/services/asaasWebhookService.js
```

---

# URL pública em desenvolvimento

O Asaas precisa conseguir acessar o endpoint de webhook da aplicação.

Além disso, callbacks utilizados pelo fluxo de pagamento direto precisam utilizar HTTPS.

Durante o desenvolvimento, utilize uma solução de túnel ou reverse proxy que forneça uma URL pública HTTPS para a aplicação local.

Configure essa URL em:

```env
APP_BASE_URL=https://seu-endereco-publico.example
```

O projeto possui suporte opcional a ambientes executados atrás do Cloudflare Tunnel através da configuração:

```env
DIRECT_PAYMENT_TRUST_CLOUDFLARE=false
```

Ela deve permanecer desabilitada quando Cloudflare Tunnel não estiver sendo utilizado.

---

# Páginas

| Rota | Descrição |
| --- | --- |
| `/` | Checkout hospedado |
| `/payments/direct` | Pagamento direto com 3DS |
| `/order/:publicId` | Acompanhamento do pedido |
| `/admin/orders` | Painel de pedidos |
| `/checkout/success` | Retorno de sucesso do Checkout |
| `/checkout/cancel` | Retorno de cancelamento |
| `/payments/3ds/callback` | Callback do fluxo 3DS |

---

# Endpoints principais

| Método | Endpoint | Descrição |
| --- | --- | --- |
| `POST` | `/api/checkout` | Cria um Checkout hospedado |
| `POST` | `/api/payments/direct` | Cria um pagamento direto |
| `POST` | `/api/webhooks/asaas` | Recebe eventos do Asaas |
| `GET` | `/api/orders/:publicId` | Consulta um pedido |
| `GET` | `/api/admin/orders` | Lista pedidos |
| `GET` | `/api/admin/orders/:publicId` | Consulta detalhes de um pedido |

---

# Segurança

## Dados de cartão

O fluxo de pagamento direto recebe dados do cartão transitoriamente para realizar a requisição ao Asaas.

A aplicação foi projetada para não persistir:

- número do cartão;
- CVV;
- payload bruto contendo dados sensíveis.

Esses dados também não devem aparecer em logs.

O frontend limpa os campos sensíveis após sua utilização e não utiliza armazenamento persistente do navegador para guardar essas informações.

---

## Webhook

Os webhooks utilizam um token independente da chave da API.

A aplicação valida o header enviado pelo Asaas utilizando comparação segura antes de aceitar o evento.

Eventos não autenticados são rejeitados.

---

## Associação financeira

Pedidos não são associados a pagamentos utilizando apenas informações como:

- nome;
- CPF;
- e-mail;
- valor da compra.

A associação utiliza os identificadores técnicos dos recursos criados no Asaas.

No Checkout:

```text
asaas_checkout_id
```

No pagamento direto:

```text
asaas_payment_id
```

---

## Rate limiting

O endpoint de pagamento direto possui limitação de requisições para reduzir tentativas abusivas.

Também é utilizado um identificador de tentativa para evitar cobranças repetidas causadas por reenvios acidentais da mesma operação.

---

# Testes

Execute a suíte disponível através dos scripts definidos no projeto:

```bash
npm test
```

Os testes de integração utilizam um PostgreSQL separado do banco de desenvolvimento e mocks do Asaas.

Nenhuma cobrança real é realizada durante os testes automatizados.

Entre os cenários cobertos estão:

- criação de Checkout;
- criação de pagamento direto;
- payload 3DS;
- autenticação do webhook;
- confirmação financeira;
- pagamento recusado;
- duplicidade de eventos;
- concorrência;
- eventos fora de ordem;
- callbacks;
- rate limiting;
- estorno;
- bloqueio de entrega;
- proteção de dados sensíveis.

O teste específico do frontend do pagamento direto também pode ser executado através de:

```bash
node --test tests/direct-payment-frontend.test.js
```

---

# Testes no Asaas Sandbox

A interface possui recursos para facilitar a execução dos cenários de demonstração utilizando dados fictícios.

Os testes de cartão devem utilizar exclusivamente os cartões e dados disponibilizados para o ambiente Sandbox do Asaas.

Os cenários principais utilizados durante a homologação da PoC são:

### Pagamento aprovado

```text
Pagamento enviado
        ↓
Cobrança criada
        ↓
PAYMENT_CONFIRMED
        ↓
Pedido confirmado
        ↓
Gift Card liberado
```

### Pagamento recusado

```text
Pagamento enviado
        ↓
Asaas recusa a operação
        ↓
Sem confirmação financeira
        ↓
Gift Card bloqueado
```

---

# Processamento de falhas

Quando o resultado de uma operação financeira não pode ser determinado com segurança, a aplicação mantém a entrega bloqueada.

O sistema não assume que uma cobrança falhou apenas porque ocorreu timeout na comunicação.

Isso é importante porque existe a possibilidade de o provedor ter criado uma cobrança mesmo que a aplicação não tenha recebido sua resposta.

Nesses casos, a situação deve ser reconciliada antes de permitir uma nova tentativa ou liberar o produto.

---

# Escopo da PoC

Este projeto é uma **prova de conceito**.

Foram implementados:

- Checkout hospedado;
- pagamento direto;
- integração 3DS;
- PostgreSQL;
- webhooks;
- worker;
- idempotência;
- histórico de pedidos;
- entrega de produto digital;
- tratamento de aprovação e recusa.

Alguns recursos comuns a uma aplicação de produção estão propositalmente fora do escopo.

Entre eles:

- autenticação completa do painel administrativo;
- autenticação do comprador;
- parcelamento;
- tokenização reutilizável de cartões;
- reconciliação financeira automática;
- monitoramento e alertas operacionais;
- infraestrutura distribuída;
- gestão real de Gift Cards.

---

# Considerações sobre 3D Secure

O projeto demonstra a integração técnica com o fluxo 3DS disponibilizado pelo Asaas.

O ambiente Sandbox possui limitações em relação à autenticação realizada por emissores reais.

Por esse motivo, os testes automatizados utilizam mocks para validar cenários que não podem ser reproduzidos completamente no Sandbox.

A utilização de 3D Secure também **não deve ser interpretada como garantia de eliminação de fraude ou chargebacks**.

Benefícios relacionados a autenticação e eventual transferência de responsabilidade dependem das condições aplicáveis à transação, bandeira, emissor, adquirência e configuração da conta.

---

# PCI DSS

O Checkout hospedado mantém a captura dos dados do cartão no ambiente do Asaas.

O pagamento direto possui características diferentes: os dados do cartão passam pela aplicação antes de serem enviados ao provedor.

Por esse motivo, qualquer utilização real do fluxo direto exige uma avaliação formal do escopo e dos requisitos aplicáveis do **PCI DSS**.

Esta PoC:

**não declara conformidade PCI DSS.**

Ela demonstra exclusivamente a implementação técnica e as medidas adotadas durante o desenvolvimento.

---

# Limitações conhecidas

- Utiliza exclusivamente o Asaas Sandbox.
- O produto vendido é fictício.
- O valor da compra é fixo.
- O pagamento direto é à vista.
- O painel administrativo não possui autenticação.
- Não existe controle de acesso por comprador.
- Não existe reconciliação automática de cobranças com resultado incerto.
- Rate limiting é local ao processo Node.
- Não existe painel de alertas para eventos pendentes.
- Um estorno ou chargeback pode bloquear acessos futuros ao produto, mas não é possível recuperar um Gift Card que já tenha sido visualizado ou utilizado.
- O projeto não comprova liability shift em transações reais.

---

# Aviso

Este projeto foi desenvolvido para **estudo, demonstração e validação técnica em ambiente Sandbox**.

Não utilize esta implementação diretamente para processar pagamentos reais sem realizar previamente uma revisão completa de:

- segurança;
- infraestrutura;
- PCI DSS;
- autenticação e autorização;
- gestão de segredos;
- observabilidade;
- tratamento de incidentes;
- políticas de fraude;
- configuração da conta de produção do provedor.

---

## Licença

Defina a licença apropriada antes de distribuir ou reutilizar o projeto.
