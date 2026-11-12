import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const effort = (v, d) => (['low', 'medium', 'high', 'xhigh', 'max'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : d);
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** Lê toda a configuração do ambiente. Nada aqui é obrigatório para subir em modo demonstração. */
export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    dbPath: env.JARVIS_DB || 'data/jarvis.db',
    knowledgeDir: env.KNOWLEDGE_DIR || 'knowledge',
    // Endereço público do servidor, usado em links enviados por WhatsApp.
    publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, ''),

    assistantName: env.ASSISTANT_NAME || 'Jarvis',
    ownerName: env.OWNER_NAME || 'o dono',
    ownerTitle: env.OWNER_TITLE || 'senhor',
    businessName: env.BUSINESS_NAME || 'o negócio',

    // Escuta pelo servidor (o app grava, o servidor transcreve e reconhece a voz). Desligada por padrão:
    // só liga com JARVIS_SERVER_LISTEN=1, porque ainda precisa de teste no aparelho real.
    serverListen: /^(1|true|sim|on)$/i.test(env.JARVIS_SERVER_LISTEN || ''),
    // Reconhecimento de voz por pessoa: arquivo do modelo e nota mínima (0 a 1) para aceitar a voz.
    voiceprintModel: env.VOICEPRINT_MODEL || join(dirname(env.JARVIS_DB || 'data/jarvis.db'), 'models', 'voz.onnx'),
    voiceprintThreshold: Math.min(.95, Math.max(.2, num(env.VOICEPRINT_THRESHOLD, 0.5))),

    // Cor de destaque dos PDFs (padrão: dourado da marca).
    pdfAccent: /^#[0-9a-f]{6}$/i.test(env.PDF_ACCENT || '') ? env.PDF_ACCENT : '#B08A3C',

    // Token que protege o app de voz e a API de eventos.
    token: env.JARVIS_TOKEN || '',

    // Modelo das conversas. Com JARVIS_ROUTER=on, assuntos importantes sobem sozinhos para JARVIS_SMART_MODEL.
    model: env.JARVIS_MODEL || 'claude-sonnet-5-5',
    smartModel: env.JARVIS_SMART_MODEL || 'claude-opus-5-5',
    routerModel: env.JARVIS_ROUTER_MODEL || 'claude-haiku-5-5',
    router: /^(1|on|true|sim)$/i.test(env.JARVIS_ROUTER || ''), // desligada por padrão: toda conversa usa JARVIS_MODEL
    // Profundidade de raciocínio: low | medium | high | xhigh | max. Mais alto pensa melhor, demora e custa mais.
    voiceEffort: effort(env.JARVIS_VOICE_EFFORT, 'medium'),
    textEffort: effort(env.JARVIS_EFFORT, 'medium'),
    // Modo rápido do modelo nas conversas por voz (responde mais depressa, custa mais por resposta).
    fastVoice: /^(1|true|sim)$/i.test(env.JARVIS_FAST || ''),
    // Velocidade de reprodução da voz no app (1 = normal).
    voiceRate: Math.min(1.6, Math.max(0.7, num(env.VOICE_SPEED, 1.12))),

    // Regras iniciais (o dono pode mudar por voz/WhatsApp; o que ele disser fica salvo no banco).
    defaultThreshold: num(env.ESCALATION_THRESHOLD, 2000),
    currency: env.CURRENCY || 'BRL',

    timezone: env.TIMEZONE || 'America/Sao_Paulo',
    briefingHour: num(env.BRIEFING_HOUR, 18),

    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      owner: env.OWNER_WHATSAPP || '',
      // Template aprovado (1 variável no corpo) usado quando a janela de 24h do dono fechou.
      briefingTemplate: env.WHATSAPP_BRIEFING_TEMPLATE || '',
      templateLang: env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    },

    // Opcional: voz natural no app e áudios no WhatsApp.
    speech: {
      openaiKey: env.OPENAI_API_KEY || '',
      sttModel: env.STT_MODEL || 'whisper-1',
      ttsModel: env.TTS_MODEL || 'tts-1',
      ttsVoice: env.TTS_VOICE || 'onyx',
      elevenKey: env.ELEVENLABS_API_KEY || '',
      elevenVoice: env.ELEVENLABS_VOICE_ID || '',
      elevenSttModel: env.ELEVENLABS_STT_MODEL || 'scribe_v1',
      elevenModel: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
    },
  };
}

export function ensureToken(config, log = console.log) {
  if (config.token) return config.token;
  config.token = randomBytes(18).toString('base64url');
  log(`[jarvis] JARVIS_TOKEN não definido. Token temporário desta execução: ${config.token}`);
  return config.token;
}
