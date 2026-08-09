type AudioContextConstructor = new () => AudioContext;

let audioContext: AudioContext | null = null;
let unlockListenersInstalled = false;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as Window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function getAudioContext(): AudioContext | null {
  if (audioContext?.state === "closed") audioContext = null;
  if (audioContext) return audioContext;

  const AudioContextClass = getAudioContextConstructor();
  if (!AudioContextClass) return null;

  try {
    audioContext = new AudioContextClass();
  } catch {
    return null;
  }
  return audioContext;
}

function removeUnlockListeners(): void {
  if (!unlockListenersInstalled || typeof document === "undefined") return;
  document.removeEventListener("pointerdown", unlockAudio, true);
  document.removeEventListener("keydown", unlockAudio, true);
  unlockListenersInstalled = false;
}

function unlockAudio(): void {
  const context = getAudioContext();
  removeUnlockListeners();
  if (context?.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

/**
 * Prepare Web Audio during the first user gesture so browsers allow a later
 * completion chime after a long-running leader turn.
 */
export function armLeaderCompletionSound(): void {
  if (
    typeof document === "undefined" ||
    unlockListenersInstalled ||
    audioContext?.state === "running"
  ) {
    return;
  }
  document.addEventListener("pointerdown", unlockAudio, true);
  document.addEventListener("keydown", unlockAudio, true);
  unlockListenersInstalled = true;
}

function playChime(context: AudioContext): void {
  const now = context.currentTime;
  const notes = [
    { frequency: 659.25, offset: 0 },
    { frequency: 880, offset: 0.11 },
  ];

  for (const note of notes) {
    const start = now + note.offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.21);
  }
}

/** Play a short two-note completion chime without affecting leader state. */
export function playLeaderCompletionSound(): void {
  const context = getAudioContext();
  if (!context) return;

  const play = () => {
    try {
      playChime(context);
    } catch {
      // Audio is best-effort; a browser/device failure must not break the run.
    }
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => undefined);
    return;
  }
  play();
}
