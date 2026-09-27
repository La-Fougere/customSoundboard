/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import {
    AudioInput,
    getActiveSoundIds,
    hasVoiceInput,
    interceptSpeaking,
    mixInput,
    playSound,
    releaseInput,
    setAutoLevelMonitoring,
    setSpeakingOnMuteChange,
    shouldEnableInput,
    shutdownAudio,
    stopSound,
    subscribePlaybackState
} from "./audio";
import { MAX_AUDIO_FILE_BYTES, StoredSound } from "./core";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, reject, resolve };
}

class FakeTrack {
    enabled = true;
    stopped = false;

    stop() {
        this.stopped = true;
    }
}

class FakeStream {
    readonly track = new FakeTrack();

    getAudioTracks() {
        return [this.track] as unknown as MediaStreamTrack[];
    }

    getTracks() {
        return [this.track] as unknown as MediaStreamTrack[];
    }
}

class FakeNode {
    connections: unknown[] = [];
    disconnected = false;

    connect<T>(target: T): T {
        this.connections.push(target);
        return target;
    }

    disconnect(target?: unknown) {
        this.disconnected = true;
        this.connections = target == null
            ? []
            : this.connections.filter(connection => connection !== target);
    }
}

class FakeGain extends FakeNode {
    gain = {
        value: 1,
        targets: [] as Array<{ value: number; startTime: number; timeConstant: number; }>,
        setTargetAtTime(value: number, startTime: number, timeConstant: number) {
            this.value = value;
            this.targets.push({ value, startTime, timeConstant });
        }
    };
}

class FakeAnalyser extends FakeNode {
    fftSize = 2048;
    reads = 0;

    constructor(public level: number) {
        super();
    }

    getFloatTimeDomainData(data: Float32Array) {
        this.reads++;
        data.fill(this.level);
    }
}

class FakeCompressor extends FakeNode {
    attack = { value: 0 };
    knee = { value: 0 };
    ratio = { value: 0 };
    release = { value: 0 };
    threshold = { value: 0 };
}

class FakeAudio {
    static metadataGates: Promise<void>[] = [];
    currentTime = 0;
    duration = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onloadedmetadata: (() => void) | null = null;
    playImpl: () => Promise<void> = async () => undefined;
    preload = "";
    private source = "";

    constructor(source = "") {
        if (source) this.src = source;
    }

    get src() {
        return this.source;
    }

    set src(value: string) {
        this.source = value;
        if (value && this.onloadedmetadata) {
            const gate = FakeAudio.metadataGates.shift();
            if (gate) void gate.then(() => this.onloadedmetadata?.());
            else queueMicrotask(() => this.onloadedmetadata?.());
        }
    }

    load() { }
    pause() { }
    play() { return this.playImpl(); }
    removeAttribute(name: string) {
        if (name === "src") this.source = "";
    }
}

const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

before(() => {
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
    URL.createObjectURL = () => "blob:audio-test";
    URL.revokeObjectURL = () => undefined;
});

after(() => {
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
});

class FakeContext {
    readonly currentTime = 0;
    readonly destination = new FakeNode() as unknown as AudioDestinationNode;
    readonly gains: FakeGain[] = [];
    readonly analysers: FakeAnalyser[] = [];
    readonly analyserLevels: number[] = [];
    readonly compressors: FakeCompressor[] = [];
    readonly streamSources: FakeNode[] = [];
    readonly bufferSources: FakeAudio[] = [];
    readonly destinations: Array<{
        channelCount: number;
        channelCountMode: ChannelCountMode;
        stream: FakeStream;
    } & FakeNode> = [];
    resumeImpl: () => Promise<void> = async () => undefined;
    mediaPlayImpl: () => Promise<void> = async () => undefined;
    decodeImpl: (data: ArrayBuffer) => Promise<AudioBuffer> = async () => ({
        duration: 1,
        length: 48_000,
        numberOfChannels: 2,
        sampleRate: 48_000
    }) as AudioBuffer;

    createMediaStreamSource() {
        const source = new FakeNode();
        this.streamSources.push(source);
        return source as unknown as MediaStreamAudioSourceNode;
    }

    createGain() {
        const gain = new FakeGain();
        this.gains.push(gain);
        return gain as unknown as GainNode;
    }

    createAnalyser() {
        const analyser = new FakeAnalyser(this.analyserLevels[this.analysers.length] ?? 0);
        this.analysers.push(analyser);
        return analyser as unknown as AnalyserNode;
    }

    createDynamicsCompressor() {
        const compressor = new FakeCompressor();
        this.compressors.push(compressor);
        return compressor as unknown as DynamicsCompressorNode;
    }

    createMediaStreamDestination() {
        const destination = Object.assign(new FakeNode(), {
            channelCount: 2,
            channelCountMode: "explicit" as ChannelCountMode,
            stream: new FakeStream()
        });
        this.destinations.push(destination);
        return destination as unknown as MediaStreamAudioDestinationNode;
    }

    createMediaElementSource(element: HTMLMediaElement) {
        const audio = element as unknown as FakeAudio;
        audio.playImpl = this.mediaPlayImpl;
        this.bufferSources.push(audio);
        return new FakeNode() as unknown as MediaElementAudioSourceNode;
    }

    resume() {
        return this.resumeImpl();
    }

    decodeAudioData(data: ArrayBuffer) {
        return this.decodeImpl(data);
    }
}

function fakeInput(context: FakeContext, mute = false): AudioInput & { mode: string; pttCalls: boolean[]; speaking: boolean; speakingCalls: boolean[]; } {
    const input = {
        context: context as unknown as AudioContext,
        mode: "VOICE_ACTIVITY",
        mute,
        pttCalls: [] as boolean[],
        speaking: false,
        speakingCalls: [] as boolean[],
        setPTTActive(active: boolean) {
            this.pttCalls.push(active);
        },
        setSpeaking(active: boolean) {
            const effective = interceptSpeaking(this, active);
            if (this.speaking === effective) return;
            this.speaking = effective;
            this.speakingCalls.push(effective);
        }
    };
    return input;
}

function fakeSound(blobOverrides: Partial<Blob> = {}, size = 128, id = "import:test"): StoredSound {
    const blob = {
        size,
        type: "audio/mpeg",
        arrayBuffer: async () => new ArrayBuffer(8),
        ...blobOverrides
    } as Blob;
    return {
        id,
        blob,
        fileName: "test.mp3",
        name: "test",
        size,
        source: "import",
        type: "audio/mpeg"
    };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (check()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail("Timed out waiting for asynchronous audio work");
}

afterEach(() => {
    FakeAudio.metadataGates = [];
    shutdownAudio();
});

test("playSound rejects an oversized blob before reading or decoding it", async () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    mixInput(input, new FakeStream() as unknown as MediaStream);
    let reads = 0;
    const sound = fakeSound({
        size: MAX_AUDIO_FILE_BYTES + 1,
        arrayBuffer: async () => {
            reads++;
            return new ArrayBuffer(0);
        }
    }, MAX_AUDIO_FILE_BYTES + 1);

    await assert.rejects(playSound(sound, 1), /too large/i);
    assert.equal(reads, 0);
    assert.equal(context.bufferSources.length, 0);
});

test("playSound rejects excessive duration before reading compressed bytes", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    let reads = 0;
    const sound = fakeSound({
        arrayBuffer: async () => {
            reads++;
            throw new Error("decoded unexpectedly");
        }
    });

    const originalAudio = globalThis.Audio;
    const reporterGlobal = globalThis as typeof globalThis & { IS_REPORTER?: boolean; };
    const originalReporter = reporterGlobal.IS_REPORTER;
    reporterGlobal.IS_REPORTER = false;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    class LongAudio {
        duration = 121;
        onerror: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        preload = "";

        set src(_value: string) {
            queueMicrotask(() => this.onloadedmetadata?.());
        }

        load() { }
        removeAttribute() { }
    }

    Object.defineProperty(globalThis, "Audio", { configurable: true, value: LongAudio });
    URL.createObjectURL = () => "blob:duration-test";
    URL.revokeObjectURL = () => undefined;
    try {
        await assert.rejects(playSound(sound, 1), /duration/i);
        assert.equal(reads, 0);
    } finally {
        Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
        if (originalReporter == null) Reflect.deleteProperty(reporterGlobal, "IS_REPORTER");
        else reporterGlobal.IS_REPORTER = originalReporter;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

test("stopSound settles playback while AudioContext resume remains pending", async () => {
    const context = new FakeContext();
    context.resumeImpl = () => new Promise(() => undefined);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 1);
    stopSound();

    await Promise.race([
        playing,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("playSound remained pending")), 50))
    ]);
    assert.equal(context.bufferSources.length, 0);
});

test("a stalled AudioContext resume fails after a bounded wait", async () => {
    const context = new FakeContext();
    context.resumeImpl = () => new Promise(() => undefined);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const originalSetTimeout = globalThis.setTimeout;
    const reporterGlobal = globalThis as typeof globalThis & { IS_REPORTER?: boolean; };
    const originalReporter = reporterGlobal.IS_REPORTER;
    reporterGlobal.IS_REPORTER = false;
    let scheduledBoundedWait = false;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 5_000) {
            scheduledBoundedWait = true;
            queueMicrotask(() => (callback as (...args: unknown[]) => void)(...args));
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
        await assert.rejects(Promise.race([
            playSound(fakeSound(), 1),
            new Promise<never>((_, reject) => originalSetTimeout(() => reject(new Error("no bounded resume wait")), 50))
        ]), /audio engine/i);
        assert.equal(scheduledBoundedWait, true);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        if (originalReporter == null) Reflect.deleteProperty(reporterGlobal, "IS_REPORTER");
        else reporterGlobal.IS_REPORTER = originalReporter;
    }
});

test("release during AudioContext resume cancels before source creation", async () => {
    const context = new FakeContext();
    const resume = deferred<void>();
    context.resumeImpl = () => resume.promise;
    const output = mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 1);
    releaseInput(output);
    resume.resolve();
    await playing;

    assert.equal(context.bufferSources.length, 0);
});

test("release while media playback starts cancels and detaches the source", async () => {
    const context = new FakeContext();
    const started = deferred<void>();
    context.mediaPlayImpl = () => started.promise;
    const output = mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 1);
    await waitFor(() => context.bufferSources.length === 1);
    releaseInput(output);
    started.resolve();
    await playing;

    assert.equal(context.bufferSources[0].src, "");
    assert.equal(context.bufferSources[0].onended, null);
});

test("a late media error rejects playback and releases the voice state", async () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;
    const reporterGlobal = globalThis as typeof globalThis & { IS_REPORTER?: boolean; };
    const originalReporter = reporterGlobal.IS_REPORTER;
    reporterGlobal.IS_REPORTER = false;

    try {
        const playing = playSound(fakeSound(), 1);
        await waitFor(() => context.bufferSources.length === 1);
        const media = context.bufferSources[0];
        assert.notEqual(media.onerror, null);
        media.onerror?.();
        await assert.rejects(playing, /media playback failed/i);
        assert.equal(media.src, "");
        assert.equal(input.speaking, false);
        assert.equal(output.track.enabled, true);
    } finally {
        if (originalReporter == null) Reflect.deleteProperty(reporterGlobal, "IS_REPORTER");
        else reporterGlobal.IS_REPORTER = originalReporter;
    }
});

test("replacing an input while media playback starts cancels the obsolete source", async () => {
    const context = new FakeContext();
    const started = deferred<void>();
    context.mediaPlayImpl = () => started.promise;
    const input = fakeInput(context);
    mixInput(input, new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 1);
    await waitFor(() => context.bufferSources.length === 1);
    mixInput(input, new FakeStream() as unknown as MediaStream);
    started.resolve();
    await playing;

    assert.equal(context.bufferSources[0].src, "");
    assert.equal(context.bufferSources[0].onended, null);
});

test("replacing the same audio input disposes the stale mixed stream", () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    const firstSource = new FakeStream();
    const firstOutput = mixInput(input, firstSource as unknown as MediaStream) as unknown as FakeStream;

    const secondSource = new FakeStream();
    const secondOutput = mixInput(input, secondSource as unknown as MediaStream);

    assert.equal(firstSource.track.stopped, true);
    assert.equal(firstOutput.track.stopped, true);
    assert.equal(context.streamSources[0].disconnected, true);
    assert.equal(context.gains[0].disconnected, true);
    assert.equal(context.compressors[0].disconnected, true);
    assert.equal(secondSource.track.stopped, false);
    assert.equal(hasVoiceInput(), true);

    releaseInput(secondOutput);
    assert.equal(secondSource.track.stopped, true);
    assert.equal(hasVoiceInput(), false);
});

test("playback timeout also covers a media play promise that never settles", async () => {
    const context = new FakeContext();
    context.mediaPlayImpl = () => new Promise(() => undefined);
    const input = fakeInput(context);
    mixInput(input, new FakeStream() as unknown as MediaStream);
    const originalSetTimeout = globalThis.setTimeout;
    const reporterGlobal = globalThis as typeof globalThis & { IS_REPORTER?: boolean; };
    const originalReporter = reporterGlobal.IS_REPORTER;
    reporterGlobal.IS_REPORTER = false;
    let scheduledPlaybackTimeout = false;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 125_000) {
            scheduledPlaybackTimeout = true;
            queueMicrotask(() => (callback as (...args: unknown[]) => void)(...args));
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
        await assert.rejects(Promise.race([
            playSound(fakeSound(), 1),
            new Promise<never>((_, reject) => originalSetTimeout(() => reject(new Error("no hard playback limit")), 50))
        ]), /playback timed out/i);
        assert.equal(scheduledPlaybackTimeout, true);
        assert.equal(context.bufferSources[0].src, "");
        assert.equal(input.speaking, false);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        if (originalReporter == null) Reflect.deleteProperty(reporterGlobal, "IS_REPORTER");
        else reporterGlobal.IS_REPORTER = originalReporter;
    }
});

test("concurrent sounds stream without full-file decode or reads", async () => {
    const context = new FakeContext();
    let decodes = 0;
    let reads = 0;
    context.decodeImpl = async () => {
        decodes++;
        return {} as AudioBuffer;
    };
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const sound = fakeSound({
        arrayBuffer: async () => {
            reads++;
            return new ArrayBuffer(8);
        }
    });

    const first = playSound({ ...sound, id: "first" }, 1);
    await waitFor(() => context.bufferSources.length === 1);
    const second = playSound({ ...sound, id: "second" }, 1);
    await waitFor(() => context.bufferSources.length === 2);
    const third = playSound({ ...sound, id: "third" }, 1);
    await waitFor(() => context.bufferSources.length === 3);

    assert.equal(decodes, 0);
    assert.equal(reads, 0);
    assert.notEqual(context.bufferSources[0].src, "");
    assert.notEqual(context.bufferSources[1].src, "");
    assert.deepEqual(getActiveSoundIds(), new Set(["first", "second", "third"]));

    stopSound();
    await Promise.all([first, second, third]);
});

test("a ninth concurrent sound stops the oldest playback", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const playing: Promise<void>[] = [];

    for (let index = 0; index < 9; index++) {
        playing.push(playSound(fakeSound({}, 128, `sound-${index}`), 1));
        await waitFor(() => context.bufferSources.length === index + 1);
    }

    assert.equal(context.bufferSources[0].src, "");
    assert.deepEqual([...getActiveSoundIds()], Array.from({ length: 8 }, (_, index) => `sound-${index + 1}`));
    stopSound();
    await Promise.all(playing);
});

test("a rejected ninth playback leaves all eight existing sounds active", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const playing: Promise<void>[] = [];

    for (let index = 0; index < 8; index++) {
        playing.push(playSound(fakeSound({}, 128, `sound-${index}`), 1));
        await waitFor(() => context.bufferSources.length === index + 1);
    }
    context.mediaPlayImpl = async () => { throw new Error("play rejected"); };
    const reporterGlobal = globalThis as typeof globalThis & { IS_REPORTER?: boolean; };
    const originalReporter = reporterGlobal.IS_REPORTER;
    reporterGlobal.IS_REPORTER = false;

    try {
        await assert.rejects(playSound(fakeSound({}, 128, "sound-8"), 1), /play rejected/i);

        assert.notEqual(context.bufferSources[0].src, "");
        assert.deepEqual([...getActiveSoundIds()], Array.from({ length: 8 }, (_, index) => `sound-${index}`));
    } finally {
        stopSound();
        await Promise.all(playing);
        if (originalReporter == null) Reflect.deleteProperty(reporterGlobal, "IS_REPORTER");
        else reporterGlobal.IS_REPORTER = originalReporter;
    }
});

test("simultaneous starts preserve request-order FIFO while metadata resolves out of order", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const gates = Array.from({ length: 9 }, () => deferred<void>());
    FakeAudio.metadataGates = gates.map(gate => gate.promise);

    const playing = Array.from({ length: 9 }, (_, index) => playSound(fakeSound({}, 128, `sound-${index}`), 1));
    gates[0].resolve();
    for (let index = 2; index < gates.length; index++) gates[index].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    gates[1].resolve();
    await waitFor(() => context.bufferSources.length >= 8 && getActiveSoundIds().size === 8);

    assert.deepEqual([...getActiveSoundIds()], Array.from({ length: 8 }, (_, index) => `sound-${index + 1}`));

    stopSound();
    await Promise.all(playing);
});

test("cancelling a queued playback settles before the current admission finishes", async () => {
    const context = new FakeContext();
    const firstStarted = deferred<void>();
    context.mediaPlayImpl = () => firstStarted.promise;
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const first = playSound(fakeSound({}, 128, "first"), 1);
    await waitFor(() => context.bufferSources.length === 1);
    const second = playSound(fakeSound({}, 128, "second"), 1);
    await new Promise<void>(resolve => setImmediate(resolve));

    stopSound("second");
    await Promise.race([
        second,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queued cancellation timed out")), 50))
    ]);
    assert.deepEqual([...getActiveSoundIds()], []);

    stopSound("first");
    firstStarted.resolve();
    await first;
});

test("playback state subscribers observe active sound changes", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const snapshots: string[][] = [];
    const unsubscribe = subscribePlaybackState(ids => snapshots.push([...ids]));

    const playing = playSound(fakeSound({}, 128, "outlined"), 1);
    await waitFor(() => snapshots.some(ids => ids.includes("outlined")));
    stopSound();
    await playing;
    unsubscribe();

    assert.deepEqual(snapshots.at(-1), []);
});

test("per-sound volume and trim are applied without exceeding the send cap", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: number[] = [];
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        scheduled.push(delay ?? 0);
        return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
        const sound = { ...fakeSound(), volume: 1.5, trimStart: 0.25, trimEnd: 0.75 };
        const playing = playSound(sound, 0.4, 0.8);
        await waitFor(() => context.bufferSources.length === 1);

        assert.equal(context.bufferSources[0].currentTime, 0.25);
        assert.equal(context.gains[1].gain.value, 1.5);
        assert.equal(context.gains[2].gain.value, 0.4);
        assert.ok(scheduled.includes(500));

        stopSound();
        await playing;
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("trim timing starts only after media playback begins", async () => {
    const context = new FakeContext();
    const started = deferred<void>();
    context.mediaPlayImpl = () => started.promise;
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: number[] = [];
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        scheduled.push(delay ?? 0);
        return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
        const playing = playSound({ ...fakeSound(), trimStart: 0.25, trimEnd: 0.75 }, 1);
        await waitFor(() => context.bufferSources.length === 1);
        assert.equal(scheduled.includes(500), false);

        started.resolve();
        await waitFor(() => scheduled.includes(500));
        stopSound();
        await playing;
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("released push-to-talk isolates the physical microphone before playback", () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    input.mode = "PUSH_TO_TALK";

    const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;

    assert.equal(context.gains[0].gain.value, 0);
    assert.equal(output.track.enabled, false);
    assert.equal(shouldEnableInput(input), false);
    assert.deepEqual(input.pttCalls, []);
});

test("mixed voice output is explicitly mono", () => {
    const context = new FakeContext();
    const input = fakeInput(context);

    mixInput(input, new FakeStream() as unknown as MediaStream);

    assert.equal(context.destinations[0].channelCount, 1);
    assert.equal(context.destinations[0].channelCountMode, "explicit");
});

test("soundboard transmits with released PTT while the physical microphone stays isolated", async () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    input.mode = "PUSH_TO_TALK";
    const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;

    const playing = playSound(fakeSound(), 0.8);
    await waitFor(() => context.bufferSources.length === 1);

    assert.equal(context.gains[0].gain.value, 0);
    assert.equal(output.track.enabled, true);
    assert.equal(input.speaking, true);
    assert.deepEqual(input.pttCalls, []);

    stopSound();
    await playing;

    assert.equal(context.gains[0].gain.value, 0);
    assert.equal(output.track.enabled, false);
    assert.equal(input.speaking, false);
    assert.deepEqual(input.pttCalls, []);
});

test("PTT state changes during playback preserve sound and restore the latest user state", async () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    input.mode = "PUSH_TO_TALK";
    input.setSpeaking(true);
    const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;
    assert.equal(context.gains[0].gain.value, 1);

    const playing = playSound(fakeSound(), 0.8);
    await waitFor(() => context.bufferSources.length === 1);
    input.setSpeaking(false);

    assert.equal(input.speaking, true);
    assert.equal(context.gains[0].gain.value, 0);
    assert.equal(output.track.enabled, true);

    stopSound();
    await playing;

    assert.equal(input.speaking, false);
    assert.equal(output.track.enabled, false);
    assert.deepEqual(input.pttCalls, []);
});

test("muted playback never enables the mixed track or speaking state", async () => {
    const context = new FakeContext();
    const input = fakeInput(context, true);
    const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;
    assert.equal(output.track.enabled, false);

    const playing = playSound(fakeSound(), 0.8);
    await waitFor(() => context.bufferSources.length === 1);
    assert.equal(output.track.enabled, false);
    assert.equal(input.speaking, false);
    assert.deepEqual(input.pttCalls, []);

    stopSound();
    await playing;
    assert.equal(output.track.enabled, false);
    assert.deepEqual(input.pttCalls, []);
});

test("mute then unmute during playback never leaves speaking active", async () => {
    for (const finish of ["natural", "stop"] as const) {
        const context = new FakeContext();
        const input = fakeInput(context);
        const output = mixInput(input, new FakeStream() as unknown as MediaStream) as unknown as FakeStream;

        const playing = playSound(fakeSound(), 0.8);
        await waitFor(() => context.bufferSources.length === 1);
        assert.deepEqual(input.speakingCalls, [true]);
        assert.equal(input.speaking, true);

        input.mute = true;
        setSpeakingOnMuteChange(input);
        assert.deepEqual(input.speakingCalls, [true, false]);
        assert.equal(input.speaking, false);
        assert.equal(output.track.enabled, false);

        input.mute = false;
        setSpeakingOnMuteChange(input);
        assert.deepEqual(input.speakingCalls, [true, false, true]);
        assert.equal(input.speaking, true);
        assert.equal(output.track.enabled, true);

        if (finish === "natural") context.bufferSources[0].onended?.();
        else stopSound();
        await playing;

        assert.deepEqual(input.speakingCalls, [true, false, true, false]);
        assert.deepEqual(input.pttCalls, []);
        shutdownAudio();
    }
});

test("send and monitor volumes use independent gain paths", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.25, 0.75);
    await waitFor(() => context.bufferSources.length === 1);

    assert.equal(context.gains.length, 4);
    const [, soundGain, sendGain, monitorGain] = context.gains;
    assert.equal(soundGain.gain.value, 1);
    assert.equal(sendGain.gain.value, 0.25);
    assert.equal(monitorGain.gain.value, 0.75);
    assert.ok(sendGain.connections.includes(context.compressors[0]));
    assert.ok(monitorGain.connections.includes(context.destination));
    assert.ok(!monitorGain.connections.includes(context.compressors[0]));

    stopSound();
    await playing;
});

test("auto level starts silent until the first sound measurement", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.5, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);

    const [, , sendGain, monitorGain] = context.gains;
    assert.equal(sendGain.gain.value, 0);
    assert.equal(monitorGain.gain.value, 0.75);

    stopSound();
    await playing;
});

test("auto level monitoring stays dormant while no sound is playing", async () => {
    const context = new FakeContext();
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    setAutoLevelMonitoring(true);
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(context.analysers.length, 0);
});

test("stopping playback stops and disconnects voice analysis", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5);
    const input = fakeInput(context);
    input.setSpeaking(true);
    mixInput(input, new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.5, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    const voiceAnalyser = context.analysers[0];
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.ok(voiceAnalyser.reads > 0);
    stopSound();
    await playing;

    const readsAfterStop = voiceAnalyser.reads;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(voiceAnalyser.reads, readsAfterStop);
    assert.equal(voiceAnalyser.disconnected, true);
    assert.equal(context.streamSources[0].connections.includes(voiceAnalyser), false);
});

test("disabling auto level during playback stops sound analysis and restores the send cap", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    const soundAnalyser = context.analysers[1];
    const sendGain = context.gains[2];
    for (let attempt = 0; attempt < 20 && soundAnalyser.reads === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(soundAnalyser.reads > 0);

    setAutoLevelMonitoring(false);
    const readsAfterDisable = soundAnalyser.reads;
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(soundAnalyser.reads, readsAfterDisable);
    assert.equal(soundAnalyser.disconnected, true);
    assert.equal(sendGain.gain.value, 0.4);

    stopSound();
    await playing;
});

test("disabling auto level while playback starts prevents late sound analysis from being created", async () => {
    const context = new FakeContext();
    const resumed = deferred<void>();
    context.resumeImpl = () => resumed.promise;
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: true, relativeDb: -6 });
    await new Promise<void>(resolve => setImmediate(resolve));
    setAutoLevelMonitoring(false);
    resumed.resolve();
    await waitFor(() => context.bufferSources.length === 1);

    assert.equal(context.analysers.length, 0);
    assert.equal(context.gains[2].gain.value, 0.4);

    stopSound();
    await playing;
});

test("enabling auto level while playback starts enables fresh voice and sound analysis", async () => {
    const context = new FakeContext();
    const resumed = deferred<void>();
    context.resumeImpl = () => resumed.promise;
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: false, relativeDb: -6 });
    await new Promise<void>(resolve => setImmediate(resolve));
    setAutoLevelMonitoring(true);
    resumed.resolve();
    await waitFor(() => context.bufferSources.length === 1);

    assert.equal(context.analysers.length, 2);
    assert.equal(context.gains[2].gain.value, 0);

    stopSound();
    await playing;
});

test("enabling auto level while media playback is pending installs analysis immediately", async () => {
    const context = new FakeContext();
    const started = deferred<void>();
    context.mediaPlayImpl = () => started.promise;
    context.analyserLevels.push(0.1, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: false, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    setAutoLevelMonitoring(true);

    assert.equal(context.analysers.length, 2);
    assert.equal(context.gains[2].gain.value, 0);

    started.resolve();
    await waitFor(() => getActiveSoundIds().size === 1);
    stopSound();
    await playing;
});

test("disabling auto level while media playback is pending removes analysis immediately", async () => {
    const context = new FakeContext();
    const started = deferred<void>();
    context.mediaPlayImpl = () => started.promise;
    context.analyserLevels.push(0.1, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    const voiceAnalyser = context.analysers[0];
    const soundAnalyser = context.analysers[1];
    setAutoLevelMonitoring(false);

    assert.equal(voiceAnalyser.disconnected, true);
    assert.equal(soundAnalyser.disconnected, true);
    assert.equal(context.gains[2].gain.value, 0);

    started.resolve();
    await waitFor(() => getActiveSoundIds().size === 1);
    assert.equal(context.gains[2].gain.value, 0.4);
    stopSound();
    await playing;
});

test("enabling auto level during active playback inserts analysis and starts silently", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.4, 0.75, { enabled: false, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    const sendGain = context.gains[2];
    assert.equal(context.analysers.length, 0);
    assert.equal(sendGain.gain.value, 0.4);

    setAutoLevelMonitoring(true);

    assert.equal(context.analysers.length, 2);
    assert.equal(sendGain.gain.value, 0);
    for (let attempt = 0; attempt < 20 && context.analysers[1].reads === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(context.analysers[1].reads > 0);

    stopSound();
    await playing;
});

test("a pending auto-level playback keeps shared voice analysis alive", async () => {
    const context = new FakeContext();
    const secondStarted = deferred<void>();
    let playCalls = 0;
    context.mediaPlayImpl = () => ++playCalls === 1 ? Promise.resolve() : secondStarted.promise;
    context.analyserLevels.push(0.1, 0.5, 0.5);
    mixInput(fakeInput(context), new FakeStream() as unknown as MediaStream);

    const first = playSound(fakeSound({}, 128, "first"), 0.4, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => getActiveSoundIds().has("first"));
    const voiceAnalyser = context.analysers[0];
    const second = playSound(fakeSound({}, 128, "second"), 0.4, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 2);

    stopSound("first");
    await first;
    assert.equal(voiceAnalyser.disconnected, false);

    secondStarted.resolve();
    await waitFor(() => getActiveSoundIds().has("second"));
    stopSound("second");
    await second;
});

test("a later playback starts with a fresh voice reference instead of the previous playback level", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5, 0.01, 0.5);
    const input = fakeInput(context);
    input.setSpeaking(true);
    mixInput(input, new FakeStream() as unknown as MediaStream);
    await new Promise(resolve => setTimeout(resolve, 130));

    const first = playSound(fakeSound(), 1, 0.75, { enabled: true, relativeDb: 0 });
    await waitFor(() => context.bufferSources.length === 1);
    stopSound();
    await first;

    const second = playSound(fakeSound(), 1, 0.75, { enabled: true, relativeDb: 0 });
    await waitFor(() => context.bufferSources.length === 2);
    const secondSendGain = context.gains[5];
    for (let attempt = 0; attempt < 20 && secondSendGain.gain.targets.length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(secondSendGain.gain.targets.length > 0);

    const firstTarget = secondSendGain.gain.targets[0].value;
    assert.ok(firstTarget > 0.11 && firstTarget < 0.14, `expected fallback-based gain, got ${firstTarget}`);

    stopSound();
    await second;
});

test("auto level keeps the streamed sound six decibels below learned speech without changing monitor volume", async () => {
    const context = new FakeContext();
    context.analyserLevels.push(0.1, 0.5);
    const input = fakeInput(context);
    input.setSpeaking(true);
    mixInput(input, new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 0.5, 0.75, { enabled: true, relativeDb: -6 });
    await waitFor(() => context.bufferSources.length === 1);
    await new Promise(resolve => setTimeout(resolve, 150));

    const [, , sendGain, monitorGain] = context.gains;
    for (let attempt = 0; attempt < 50 && sendGain.gain.targets.length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(context.analysers.length, 2);
    assert.ok(sendGain.gain.value > 0.09 && sendGain.gain.value < 0.11);
    assert.ok(sendGain.gain.value <= 0.5);
    assert.equal(monitorGain.gain.value, 0.75);

    sendGain.gain.targets.length = 0;
    context.analysers[1].level = 1;
    for (let attempt = 0; attempt < 50 && sendGain.gain.targets.length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(sendGain.gain.targets.some(target => target.timeConstant <= 0.1));

    stopSound();
    await playing;
});

test("microphone and soundboard share an outgoing dynamics compressor", async () => {
    const context = new FakeContext();
    const input = fakeInput(context);
    mixInput(input, new FakeStream() as unknown as MediaStream);

    const playing = playSound(fakeSound(), 1);
    await waitFor(() => context.bufferSources.length === 1);

    assert.equal(context.compressors.length, 1);
    const compressor = context.compressors[0];
    assert.ok(context.gains[0].connections.includes(compressor));
    assert.ok(context.gains[2].connections.includes(compressor));
    assert.ok(compressor.threshold.value < 0);

    stopSound();
    await playing;
});
