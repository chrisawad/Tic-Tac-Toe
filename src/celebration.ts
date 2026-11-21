import confetti from 'canvas-confetti';

// Arrow Cube and Bus Jam use this two-cannon sequence followed by an overhead shower.
export function winConfetti(canvas: HTMLCanvasElement) {
  let fire: ReturnType<typeof confetti.create> | undefined;
  let timers: number[] = [];
  const stop = () => {
    timers.forEach(id => window.clearTimeout(id));
    timers = [];
    fire?.reset();
  };
  function play(winner: string) {
    stop();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const shoot = fire ??= confetti.create(canvas, { resize: true, useWorker: true, disableForReducedMotion: true });
    const burst = (options: confetti.Options) => shoot({
      colors: [winner, '#ffd36e', '#6ce8bc', '#ff7487', '#7eb7ff', '#fff6e3'],
      spread: 85, ticks: 160, gravity: 1.06, scalar: 1.08, ...options,
    });
    burst({ particleCount: 92, angle: 60, startVelocity: 53, origin: { x: .04, y: .8 } });
    burst({ particleCount: 92, angle: 120, startVelocity: 53, origin: { x: .96, y: .8 } });
    timers.push(window.setTimeout(() => {
      burst({ particleCount: 95, spread: 165, startVelocity: 33, origin: { x: .5, y: .23 } });
    }, 260), window.setTimeout(() => {
      burst({ particleCount: 48, angle: 63, startVelocity: 40, origin: { x: .1, y: .63 } });
      burst({ particleCount: 48, angle: 117, startVelocity: 40, origin: { x: .9, y: .63 } });
    }, 555));
  }
  return { play, stop };
}

export function gameAudio() {
  let context: AudioContext | undefined;
  let master: GainNode;
  let horns: PeriodicWave;
  let enabled = true;

  function unlock() {
    if (!enabled || !window.AudioContext) return;
    try {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.connect(context.destination);
        const harmonics = new Float32Array([0, 1, .8, .55, .4, .25, .18, .12, .09, .07]);
        horns = context.createPeriodicWave(new Float32Array(harmonics.length), harmonics);
      }
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch { /* Audio support is optional. */ }
  }

  function note(hz: number, offset: number, duration: number, volume: number, brass: boolean) {
    if (!enabled || !context || !master) return;
    const at = context.currentTime + offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    if (brass) oscillator.setPeriodicWave(horns);
    else oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(hz * .99, at);
    oscillator.frequency.linearRampToValueAtTime(hz, at + .025);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.linearRampToValueAtTime(volume, at + .014);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0001, brass ? volume * .45 : .001), at + duration * .77);
    gain.gain.linearRampToValueAtTime(.0001, at + duration);
    oscillator.connect(gain).connect(master);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(at);
    oscillator.stop(at + duration + .01);
  }

  return {
    unlock,
    enable(value: boolean) { enabled = value; if (master) master.gain.value = value ? 1 : 0; },
    place(mark: string) { note(mark === 'X' ? 510 : 655, 0, .105, .052, false); },
    win() {
      // The reference games’ three brass pickups and closing C-major chord.
      const melody = [
        [392, 0, .14, .066], [392, .18, .14, .066], [392, .36, .14, .066],
        [523.25, .57, .2, .064], [659.25, .82, .2, .064], [783.99, 1.07, .78, .063],
        [523.25, 1.07, .78, .02], [659.25, 1.07, .78, .02],
      ];
      for (const [hz, offset, duration, volume] of melody) note(hz, offset, duration, volume, true);
    },
  };
}
