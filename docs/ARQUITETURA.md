# James — como foi feito

Assistente de IA que opera a Astro Gold pelo dono: conversa por voz, atende no WhatsApp, registra o que acontece no negócio, manda resumo diário e gera PDFs. Este documento descreve a estrutura, a hospedagem e as decisões de projeto.

## Visão geral

```
                       ┌──────────────────────────── Railway ────────────────────────────┐
 iPhone (app web) ─────┤  Express (Node.js 22)                                           │
   voz e texto         │    ├─ /api/chat      conversa do dono ──▶ Cérebro ──▶ Claude    │──▶ Anthropic (Claude Sonnet 5.5)
                       │    ├─ /api/speak     texto → áudio ─────────────────────────────│──▶ ElevenLabs / OpenAI
 WhatsApp (Meta) ──────┤    ├─ /webhooks/whatsapp   dono ou cliente                      │──▶ Meta Cloud API
                       │    ├─ /api/events    vendas, membros, reembolsos                │
 Hotmart, Stripe… ─────┤    ├─ /d/<id>.pdf    documentos gerados                         │
                       │    └─ agendador      resumo diário                              │
                       │  Volume /app/data:  jarvis.db (SQLite) + docs/*.pdf             │
                       └─────────────────────────────────────────────────────────────────┘
```

Um único processo Node faz tudo: serve o app, fala com o Claude, guarda os dados e agenda o resumo. Não há fila, cache externo nem banco separado.

## Tecnologias

| Camada | Escolha | Por quê |
|---|---|---|
| Servidor | Node.js 22 + Express, JavaScript puro (ESM) | Sem etapa de build; sobe com `npm start` |
| Banco | SQLite embutido do Node (`node:sqlite`) | Nenhum serviço a mais; um arquivo no volume |
| Cérebro | Claude Sonnet 5.5 (trocável por `JARVIS_MODEL`) pelo SDK oficial `@anthropic-ai/sdk` | Raciocínio e uso de ferramentas |
| Voz (fala) | ElevenLabs; OpenAI como alternativa; voz do aparelho como reserva | Voz natural, com queda suave se faltar crédito |
| Voz (escuta) | Reconhecimento de voz do navegador (Web Speech API) | Sem custo; roda no próprio iPhone |
| PDF | `pdfkit` | Gera no servidor, sem navegador headless |
| WhatsApp | API oficial da Meta (Cloud API), via `fetch` | Sem intermediário; ainda não conectado |
| App | Uma página HTML com CSS e JS embutidos, instalável na tela de início | Sem framework; abre rápido |
| Testes | `node --test`, com Claude e WhatsApp simulados | Rodam sem nenhuma chave |

Dependências de produção são três: `@anthropic-ai/sdk`, `express` e `pdfkit`.

## Estrutura de pastas

```
src/
  server.js      ponto de entrada: monta as peças e sobe o servidor
  config.js      lê todas as variáveis de ambiente
  app.js         rotas HTTP e o orquestrador (WhatsApp, eventos, avisos ao dono)
  brain.js       prompts, ferramentas e o loop de conversa com o Claude
  store.js       banco SQLite: eventos, conversas, regras, documentos
  briefing.js    números do período, texto do resumo e agendador
  documents.js   geração de PDF (markdown simples, imagens, gráficos)
  speech.js      texto → voz e áudio → texto
  whatsapp.js    cliente da API da Meta e leitura do webhook
  knowledge.js   carrega a base de conhecimento
  util.js        moeda, telefone, fuso, fila por contato
public/
  index.html     app de voz
  manifest.webmanifest, icon.svg
knowledge/
  negocio.md     o que o James sabe sobre a Astro Gold
  atendimento-whatsapp.md   roteiro do atendimento comercial a leads no WhatsApp
  imagens/       logo, telas do sistema e catálogo (imagens.json)
test/            20 testes automatizados
scripts/demo.js  simulação de dois dias, sem chaves
docs/            este documento
```

## O cérebro

`src/brain.js` mantém **dois modos separados de propósito**:

| Modo | Quem | Ferramentas |
|---|---|---|
| **Dono** | Número em `OWNER_WHATSAPP` ou quem entra no app com o token | `get_business_snapshot`, `list_events`, `update_rules`, `resolve_item`, `remember`, `create_document` |
| **Contato** | Qualquer outro número no WhatsApp | Apenas `escalate_to_owner` |

Um cliente não tem como alcançar faturamento, regras ou dados de outros clientes: essas ferramentas simplesmente não existem no modo dele. O que o cliente escreve é tratado como pedido a atender, nunca como instrução.

Como uma resposta é produzida:

1. Monta o histórico (últimas 24 falas da conversa) e acrescenta data, hora e o estilo do canal (voz, WhatsApp ou texto).
2. Na conversa com o dono, os números das últimas 24 horas já vão no contexto, para a pergunta mais comum não exigir uma consulta extra.
3. Chama o Claude com o prompt do modo, a base de conhecimento e as ferramentas.
4. Se o Claude pedir uma ferramenta, o servidor executa e devolve o resultado; repete até ele terminar (no máximo 8 voltas).
5. Guarda a pergunta e a resposta final no banco.

**Troca automática de modelo.** Antes de responder ao dono, o servidor escolhe o modelo: Claude Sonnet 5.5 para conversa comum e Claude Opus 5.5 para assunto importante (análise, estratégia, dinheiro, documentos, texto para cliente). Mensagens curtas e pedidos explícitos ("pensa bem", "usa o Opus") são decididos na hora; o resto passa por um classificador rápido (Claude Haiku 5.5). Se a classificação falhar, vale o Sonnet. `JARVIS_ROUTER=off` desliga. O atendimento a clientes usa sempre o modelo do dia a dia.

Parâmetros da chamada: raciocínio adaptativo, esforço médio por padrão (`JARVIS_VOICE_EFFORT`, `JARVIS_EFFORT`), cache de prompt e fallback automático de modelo em caso de recusa. Se a API falhar, o cliente recebe "vou confirmar com a equipe" e fica uma pendência para o dono.

**Números nunca vêm do modelo.** Contagens e somas saem de consultas ao banco em `briefing.js`; o Claude só as relata.

## Dados

Um arquivo SQLite com cinco tabelas:

| Tabela | Conteúdo |
|---|---|
| `events` | Tudo que acontece: mensagem de cliente, novo membro, venda, reembolso, escalonamento. Tem valor, contato, status (`handled`, `pending`, `resolved`, `escalated`) |
| `turns` | Falas de cada conversa (dono e cada contato) |
| `settings` | Regras do dono, notas ensinadas, data do último resumo |
| `documents` | PDFs gerados (id, título, data) |
| `seen` | IDs de mensagens já processadas, para ignorar reenvios da Meta |

As regras do dono (limite de escalonamento e instruções permanentes) ficam em `settings` e entram no prompt a cada conversa.

## Regra de escalonamento e resumo diário

- Evento com valor igual ou acima do limite gera aviso imediato ao dono. Reembolsos e afins acima do limite ficam pendentes de decisão; venda grande só avisa.
- Um cliente que pede algo fora da base de conhecimento, ou que envolva dinheiro não autorizado, é encaminhado: urgente avisa na hora, normal entra no resumo.
- O agendador confere a cada minuto. A partir da hora configurada (`BRIEFING_HOUR`, fuso `TIMEZONE`), envia o resumo uma vez por dia, cobrindo o período desde o resumo anterior.

## Voz

**Fala.** O app pede o áudio a `/api/speak`, que chama a ElevenLabs (ou a OpenAI) e devolve MP3. O app toca em velocidade ajustável (`VOICE_SPEED`). Se o serviço falhar, cai na voz do aparelho.

**Escuta.** Usa o reconhecimento de voz do Safari. O iPhone tem particularidades que o código contorna:

- Não avisa quando a fala termina: quem decide é o silêncio (3 s em fala curta, 4 s em longa) ou um toque no anel.
- Mantinha o microfone aberto depois de `stop()`: a sessão é derrubada com `abort()`.
- Recomeça a transcrição do zero em falas longas: o trecho anterior é preservado e somado.
- Às vezes perde o evento de fim do áudio: a fala sempre termina por evento, limite de tempo ou interrupção.

Tocar no anel enquanto ele fala interrompe e já começa a ouvir. Abrir o app com `#debug` no endereço mostra os eventos de voz na tela.

## Documentos (PDF)

O Claude escreve o conteúdo em markdown simples e chama `create_document`. O servidor monta um A4 com:

- logo e cor da marca no cabeçalho, numeração no rodapé;
- títulos, listas, negrito e parágrafos;
- imagens do catálogo, com `![legenda](imagem:ID)`;
- gráficos de barras, em um bloco ` ```grafico `.

O arquivo vai para `data/docs/` e é servido em `/d/<id>.pdf`. O id tem 128 bits aleatórios: o endereço funciona como chave, sem pedir senha, o que permite encaminhar. No app, cada PDF tem um botão que abre a folha de compartilhamento do iPhone.

Para acrescentar imagens, coloque o arquivo em `knowledge/imagens/` e registre em `imagens.json`.

## WhatsApp

O código está pronto e testado com a API simulada; falta conectar a conta da Meta.

- `GET /webhooks/whatsapp` responde à verificação da Meta.
- `POST /webhooks/whatsapp` confere a assinatura (`X-Hub-Signature-256`), responde 200 na hora e processa em segundo plano, em fila por contato.
- Telefones brasileiros são comparados com e sem o nono dígito.
- Fora da janela de 24 horas, o aviso ao dono usa um template aprovado, se configurado.
- Sem credenciais, tudo que seria enviado aparece no console do servidor.

## Rotas

| Rota | Acesso | Função |
|---|---|---|
| `GET /` | público | App de voz (pede o token) |
| `GET /health` | público | Verificação de vida |
| `POST /api/chat` | token | Conversa com o dono |
| `POST /api/speak` | token | Texto → MP3 |
| `GET /api/state` | token | Nome, regras, números do dia |
| `GET /api/docs` | token | Lista de PDFs |
| `POST /api/events` | token | Registrar evento do negócio |
| `POST /api/briefing` | token | Enviar o resumo agora |
| `GET /d/<id>.pdf` | link secreto | Abrir um PDF |
| `GET/POST /webhooks/whatsapp` | assinatura da Meta | Mensagens do WhatsApp |

## Hospedagem

- **Onde:** Railway, projeto `honest-laughter`, ambiente `production`, região US East.
- **Origem:** repositório `BarbossaMaster/ClaudeVonJames`, branch `claude/youthful-hawking-41gcnd`, com deploy automático a cada commit.
- **Execução:** o Railway detecta o Node pelo `package.json` e roda `npm start`.
- **Endereço:** `https://claudevonjames-production.up.railway.app`
- **Disco:** volume montado em `/app/data`. Guarda o banco e os PDFs, e sobrevive aos deploys.

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `ANTHROPIC_API_KEY` | Acesso ao Claude |
| `JARVIS_TOKEN` | Senha do app e da API |
| `JARVIS_DB` | Caminho do banco (`/app/data/jarvis.db`) |
| `ASSISTANT_NAME`, `OWNER_NAME`, `OWNER_TITLE`, `BUSINESS_NAME` | Identidade |
| `ESCALATION_THRESHOLD`, `CURRENCY`, `TIMEZONE`, `BRIEFING_HOUR` | Regras iniciais e resumo |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | Voz |
| `VOICE_SPEED` | Velocidade da fala |
| `JARVIS_VOICE_EFFORT`, `JARVIS_EFFORT`, `JARVIS_FAST`, `JARVIS_MODEL` | Cérebro |
| `OPENAI_API_KEY` | Voz alternativa e escuta de áudios do WhatsApp |
| `OWNER_WHATSAPP`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_BRIEFING_TEMPLATE` | WhatsApp |
| `PDF_ACCENT` | Cor de destaque dos PDFs |

A lista completa, com comentários, está em `.env.example`.

## Segurança

- App e API exigem o token, comparado em tempo constante.
- Webhook do WhatsApp só é aceito com assinatura válida quando a conta está conectada.
- Chaves ficam apenas nas variáveis do Railway; `.env` e a pasta `data/` não entram no repositório.
- Cliente e dono têm ferramentas diferentes, como descrito acima.
- Ponto de atenção: quem tem o token é tratado como dono. Hoje não há perfis separados.

## Rodar localmente

```bash
npm install
npm run demo     # simulação sem chaves
npm test         # 20 testes
cp .env.example .env   # preencher ANTHROPIC_API_KEY e JARVIS_TOKEN
npm start        # http://localhost:3000
```

## Limites atuais

- Não movimenta dinheiro: registra, decide dentro das regras e comunica.
- Urgência chega como mensagem, não como ligação.
- O reconhecimento de voz do Safari encerra falas muito longas (na casa de um minuto).
- Com a tela bloqueada, o iPhone corta o microfone do navegador.
- PDFs não têm tabelas, e as imagens são só as do catálogo.
- Não há envio por e-mail.
- Um único perfil de dono.

## Próximos passos previstos

1. Conectar a conta da Meta (número de teste, depois número real e template do resumo).
2. Gravação de áudio no app com transcrição no servidor, para falas longas.
3. Ligar a plataforma de vendas em `/api/events`.
4. Acesso separado para o sócio.
