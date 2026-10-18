// A short two-note chime for new orders, made by the browser itself: no sound file to load,
// nothing the Content-Security-Policy has to allow. Browsers keep sound muted until a tap or
// click on the page, so unlockChime must run inside one; until then playChime stays silent.

type AudioContextClass = typeof AudioContext;
let context: AudioContext | undefined;

/** Call from a click or key press. Returns false where the browser has no Web Audio. */
export function unlockChime(): boolean {
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
    if (!Context) return false;
    context ??= new Context();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Plays the chime once, if a tap or click already allowed sound on this page. */
export function playChime() {
  if (context?.state !== 'running') return;
  try {
    const start = context.currentTime;
    for (const [offset, frequency] of [
      [0, 880],
      [0.16, 1320],
    ] as const) {
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      // Quiet and quick: a short rise and a soft fade, so it never clicks or startles.
      volume.gain.setValueAtTime(0.0001, start + offset);
      volume.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.32);
      tone.connect(volume).connect(context.destination);
      tone.start(start + offset);
      tone.stop(start + offset + 0.34);
    }
  } catch {
    // A browser that refuses the sound still shows the alert.
  }
}
