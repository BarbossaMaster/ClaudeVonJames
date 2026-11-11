# Jarvis

Assistente de IA que toca o negócio enquanto o dono está fora.

- **Atende no WhatsApp** clientes, membros e interessados, usando a base de conhecimento do negócio.
- **Só interrompe o dono pelo que importa**: o dono dita a regra ("só me chame acima de R$ 2 mil") e o Jarvis segue. Acima do limite, avisa na hora; abaixo, resolve e relata.
- **Resumo diário** curto no WhatsApp: `31 perguntas respondidas. 14 novos membros. Nada precisa do senhor.`
- **Conversa por voz**: app web para o celular ("Toque para falar" ou modo mãos livres chamando pelo nome) e áudios no WhatsApp.
- **Conselheiro**: o dono pergunta e ele responde com os números reais do negócio.

## Começar em 2 minutos

Requer Node.js 22.13 ou mais novo.

```bash
npm install
npm run demo        # simula dois dias de negócio, sem nenhuma chave
npm test            # testes automatizados

cp .env.example .env   # preencha ANTHROPIC_API_KEY e JARVIS_TOKEN
npm start              # abre em http://localhost:3000
```

Abra o endereço no celular, informe o token e fale. Sem credenciais do WhatsApp, tudo que o Jarvis enviaria aparece no console do servidor, então dá para testar o fluxo inteiro antes de ter a conta da Meta.

## Como funciona

```
WhatsApp (clientes) ─┐                      ┌─ responde o cliente
WhatsApp (dono) ─────┤                      ├─ avisa o dono na hora (acima do limite)
App de voz (dono) ───┼──▶  Jarvis (Claude) ─┼─ registra tudo no banco
Eventos do negócio ──┘      + regras        └─ resumo diário às 18h
(vendas, membros…)          + base de conhecimento
```

Há dois modos, separados de propósito:

| Quem fala | O que o Jarvis pode fazer |
|---|---|
| **Dono** (número `OWNER_WHATSAPP` ou app com token) | Ver números, mudar regras, decidir pendências, ensinar fatos, pedir conselho |
| **Qualquer outra pessoa** | Receber atendimento com base no conhecimento do negócio. A única ferramenta disponível é encaminhar ao dono; dados internos não ficam ao alcance |

Os números do resumo saem direto do banco de dados, nunca do modelo.

## Ensinar o negócio ao Jarvis

1. Preencha `knowledge/negocio.md` (pode criar outros `.md` ou `.txt` na pasta).
2. Ou fale com ele: "Jarvis, anota: a garantia é de 7 dias." Ele guarda e passa a usar no atendimento.

O que não estiver na base ele não inventa: diz ao cliente que vai confirmar e encaminha ao dono.

## Conectar o WhatsApp (API oficial da Meta)

1. Em [developers.facebook.com](https://developers.facebook.com) crie um app do tipo Business e adicione o produto WhatsApp.
2. Copie o token de acesso, o ID do número de telefone e o App Secret para o `.env`.
3. Publique o servidor num endereço HTTPS e configure o webhook como `https://SEU_DOMINIO/webhooks/whatsapp`, com o mesmo `WHATSAPP_VERIFY_TOKEN` do `.env`. Assine o campo `messages`.
4. Coloque seu número em `OWNER_WHATSAPP`.

Regra do WhatsApp a conhecer: a empresa só pode mandar mensagem livre a quem escreveu nas últimas 24 horas. Para o resumo diário chegar mesmo quando você passou um dia sem falar com o Jarvis, crie um template (categoria utilidade) com uma variável no corpo, por exemplo `Resumo do dia: {{1}}`, e informe o nome em `WHATSAPP_BRIEFING_TEMPLATE`.

Para áudios no WhatsApp, defina `OPENAI_API_KEY` (transcrição e voz). O app web usa a voz do próprio navegador e não precisa disso.

## Registrar eventos do negócio

Qualquer sistema (Stripe, Hotmart, Kiwify, Zapier, Make, n8n) pode avisar o Jarvis:

```bash
curl -X POST https://SEU_DOMINIO/api/events \
  -H "Authorization: Bearer $JARVIS_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"sale","amount":497,"summary":"Curso X","contact_name":"Ana"}'
```

Tipos: `new_member`, `sale`, `refund`, `cancellation`, `payment_failed`, `customer_message`, `other`. Eventos com valor a partir do limite do dono geram aviso imediato; reembolsos e afins acima do limite ficam pendentes de decisão.

Outras rotas (todas com o token): `POST /api/chat`, `GET /api/state`, `POST /api/briefing` (envia o resumo agora).

## Limites atuais

- O Jarvis não movimenta dinheiro: ele registra, decide dentro das regras e comunica. Reembolsos e cobranças continuam sendo executados na plataforma de pagamento.
- Urgências chegam como mensagem de WhatsApp marcada com 🚨, não como ligação telefônica.
- Reconhecimento de voz no app depende do navegador (Safari no iPhone e Chrome funcionam); onde não houver, use o campo de texto.
