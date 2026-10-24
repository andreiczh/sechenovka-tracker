// Bounded 25-second mono PCM chunks. No audio is transmitted by this processor.
class VoicePcm extends AudioWorkletProcessor {
  constructor(options) { super(); this.maximum = Math.floor((options.processorOptions?.maximumSeconds || 3600) * 16000); this.total = 0; this.samples = []; this.phase = 0; this.sum = 0; this.count = 0; this.energy = 0; this.levelCount = 0; this.offset = 0; this.paused = false; this.port.onmessage = ({data}) => { if (data === 'flush') this.flush(); else if (data === 'pause') this.paused = true; else if (data === 'resume' && this.total < this.maximum) this.paused = false; }; }
  flush() { if (!this.samples.length) return; const audio = Float32Array.from(this.samples); this.port.postMessage({ audio, offset: this.offset }, [audio.buffer]); this.offset += this.samples.length / 16000; this.samples = []; }
  process(inputs) {
    if (this.paused || !inputs[0]?.length) return true;
    const channels = inputs[0];
    for (let i = 0; i < channels[0].length; i++) {
      this.sum += channels.reduce((sum, c) => sum + c[i], 0) / channels.length; this.count++; this.phase += 16000 / sampleRate;
      if (this.phase >= 1) { const value=this.sum/this.count; this.samples.push(value);this.energy+=value*value;this.levelCount++;if(this.levelCount>=8000){this.port.postMessage({type:'level',value:Math.sqrt(this.energy/this.levelCount)});this.energy=0;this.levelCount=0;} this.total++; this.phase -= 1; this.sum = 0; this.count = 0; }
      if (this.samples.length >= 400000) this.flush();
      if (this.total >= this.maximum) { this.flush(); this.paused = true; this.port.postMessage({ type: 'limit' }); return true; }
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePcm);
