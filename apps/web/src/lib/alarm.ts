// Short, loud beeps for Act Now timers and the crew alarm (Web Audio: no sound file, works offline).
let ctx: AudioContext | null = null

export function beep(times = 3): void {
  try {
    ctx ??= new AudioContext()
    const audio = ctx
    for (let i = 0; i < times; i++) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'square'
      osc.frequency.value = 880
      gain.gain.value = 0.15
      osc.connect(gain).connect(audio.destination)
      const t = audio.currentTime + i * 0.35
      osc.start(t)
      osc.stop(t + 0.2)
    }
  } catch {
    // no audio device: the screen still shows everything
  }
}

/** Read a step aloud with the device's own (offline) voice. */
export function speak(text: string): void {
  try {
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
  } catch {
    // speech not available
  }
}
