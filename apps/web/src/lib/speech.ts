/**
 * 英文朗读（Web Speech API / speechSynthesis）。
 *
 * 为什么用它：导入的自建词（短语、缩写、生僻词）在在线词典里往往没有音频 URL，
 * 「发音按钮点了没反应」就是这个问题。系统自带的 TTS 离线可用、任何文本都能读，
 * 英式/美式通过选择对应 lang 的语音实现；都没有时退回 lang='en' 的默认语音。
 *
 * jsdom 等无 speechSynthesis 的环境里返回 false，调用方不视为错误。
 */

/** 按口音挑选可用的英文语音（找不到精确匹配时退回任意英文语音）。 */
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
