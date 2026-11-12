/**
 * Ouvir e falar. O Claude não transcreve nem sintetiza voz, então isto usa serviços de áudio:
 * - Fala (TTS): ElevenLabs se ELEVENLABS_API_KEY estiver definida (voz mais natural), senão OpenAI.
 * - Escuta (STT), do app e dos áudios do WhatsApp: ElevenLabs se houver chave dela, senão OpenAI.
 * Sem nenhuma chave, o app web cai na voz do próprio navegador.
 */
export function createSpeech(cfg, { fetchImpl = fetch } = {}) {
  const openai = { Authorization: `Bearer ${cfg.openaiKey}` };
  const provider = cfg.elevenKey && cfg.elevenVoice ? 'elevenlabs' : cfg.openaiKey ? 'openai' : null;

  return {
    /** consegue transcrever áudio (do app ou do WhatsApp) */
    enabled: Boolean(cfg.elevenKey || cfg.openaiKey),
    listener: cfg.elevenKey ? 'elevenlabs' : cfg.openaiKey ? 'openai' : null,
    /** consegue gerar voz */
    canSpeak: Boolean(provider),
    provider,

    /** Áudio -> texto em português. Usa a ElevenLabs quando há chave dela; senão, a OpenAI. */
    async transcribe(buffer, mime = 'audio/ogg') {
      const name = mime.includes('wav') ? 'audio.wav' : mime.includes('mpeg') ? 'audio.mp3' : mime.includes('mp4') ? 'audio.m4a' : 'audio.ogg';
      if (cfg.elevenKey) {
        const ask = async (withLanguage) => {
          const form = new FormData();
          form.append('model_id', cfg.elevenSttModel || 'scribe_v1');
          if (withLanguage) form.append('language_code', 'pt');
          form.append('file', new Blob([buffer], { type: mime }), name);
          return fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': cfg.elevenKey }, body: form });
        };
        let res = await ask(true);
        if (res.status === 400 || res.status === 422) res = await ask(false); // sem o idioma, ela detecta sozinha
        if (res.ok) return (await res.json()).text?.trim() ?? '';
        const detail = (await res.text()).slice(0, 200);
        // Chave sem permissão de transcrição: tenta a OpenAI se houver; senão, explica.
        if (!cfg.openaiKey) {
          throw new Error(
            res.status === 401 || res.status === 403
              ? 'a chave da ElevenLabs não tem permissão de Speech to Text; libere essa permissão na chave'
              : `transcrição (ElevenLabs) ${res.status}: ${detail}`,
          );
        }
      }
      const form = new FormData();
      form.append('model', cfg.sttModel);
      form.append('language', 'pt');
      form.append('file', new Blob([buffer], { type: mime }), name);
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
