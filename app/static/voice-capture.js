// PCM speech segmentation shared by live capture and deterministic regression checks.
export class SpeechSegmenter {
  constructor(rate, onStart, onEnd) {
    this.rate = rate;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.reset();
  }
  reset() {
    this.frames = [];
    this.recent = [];
    this.recentSamples = 0;
    this.active = false;
    this.voiced = this.silence = this.length = 0;
  }
  push(frame, {enabled = true, threshold = .018, silenceSeconds = .9, interrupting = false} = {}) {
    if (!enabled) { this.reset(); return; }
    const samples = frame.length;
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / samples);
    // Keep a bounded manual-send buffer; only 400ms is carried into detected speech.
    this.recent.push(frame);
    this.recentSamples += samples;
    while (this.recentSamples > this.rate * 28 && this.recent.length > 1) this.recentSamples -= this.recent.shift().length;
    if (!this.active) {
      this.voiced = rms >= threshold ? this.voiced + samples : 0;
      const required = this.rate * (interrupting ? .28 : .16);
      if (this.voiced < required) return;
      this.active = true;
      this.frames = [];
      this.length = 0;
      for (let i = this.recent.length - 1; i >= 0 && this.length < this.rate * .4; i--) {
        this.frames.unshift(this.recent[i]); this.length += this.recent[i].length;
      }
      this.onStart(interrupting);
    } else {
      this.frames.push(frame); this.length += samples;
    }
    this.silence = rms >= threshold ? 0 : this.silence + samples;
    if (this.silence >= this.rate * silenceSeconds || this.length >= this.rate * 28) this.flush();
  }
  flush() {
    const frames = this.active ? this.frames : this.recent;
    const size = frames.reduce((n, f) => n + f.length, 0);
    if (!size) return;
    const pcm = new Float32Array(size);
    let offset = 0;
    for (const frame of frames) { pcm.set(frame, offset); offset += frame.length; }
    this.reset();
    this.onEnd(pcm);
  }
}

export function encodeWav(pcm, sampleRate) {
  const data = new ArrayBuffer(44 + pcm.length * 2), view = new DataView(data);
  const text = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true));
  return new Blob([data], {type: 'audio/wav'});
}
