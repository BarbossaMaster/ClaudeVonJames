/**
 * Ouvir e falar. O Claude não transcreve nem sintetiza voz, então isto usa serviços de áudio:
 * - Fala (TTS): ElevenLabs se ELEVENLABS_API_KEY estiver definida (voz mais natural), senão OpenAI.
 * - Escuta de áudios do WhatsApp (STT): OpenAI.
 * Sem nenhuma chave, o app web cai na voz do próprio navegador.
 */
export function createSpeech(cfg, { fetchImpl = fetch } = {}) {
  const openai = { Authorization: `Bearer ${cfg.openaiKey}` };
  const provider = cfg.elevenKey && cfg.elevenVoice ? 'elevenlabs' : cfg.openaiKey ? 'openai' : null;

  return {
    /** consegue transcrever áudios recebidos */
    enabled: Boolean(cfg.openaiKey),
    /** consegue gerar voz */
    canSpeak: Boolean(provider),
    provider,

    async transcribe(buffer, mime = 'audio/ogg') {
      const form = new FormData();
      form.append('model', cfg.sttModel);
      form.append('language', 'pt');
      form.append('file', new Blob([buffer], { type: mime }), 'audio.ogg');
      const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: openai,
        body: form,
      });
      if (!res.ok) throw new Error(`transcrição ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).text?.trim() ?? '';
    },

    /**
     * Gera a fala. format 'mp3' para o app web; 'voice' pede OGG/Opus (nota de voz do WhatsApp)
     * quando o provedor oferece. Devolve { buffer, mime }.
     */
    async speak(text, { format = 'mp3' } = {}) {
      const input = String(text).slice(0, 4000);
      if (provider === 'elevenlabs') {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.elevenVoice)}?output_format=mp3_44100_128`;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'xi-api-key': cfg.elevenKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input, model_id: cfg.elevenModel }),
        });
        if (!res.ok) throw new Error(`voz (ElevenLabs) ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
      }
      if (provider === 'openai') {
        const opus = format === 'voice';
        const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { ...openai, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: cfg.ttsModel,
            voice: cfg.ttsVoice,
            input,
            response_format: opus ? 'opus' : 'mp3',
          }),
        });
        if (!res.ok) throw new Error(`voz (OpenAI) ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return { buffer: Buffer.from(await res.arrayBuffer()), mime: opus ? 'audio/ogg' : 'audio/mpeg' };
      }
      throw new Error('nenhum serviço de voz configurado');
    },
  };
}
