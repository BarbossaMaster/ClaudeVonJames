/**
 * Ouvir e falar nos áudios do WhatsApp. O Claude não transcreve nem sintetiza voz,
 * então isto usa a API de áudio da OpenAI quando OPENAI_API_KEY está definida.
 * Sem a chave, o Jarvis segue funcionando só por texto (o app web usa a voz do próprio navegador).
 */
export function createSpeech(cfg, { fetchImpl = fetch } = {}) {
  const enabled = Boolean(cfg.openaiKey);
  const auth = { Authorization: `Bearer ${cfg.openaiKey}` };

  return {
    enabled,

    async transcribe(buffer, mime = 'audio/ogg') {
      const form = new FormData();
      form.append('model', cfg.sttModel);
      form.append('language', 'pt');
      form.append('file', new Blob([buffer], { type: mime }), 'audio.ogg');
      const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: auth,
        body: form,
      });
      if (!res.ok) throw new Error(`transcrição ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).text?.trim() ?? '';
    },

    /** Devolve áudio OGG/Opus, o formato de nota de voz do WhatsApp. */
    async speak(text) {
      const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.ttsModel,
          voice: cfg.ttsVoice,
          input: text.slice(0, 4000),
          response_format: 'opus',
        }),
      });
      if (!res.ok) throw new Error(`síntese de voz ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
