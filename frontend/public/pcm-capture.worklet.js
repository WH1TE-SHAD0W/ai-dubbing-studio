// AudioWorklet that forwards microphone samples to the main thread in ~40 ms blocks.
// Downsampling to 16 kHz and PCM16 framing happen there (src/live/pcm.ts), where they are tested.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.n = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buf[this.n++] = channel[i]
        if (this.n === this.buf.length) {
          const block = this.buf.slice()
          this.port.postMessage(block.buffer, [block.buffer])
          this.n = 0
        }
      }
    }
    return true // keep running
  }
}

registerProcessor('pcm-capture', PcmCapture)
