/**
 * 英文朗读：优先真人发音（有道词典发音接口），失败回退系统 TTS。
 *
 * 为什么换掉纯 TTS：系统 TTS 是合成音，用户反馈「十分别扭」。有道词典的
 * `dictvoice` 接口返回真人录音（英式 type=1 / 美式 type=2），与有道词典网页版
 * 同一音源，最接近用户「仿照有道翻译词典」的要求。
 *
 * 网络不可用 / 接口失败 / 无音频设备时回退 Web Speech API（离线可用），
 * 保证「任何情况下点发音都有反应」。
 */

/** 有道发音接口的音频 URL。 */
export function youdaoAudioUrl(text: string, accent: 'uk' | 'us'): string {
  const type = accent === 'uk' ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${String(type)}`;
}

/** 按口音挑选可用的英文语音（TTS 兜底用）。 */
function pickVoice(accent: 'uk' | 'us'): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    return null;
  }
  const wanted = accent === 'uk' ? 'en-GB' : 'en-US';
  return (
    voices.find((voice) => voice.lang === wanted) ??
    voices.find((voice) => voice.lang.startsWith('en-')) ??
    voices.find((voice) => voice.lang.startsWith('en')) ??
    null
  );
}

/**
 * 用系统 TTS 朗读一段英文文本。
 *
 * @param text 要朗读的文本（单词或短语）。
 * @param accent 口音（uk/us 决定语音的 lang）。
 * @param volume 音量 0..1，默认 1。
 * @returns 是否真的发起了朗读（环境不支持时 false，调用方不必报错）。
 */
export function speakWithTts(text: string, accent: 'uk' | 'us', volume = 1): boolean {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (synth === undefined) {
    return false;
  }
  try {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US';
    const voice = pickVoice(accent);
    if (voice !== null) {
      utterance.voice = voice;
    }
    utterance.volume = Math.min(1, Math.max(0, volume));
    utterance.rate = 0.9; // 学习场景稍微放慢，听得更清
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/**
 * 朗读一个词/短语：真人发音优先（有道发音接口），失败自动回退 TTS。
 *
 * @param text 要朗读的英文。
 * @param accent 英式/美式。
 * @param volume 音量 0..1。
 */
export function speak(text: string, accent: 'uk' | 'us', volume = 1): void {
  const AudioConstructor = (globalThis as { Audio?: typeof Audio }).Audio;
  if (typeof AudioConstructor === 'undefined') {
    speakWithTts(text, accent, volume);
    return;
  }
  try {
    const audio = new AudioConstructor(youdaoAudioUrl(text, accent));
    audio.volume = Math.min(1, Math.max(0, volume));
    // 播放失败（离线/接口 4xx/音频解码失败）→ 人声不可用，退回 TTS。
    void audio.play().catch(() => speakWithTts(text, accent, volume));
  } catch {
    speakWithTts(text, accent, volume);
  }
}
