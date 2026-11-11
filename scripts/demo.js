// Demonstração sem nenhuma chave: simula um dia de negócio e mostra o que o dono receberia.
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createJarvis } from '../src/app.js';
import { runBriefing } from '../src/briefing.js';

const config = loadConfig({ OWNER_WHATSAPP: '+55 11 90000-0000', BUSINESS_NAME: 'Negócio Demo' });
let clock = Date.now();
const store = openStore(':memory:', { now: () => clock });
const whatsapp = createWhatsApp(config.whatsapp);
const jarvis = createJarvis({ store, config, whatsapp, speech: { enabled: false }, brain: null });

console.log('— Dia 1: o dono saiu. Limite de escalonamento: R$ 2.000 —');
for (let i = 0; i < 31; i++) store.addEvent({ type: 'customer_message', status: 'handled', summary: 'Dúvida respondida' });
for (let i = 0; i < 14; i++) await jarvis.ingestEvent({ type: 'new_member', contact_name: `Membro ${i + 1}` });
await jarvis.ingestEvent({ type: 'sale', amount: 497, summary: 'Curso' });
await jarvis.ingestEvent({ type: 'refund', amount: 97, summary: 'Reembolso dentro da garantia' });

console.log('— 18h: resumo diário —');
await runBriefing({ store, config, notifyOwner: jarvis.notifyOwner, force: true });

clock += 24 * 3600 * 1000;
console.log('— Dia 2: aparece algo grande —');
for (let i = 0; i < 12; i++) store.addEvent({ type: 'customer_message', status: 'handled' });
await jarvis.ingestEvent({ type: 'refund', amount: 3500, summary: 'Cliente pede reembolso da mentoria', contact_name: 'Carlos' });

console.log('— 18h: resumo diário —');
await runBriefing({ store, config, notifyOwner: jarvis.notifyOwner, force: true });
