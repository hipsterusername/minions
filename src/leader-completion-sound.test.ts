import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeAudioNode {
  connect: ReturnType<typeof vi.fn>;
}

function createAudioContextDouble(state: AudioContextState = "running") {
  const starts: number[] = [];
  const stops: number[] = [];
  const frequencies: number[] = [];
  const resume = vi.fn().mockResolvedValue(undefined);

  class FakeAudioContext {
    state = state;
    currentTime = 3;
    destination = {};
    resume = resume;

    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime: (value: number) => frequencies.push(value) },
        connect: vi.fn(),
        start: (at: number) => starts.push(at),
        stop: (at: number) => stops.push(at),
      };
    }

    createGain(): FakeAudioNode & { gain: Record<string, ReturnType<typeof vi.fn>> } {
      return {
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      };
    }
  }

  return { FakeAudioContext, frequencies, resume, starts, stops };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("leader completion sound", () => {
  it("plays a short two-note chime", async () => {
    const audio = createAudioContextDouble();
    vi.stubGlobal("window", { AudioContext: audio.FakeAudioContext });
    const { playLeaderCompletionSound } = await import("./leader-completion-sound.ts");

    playLeaderCompletionSound();

    expect(audio.frequencies).toEqual([659.25, 880]);
    expect(audio.starts).toEqual([3, 3.11]);
    expect(audio.stops).toEqual([3.21, 3.32]);
  });

  it("resumes suspended audio before playing", async () => {
    const audio = createAudioContextDouble("suspended");
    vi.stubGlobal("window", { AudioContext: audio.FakeAudioContext });
    const { playLeaderCompletionSound } = await import("./leader-completion-sound.ts");

    playLeaderCompletionSound();
    await Promise.resolve();

    expect(audio.resume).toHaveBeenCalledTimes(1);
    expect(audio.starts).toHaveLength(2);
  });

  it("is a no-op when Web Audio is unavailable", async () => {
    vi.stubGlobal("window", {});
    const { playLeaderCompletionSound } = await import("./leader-completion-sound.ts");

    expect(() => playLeaderCompletionSound()).not.toThrow();
  });
});
