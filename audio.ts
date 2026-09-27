/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_FILE_BYTES, StoredSound, validateAudioFileSize } from "./core";

export interface AudioInput {
    context: AudioContext;
    mode?: string;
    mute: boolean;
    speaking?: boolean;
    setSpeaking(speaking: boolean): void;
}

export interface AutoLevelOptions {
    enabled: boolean;
    relativeDb: number;
}

interface MixedInput {
    input: AudioInput;
    sourceStream: MediaStream;
    source: MediaStreamAudioSourceNode;
    voiceAnalyser: AnalyserNode | null;
    voiceSamples: Float32Array<ArrayBuffer> | null;
    voiceLevelDb: number | null;
    voiceTimer: ReturnType<typeof setInterval> | null;
    microphoneGain: GainNode;
    limiter: DynamicsCompressorNode;
    destination: MediaStreamAudioDestinationNode;
}

interface PlaybackSource {
    input: AudioInput;
    audio: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
    soundGain: GainNode;
    soundAnalyser: AnalyserNode | null;
    soundSamples: Float32Array<ArrayBuffer> | null;
    sendGain: GainNode;
    monitorGain: GainNode | null;
}

interface Playback {
    controller: AbortController;
    targets: MixedInput[];
    sources: PlaybackSource[];
    soundId: string;
    objectUrl: string | null;
    levelTimer: ReturnType<typeof setInterval> | null;
    timeout: ReturnType<typeof setTimeout> | null;
    trimTimer: ReturnType<typeof setTimeout> | null;
    failure: Error | null;
    done: Promise<void>;
    resolve: () => void;
    reject: (reason: Error) => void;
    sendCap: number;
    autoLevelEnabled: boolean;
    relativeDb: number;
}

const logger = new Logger("CustomSoundboard");
const AUTO_LEVEL_INTERVAL_MS = 50;
const VOICE_LEVEL_INTERVAL_MS = 100;
const DEFAULT_VOICE_LEVEL_DB = -24;
const MIN_MEASURED_LEVEL_DB = -70;
const MAX_CONCURRENT_SOUNDS = 8;
const mixedInputs = new Map<MediaStream, MixedInput>();
const forcedSpeakingInputs = new WeakSet<AudioInput>();
const requestedSpeaking = new WeakMap<AudioInput, boolean>();
const playbacks: Playback[] = [];
const pendingPlaybacks = new Set<Playback>();
const playbackListeners = new Set<(soundIds: ReadonlySet<string>) => void>();
let admissionTail: Promise<void> = Promise.resolve();

function reserveAdmission(): { previous: Promise<void>; release(): void; } {
    const previous = admissionTail;
    let released = false;
    let resolve!: () => void;
    admissionTail = new Promise<void>(res => { resolve = res; });
    return {
        previous,
        release() {
            if (released) return;
            released = true;
            resolve();
        }
    };
}

function notifyPlaybackState(): void {
    const soundIds = getActiveSoundIds();
    for (const listener of playbackListeners) listener(soundIds);
}

export function getActiveSoundIds(): ReadonlySet<string> {
    return new Set(playbacks.map(active => active.soundId));
}

export function subscribePlaybackState(listener: (soundIds: ReadonlySet<string>) => void): () => void {
    playbackListeners.add(listener);
    listener(getActiveSoundIds());
    return () => playbackListeners.delete(listener);
}

function measureLevelDb(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    return 20 * Math.log10(Math.max(rms, 0.0001));
}

function autoLevelGain(voiceDb: number, soundDb: number, sendCap: number, relativeDb: number): number {
    const targetSoundDb = voiceDb + Math.max(-18, Math.min(0, relativeDb));
    const requiredGain = 10 ** ((targetSoundDb - soundDb) / 20);
    return Math.max(0, Math.min(Math.max(0, Math.min(1, sendCap)), requiredGain));
}

function getRequestedSpeaking(input: AudioInput): boolean {
    return requestedSpeaking.get(input) ?? input.speaking ?? false;
}

function setPluginSpeaking(input: AudioInput, speaking: boolean): void {
    forcedSpeakingInputs.add(input);
    try {
        input.setSpeaking(speaking);
    } finally {
        forcedSpeakingInputs.delete(input);
    }
}

function isTargetCurrent(target: MixedInput): boolean {
    return mixedInputs.get(target.destination.stream) === target;
}

function isPlaybackCurrent(active: Playback): boolean {
    return (playbacks.includes(active) || pendingPlaybacks.has(active))
        && !active.controller.signal.aborted
        && active.targets.every(isTargetCurrent);
}

function isMicrophoneEnabled(input: AudioInput): boolean {
    return !input.mute
        && (input.mode !== "PUSH_TO_TALK" || getRequestedSpeaking(input));
}

function updateVoiceLevel(mixed: MixedInput): void {
    if (!isMicrophoneEnabled(mixed.input) || !getRequestedSpeaking(mixed.input)) return;
    if (!mixed.voiceAnalyser || !mixed.voiceSamples) return;
    const measuredDb = measureLevelDb(mixed.voiceAnalyser, mixed.voiceSamples);
    if (!Number.isFinite(measuredDb) || measuredDb < MIN_MEASURED_LEVEL_DB) return;
    mixed.voiceLevelDb = mixed.voiceLevelDb == null
        ? measuredDb
        : mixed.voiceLevelDb * 0.85 + measuredDb * 0.15;
}

function startVoiceAnalysis(mixed: MixedInput): void {
    if (mixed.voiceTimer != null) return;
    const analyser = mixed.input.context.createAnalyser();
    analyser.fftSize = 2048;
    mixed.voiceAnalyser = analyser;
    mixed.voiceSamples = new Float32Array(analyser.fftSize);
    mixed.source.connect(analyser);
    mixed.voiceTimer = globalThis.setInterval(() => updateVoiceLevel(mixed), VOICE_LEVEL_INTERVAL_MS);
}

function stopVoiceAnalysis(mixed: MixedInput, resetLevel = false): void {
    if (mixed.voiceTimer != null) {
        globalThis.clearInterval(mixed.voiceTimer);
        mixed.voiceTimer = null;
    }
    const analyser = mixed.voiceAnalyser;
    if (analyser) {
        mixed.source.disconnect(analyser);
        analyser.disconnect();
    }
    mixed.voiceAnalyser = null;
    mixed.voiceSamples = null;
    if (resetLevel) mixed.voiceLevelDb = null;
}

function disablePlaybackAutoLevel(active: Playback): void {
    const admitted = playbacks.includes(active);
    if (active.levelTimer != null) {
        globalThis.clearInterval(active.levelTimer);
        active.levelTimer = null;
    }
    for (const playbackSource of active.sources) {
        const { input, sendGain, soundAnalyser, soundGain } = playbackSource;
        if (soundAnalyser) {
            soundGain.disconnect(soundAnalyser);
            soundAnalyser.disconnect();
            soundGain.connect(sendGain);
            playbackSource.soundAnalyser = null;
            playbackSource.soundSamples = null;
        }
        sendGain.gain.setTargetAtTime(admitted ? active.sendCap : 0, input.context.currentTime, 0.05);
    }
}

function enablePlaybackAutoLevel(active: Playback): void {
    active.autoLevelEnabled = true;
    for (const target of active.targets) startVoiceAnalysis(target);
    for (const playbackSource of active.sources) {
        if (playbackSource.soundAnalyser) continue;
        const { input, sendGain, soundGain } = playbackSource;
        const soundAnalyser = input.context.createAnalyser();
        soundAnalyser.fftSize = 2048;
        soundGain.disconnect(sendGain);
        soundGain.connect(soundAnalyser).connect(sendGain);
        sendGain.gain.value = 0;
        playbackSource.soundAnalyser = soundAnalyser;
        playbackSource.soundSamples = new Float32Array(soundAnalyser.fftSize);
    }
    if (active.sources.length > 0 && active.levelTimer == null) {
        active.levelTimer = globalThis.setInterval(
            () => updateAutoLevel(active, active.sendCap, active.relativeDb),
            AUTO_LEVEL_INTERVAL_MS
        );
    }
}

export function setAutoLevelMonitoring(enabled: boolean): void {
    for (const active of pendingPlaybacks) {
        if (active.sources.length === 0) {
            active.autoLevelEnabled = enabled;
        } else if (enabled) {
            enablePlaybackAutoLevel(active);
        } else {
            active.autoLevelEnabled = false;
            disablePlaybackAutoLevel(active);
        }
    }
    if (playbacks.length === 0) {
        if (!enabled) {
            for (const mixed of mixedInputs.values()) stopVoiceAnalysis(mixed, true);
        }
        return;
    }
    if (enabled) {
        for (const active of playbacks) enablePlaybackAutoLevel(active);
    } else {
        for (const active of playbacks) {
            active.autoLevelEnabled = false;
            disablePlaybackAutoLevel(active);
        }
        for (const mixed of mixedInputs.values()) stopVoiceAnalysis(mixed, true);
    }
}

function updateAutoLevel(active: Playback, sendCap: number, relativeDb: number): void {
    if (!isPlaybackCurrent(active)) return;
    for (const playbackSource of active.sources) {
        const { input, sendGain, soundAnalyser, soundSamples } = playbackSource;
        if (!soundAnalyser || !soundSamples) continue;
        const soundDb = measureLevelDb(soundAnalyser, soundSamples);
        if (!Number.isFinite(soundDb) || soundDb < MIN_MEASURED_LEVEL_DB) continue;
        const target = active.targets.find(candidate => candidate.input === input);
        const voiceDb = target?.voiceLevelDb ?? DEFAULT_VOICE_LEVEL_DB;
        const gain = autoLevelGain(voiceDb, soundDb, sendCap, relativeDb);
        const timeConstant = gain < sendGain.gain.value ? 0.05 : 0.5;
        sendGain.gain.setTargetAtTime(gain, input.context.currentTime, timeConstant);
    }
}

function updateInputState(input: AudioInput): void {
    const playing = playbacks.some(active => active.targets.some(target => target.input === input));
    const microphoneEnabled = isMicrophoneEnabled(input);
    for (const mixed of mixedInputs.values()) {
        if (mixed.input !== input) continue;
        mixed.microphoneGain.gain.value = microphoneEnabled ? 1 : 0;
        for (const track of mixed.destination.stream.getAudioTracks()) {
            track.enabled = microphoneEnabled || (!input.mute && playing);
        }
    }
}

function updatePlaybackState(input: AudioInput): void {
    updateInputState(input);
    setPluginSpeaking(input, !input.mute && (isInputPlaying(input) || getRequestedSpeaking(input)));
}

function finishPlayback(active: Playback, error?: Error): void {
    const playbackIndex = playbacks.indexOf(active);
    const wasPending = pendingPlaybacks.delete(active);
    if (playbackIndex < 0 && !wasPending) return;
    active.failure = error ?? null;
    if (playbackIndex >= 0) playbacks.splice(playbackIndex, 1);
    active.controller.abort();

    for (const { audio, source, soundAnalyser, soundGain, sendGain, monitorGain } of active.sources) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        source.disconnect();
        soundGain.disconnect();
        soundAnalyser?.disconnect();
        sendGain.disconnect();
        monitorGain?.disconnect();
    }
    if (active.objectUrl) {
        URL.revokeObjectURL(active.objectUrl);
        active.objectUrl = null;
    }
    if (active.levelTimer != null) {
        globalThis.clearInterval(active.levelTimer);
        active.levelTimer = null;
    }
    if (active.timeout != null) {
        globalThis.clearTimeout(active.timeout);
        active.timeout = null;
    }
    if (active.trimTimer != null) {
        globalThis.clearTimeout(active.trimTimer);
        active.trimTimer = null;
    }

    for (const target of active.targets) {
        const stillNeeded = [...playbacks, ...pendingPlaybacks]
            .some(candidate => candidate.autoLevelEnabled && candidate.targets.includes(target));
        if (!stillNeeded) stopVoiceAnalysis(target, true);
    }

    for (const input of new Set(active.targets.map(target => target.input))) {
        updatePlaybackState(input);
    }
    notifyPlaybackState();
    if (error) active.reject(error);
    else active.resolve();
}

function cancelIfStale(active: Playback): boolean {
    if (isPlaybackCurrent(active)) return false;
    finishPlayback(active);
    return true;
}

function disposeMixedInput(stream: MediaStream, mixed: MixedInput): void {
    mixedInputs.delete(stream);
    stopVoiceAnalysis(mixed, true);
    mixed.source.disconnect();
    mixed.microphoneGain.disconnect();
    mixed.limiter.disconnect();
    for (const track of mixed.sourceStream.getTracks()) track.stop();
    for (const track of stream.getTracks()) track.stop();
}

export function mixInput(input: AudioInput, stream: MediaStream): MediaStream {
    const previous = [...mixedInputs.entries()].filter(([, mixed]) => mixed.input === input);
    const existing = previous.find(([, mixed]) => mixed.sourceStream === stream);
    if (existing) return existing[0];

    for (const active of [...playbacks, ...pendingPlaybacks]) {
        if (active.targets.some(target => target.input === input)) finishPlayback(active);
    }
    for (const [previousStream, mixed] of previous) disposeMixedInput(previousStream, mixed);

    const source = input.context.createMediaStreamSource(stream);
    const microphoneGain = input.context.createGain();
    const limiter = input.context.createDynamicsCompressor();
    const destination = input.context.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = "explicit";
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    source.connect(microphoneGain).connect(limiter).connect(destination);

    const mixed: MixedInput = {
        input,
        sourceStream: stream,
        source,
        voiceAnalyser: null,
        voiceSamples: null,
        voiceLevelDb: null,
        voiceTimer: null,
        microphoneGain,
        limiter,
        destination
    };
    mixedInputs.set(destination.stream, mixed);
    updateInputState(input);
    return destination.stream;
}

export function releaseInput(stream: MediaStream): void {
    const mixed = mixedInputs.get(stream);
    if (!mixed) return;

    for (const active of [...playbacks, ...pendingPlaybacks]) {
        if (active.targets.includes(mixed)) finishPlayback(active);
    }
    disposeMixedInput(stream, mixed);
}

export function shouldEnableInput(input: AudioInput): boolean {
    updateInputState(input);
    return isMicrophoneEnabled(input) || (!input.mute && isInputPlaying(input));
}

export function isInputPlaying(input: AudioInput): boolean {
    return playbacks.some(active => active.targets.some(target => target.input === input));
}

export function interceptSpeaking(input: AudioInput, speaking: boolean): boolean {
    if (!forcedSpeakingInputs.has(input)) {
        requestedSpeaking.set(input, speaking);
    }
    updateInputState(input);
    return !input.mute && (isInputPlaying(input) || speaking);
}

export function setSpeakingOnMuteChange(input: AudioInput): void {
    requestedSpeaking.set(input, false);
    updatePlaybackState(input);
}

export function hasVoiceInput(): boolean {
    return mixedInputs.size > 0;
}

export function stopSound(soundId?: string): void {
    for (const active of [...playbacks, ...pendingPlaybacks]) {
        if (soundId == null || active.soundId === soundId) finishPlayback(active);
    }
}

async function readAudioDuration(blob: Blob, signal: AbortSignal): Promise<number> {
    if (typeof Audio === "undefined") return 1;

    return new Promise((resolve, reject) => {
        const audio = new Audio();
        const url = URL.createObjectURL(blob);
        let settled = false;
        const timeout = globalThis.setTimeout(
            () => finish(new Error("Unable to read the audio file metadata.")),
            5_000
        );

        const cleanup = () => {
            globalThis.clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            audio.onerror = null;
            audio.onloadedmetadata = null;
            audio.removeAttribute("src");
            audio.load();
            URL.revokeObjectURL(url);
        };
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            const { duration } = audio;
            cleanup();
            if (error) reject(error);
            else resolve(duration);
        };
        const onAbort = () => finish(new DOMException("Playback cancelled.", "AbortError"));

        audio.preload = "metadata";
        audio.onerror = () => finish(new Error("The audio file cannot be read."));
        audio.onloadedmetadata = () => finish();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else audio.src = url;
    });
}

export async function playSound(
    sound: StoredSound,
    sendVolume: number,
    monitorVolume = sendVolume,
    autoLevel: AutoLevelOptions = { enabled: false, relativeDb: -6 }
): Promise<void> {
    validateAudioFileSize({ name: sound.fileName, size: sound.size });
    validateAudioFileSize({ name: sound.fileName, size: sound.blob.size });
    if (sound.size !== sound.blob.size || sound.blob.size > MAX_AUDIO_FILE_BYTES) {
        throw new Error(`The file “${sound.fileName}” is invalid or too large.`);
    }

    const targets = [...mixedInputs.values()];
    if (targets.length === 0) throw new Error("Join a voice channel before playing a sound.");
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    for (const { input } of targets) {
        const speaking = getRequestedSpeaking(input);
        requestedSpeaking.set(input, speaking);
    }
    const active: Playback = {
        controller,
        targets,
        sources: [],
        soundId: sound.id,
        objectUrl: null,
        levelTimer: null,
        timeout: null,
        trimTimer: null,
        failure: null,
        done,
        resolve,
        reject,
        sendCap: Math.max(0, Math.min(1, sendVolume)),
        autoLevelEnabled: autoLevel.enabled,
        relativeDb: autoLevel.relativeDb
    };
    pendingPlaybacks.add(active);
    const admission = reserveAdmission();

    try {
        let resumeTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all(targets.map(({ input }) => input.context.resume())),
                active.done,
                new Promise<never>((_, reject) => {
                    resumeTimeout = globalThis.setTimeout(
                        () => reject(new Error("The audio engine did not become ready in time.")),
                        5_000
                    );
                })
            ]);
        } finally {
            if (resumeTimeout != null) globalThis.clearTimeout(resumeTimeout);
        }
        if (cancelIfStale(active)) return;

        const duration = await readAudioDuration(sound.blob, controller.signal);
        if (cancelIfStale(active)) return;
        if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_DURATION_SECONDS) {
            throw new Error("The sound exceeds the allowed duration (2 minutes maximum).");
        }
        const trimStart = sound.trimStart ?? 0;
        const trimEnd = sound.trimEnd ?? duration;
        if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart >= duration
            || !Number.isFinite(trimEnd) || trimEnd <= trimStart || trimEnd > duration) {
            throw new Error("The saved trim range is outside this sound.");
        }
        const playbackDuration = trimEnd - trimStart;

        await Promise.race([admission.previous, active.done]);
        if (cancelIfStale(active)) return;
        for (const target of targets) {
            if (active.autoLevelEnabled) startVoiceAnalysis(target);
        }

        active.objectUrl = URL.createObjectURL(sound.blob);
        for (const [index, target] of targets.entries()) {
            if (cancelIfStale(active)) return;
            const { input, limiter } = target;
            const audio = new Audio(active.objectUrl);
            const source = input.context.createMediaElementSource(audio);
            const soundGain = input.context.createGain();
            const soundAnalyser = active.autoLevelEnabled ? input.context.createAnalyser() : null;
            if (soundAnalyser) soundAnalyser.fftSize = 2048;
            const soundSamples = soundAnalyser ? new Float32Array(soundAnalyser.fftSize) : null;
            const sendGain = input.context.createGain();
            const monitorGain = index === 0 ? input.context.createGain() : null;
            audio.preload = "auto";
            audio.currentTime = trimStart;
            soundGain.gain.value = Math.max(0, Math.min(2, sound.volume ?? 1));
            sendGain.gain.value = 0;
            source.connect(soundGain);
            if (soundAnalyser) soundGain.connect(soundAnalyser).connect(sendGain).connect(limiter);
            else soundGain.connect(sendGain).connect(limiter);
            if (monitorGain) {
                monitorGain.gain.value = 0;
                soundGain.connect(monitorGain).connect(input.context.destination);
            }
            audio.onended = () => finishPlayback(active);
            audio.onerror = () => finishPlayback(active, new Error("Media playback failed."));
            active.sources.push({ input, audio, source, soundGain, soundAnalyser, soundSamples, sendGain, monitorGain });
        }

        active.timeout = globalThis.setTimeout(
            () => finishPlayback(active, new Error("Playback timed out.")),
            (MAX_AUDIO_DURATION_SECONDS + 5) * 1_000
        );
        await Promise.race([
            Promise.all(active.sources.map(({ audio }) => audio.play())),
            active.done
        ]);
        if (cancelIfStale(active)) return;

        while (playbacks.length >= MAX_CONCURRENT_SOUNDS) {
            const oldest = playbacks[0];
            if (!oldest) break;
            finishPlayback(oldest);
        }
        pendingPlaybacks.delete(active);
        playbacks.push(active);
        for (const { monitorGain, sendGain } of active.sources) {
            if (!active.autoLevelEnabled) sendGain.gain.value = active.sendCap;
            if (monitorGain) monitorGain.gain.value = Math.max(0, Math.min(1, monitorVolume));
        }
        if (active.autoLevelEnabled) {
            if (active.levelTimer == null) {
                active.levelTimer = globalThis.setInterval(
                    () => updateAutoLevel(active, active.sendCap, active.relativeDb),
                    AUTO_LEVEL_INTERVAL_MS
                );
            }
        }
        for (const { input } of targets) {
            updateInputState(input);
            setPluginSpeaking(input, true);
        }
        notifyPlaybackState();
        admission.release();
        if (sound.trimEnd != null) {
            active.trimTimer = globalThis.setTimeout(() => finishPlayback(active), playbackDuration * 1_000);
        }
        await active.done;
    } catch (error) {
        if (active.failure) {
            logger.error("Unable to play the sound", active.failure);
            throw active.failure;
        }
        if (active.controller.signal.aborted || !isPlaybackCurrent(active)) return;
        finishPlayback(active);
        logger.error("Unable to play the sound", error);
        throw error;
    } finally {
        admission.release();
    }
}

export function shutdownAudio(): void {
    stopSound();
    for (const [stream, mixed] of mixedInputs) {
        disposeMixedInput(stream, mixed);
    }
}
