/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const AUDIO_EXTENSIONS = new Set([
    "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm"
]);

export const MAX_AUDIO_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 120;
export const MAX_LIBRARY_SOUNDS = 200;
export const MAX_LIBRARY_BYTES = 500 * 1024 * 1024;
export const MAX_DIRECT_IMPORT_ENTRIES = 1_000;
export const MAX_FOLDER_SCAN_ENTRIES = 5_000;
export const MAX_FOLDER_HASH_BYTES = 2 * MAX_LIBRARY_BYTES;
export const MAX_SOUND_FILE_NAME_LENGTH = 255;
export const MAX_SOUND_DISPLAY_NAME_LENGTH = MAX_SOUND_FILE_NAME_LENGTH + 16;
export const DISCORD_CHAT_EMOJI_INTENTION = 3;

export interface SoundEntry {
    fileName: string;
    name: string;
    size: number;
    type: string;
}

export type SoundSource = "import" | "folder";

export type SoundEmoji =
    | { type: "unicode"; value: string; }
    | { type: "custom"; id: string; name: string; animated: boolean; };

export interface SoundMetadataUpdate {
    name: string;
    emoji: SoundEmoji | null;
    trimEnd?: number | null;
    trimStart?: number;
    volume?: number;
}

export interface StoredSound extends SoundEntry {
    id: string;
    blob: Blob;
    source: SoundSource;
    contentHash?: string;
    customName?: string;
    emoji?: SoundEmoji;
    favorite?: boolean;
    order?: number;
    trimEnd?: number;
    trimStart?: number;
    volume?: number;
}

export interface LibraryMergeResult {
    duplicateCount: number;
    importedCount: number;
    sounds: StoredSound[];
}

export function chooseEmojiGuildId(voiceGuildId?: string, viewedGuildId?: string): string | undefined {
    return voiceGuildId ?? viewedGuildId;
}

export interface FileHandleLike {
    kind: "file";
    name: string;
    getFile(): Promise<File>;
}

export interface DirectoryLike {
    values(): AsyncIterableIterator<FileHandleLike | { kind: string; name: string; }>;
}

export interface NormalizedLibrary {
    changed: boolean;
    sounds: StoredSound[];
}

export function isSupportedAudioFile(file: Pick<File, "name" | "type">): boolean {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);
}

export function collectDirectImportFiles(files: Iterable<File>): { files: File[]; unsupportedCount: number; } {
    const supported: File[] = [];
    let entryCount = 0;
    let totalBytes = 0;
    let unsupportedCount = 0;

    for (const file of files) {
        entryCount++;
        if (entryCount > MAX_DIRECT_IMPORT_ENTRIES) {
            throw new Error(`A maximum of ${MAX_DIRECT_IMPORT_ENTRIES} files can be selected at once.`);
        }
        if (!isSupportedAudioFile(file)) {
            unsupportedCount++;
            continue;
        }
        if (supported.length >= MAX_LIBRARY_SOUNDS) {
            throw new Error(`The maximum number of sounds is ${MAX_LIBRARY_SOUNDS}.`);
        }

        validateAudioFileSize(file);
        totalBytes += file.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_LIBRARY_BYTES) {
            throw new Error("The selected audio files exceed 500 MiB in total.");
        }
        supported.push(file);
    }

    return { files: supported, unsupportedCount };
}

export function validateAudioFileSize(file: Pick<File, "name" | "size">): void {
    if (!file.name || file.name.length > MAX_SOUND_FILE_NAME_LENGTH || /[\\/]/.test(file.name)) {
        throw new Error(`The file “${file.name}” has an invalid name.`);
    }
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_AUDIO_FILE_BYTES) {
        throw new Error(`The file “${file.name}” is too large (20 MiB maximum).`);
    }
}

export async function validateAudioFileContent(file: File): Promise<number> {
    if (!isSupportedAudioFile(file)) throw new Error(`The file “${file.name}” is not a supported audio file.`);
    validateAudioFileSize(file);
    if (typeof Audio === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("Audio validation is unavailable in this client.");
    }

    return new Promise<number>((resolve, reject) => {
        const audio = new Audio();
        const url = URL.createObjectURL(file);
        let settled = false;
        const timeout = globalThis.setTimeout(
            () => finish(new Error("Unable to read the audio file metadata.")),
            5_000
        );
        const cleanup = () => {
            globalThis.clearTimeout(timeout);
            audio.onerror = null;
            audio.onloadedmetadata = null;
            audio.removeAttribute("src");
            audio.load();
            URL.revokeObjectURL(url);
        };
        const finish = (error?: Error, duration?: number) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(duration!);
        };

        audio.preload = "metadata";
        audio.onerror = () => finish(new Error(`The audio file “${file.name}” cannot be read.`));
        audio.onloadedmetadata = () => {
            if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
                finish(new Error(`The audio file “${file.name}” cannot be read.`));
            } else if (audio.duration > MAX_AUDIO_DURATION_SECONDS) {
                finish(new Error(`The audio file “${file.name}” exceeds the allowed duration (2 minutes maximum).`));
            } else {
                finish(undefined, audio.duration);
            }
        };
        audio.src = url;
    });
}

export function validateTrimRange(trimStart: number, trimEnd: number | null | undefined, duration: number): void {
    const effectiveEnd = trimEnd ?? duration;
    if (!Number.isFinite(duration) || duration <= 0
        || !Number.isFinite(trimStart) || trimStart < 0 || trimStart >= duration
        || !Number.isFinite(effectiveEnd) || effectiveEnd <= trimStart || effectiveEnd > duration) {
        throw new Error("The sound trim range is outside the audio duration.");
    }
}

export function validateLibraryLimits(sounds: readonly Pick<StoredSound, "fileName" | "size">[]): void {
    if (sounds.length > MAX_LIBRARY_SOUNDS) {
        throw new Error(`The maximum number of sounds is ${MAX_LIBRARY_SOUNDS}.`);
    }

    let total = 0;
    for (const sound of sounds) {
        validateAudioFileSize({ name: sound.fileName, size: sound.size });
        total += sound.size;
        if (!Number.isSafeInteger(total) || total > MAX_LIBRARY_BYTES) {
            throw new Error("The total library size exceeds 500 MiB.");
        }
    }
}

function baseName(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, "");
}

function fileToSound(file: File, names: Map<string, number>): SoundEntry {
    validateAudioFileSize(file);
    const base = baseName(file.name);
    const normalizedName = base.toLocaleLowerCase();
    const duplicateNumber = (names.get(normalizedName) ?? 0) + 1;
    names.set(normalizedName, duplicateNumber);

    return {
        fileName: file.name,
        name: duplicateNumber === 1 ? base : `${base} (${duplicateNumber})`,
        size: file.size,
        type: file.type
    };
}

export function importSoundFiles(files: Iterable<File>): SoundEntry[] {
    const names = new Map<string, number>();
    const sounds = [...files]
        .filter(isSupportedAudioFile)
        .map(file => fileToSound(file, names));
    validateLibraryLimits(sounds.map(sound => ({ ...sound, id: "", blob: new Blob(), source: "import" as const })));
    return sounds;
}

function soundIdBase(file: Pick<File, "lastModified" | "name" | "size">, source: SoundSource): string {
    return `${source}:${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
}

function uniqueId(base: string, usedIds: Set<string>): string {
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}#${suffix++}`;
    usedIds.add(id);
    return id;
}

function disambiguateNames(sounds: StoredSound[]): StoredSound[] {
    const names = new Map<string, number>();
    return sounds.map(sound => {
        const base = baseName(sound.fileName);
        const normalizedName = base.toLocaleLowerCase();
        const duplicateNumber = (names.get(normalizedName) ?? 0) + 1;
        names.set(normalizedName, duplicateNumber);
        const name = sound.customName ?? (duplicateNumber === 1 ? base : `${base} (${duplicateNumber})`);
        return sound.name === name ? sound : { ...sound, name };
    });
}

function isSoundEmoji(value: unknown): value is SoundEmoji {
    if (!value || typeof value !== "object") return false;
    const emoji = value as Partial<SoundEmoji>;
    if (emoji.type === "unicode") {
        return typeof emoji.value === "string" && emoji.value.length > 0 && emoji.value.length <= 64;
    }
    return emoji.type === "custom"
        && typeof emoji.id === "string"
        && /^\d{15,25}$/.test(emoji.id)
        && typeof emoji.name === "string"
        && emoji.name.length > 0
        && emoji.name.length <= 64
        && typeof emoji.animated === "boolean";
}

export function normalizeDiscordEmoji(value: unknown): SoundEmoji | null {
    if (!value || typeof value !== "object") return null;
    const emoji = value as { id?: unknown; name?: unknown; animated?: unknown; surrogates?: unknown; };
    if (emoji.id == null) {
        const unicode = typeof emoji.surrogates === "string" ? emoji.surrogates : emoji.name;
        return typeof unicode === "string" && unicode.length > 0 && unicode.length <= 64
            ? { type: "unicode", value: unicode }
            : null;
    }
    return typeof emoji.id === "string"
        && /^\d{15,25}$/.test(emoji.id)
        && typeof emoji.name === "string"
        && emoji.name.length > 0
        && emoji.name.length <= 64
        ? { type: "custom", id: emoji.id, name: emoji.name, animated: emoji.animated === true }
        : null;
}

export function normalizeDiscordCdnEmoji(source: string, alt: string): SoundEmoji | null {
    const sourceMatch = source.match(/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/(\d{15,25})\.(gif|png|webp)(?:\?|$)/i);
    const nameMatch = alt.match(/^:([^:]{1,64}):/);
    if (!sourceMatch || !nameMatch) return null;
    return {
        type: "custom",
        id: sourceMatch[1],
        name: nameMatch[1],
        animated: sourceMatch[2].toLowerCase() === "gif" || /[?&]animated=true(?:&|$)/i.test(source)
    };
}

export function updateStoredSoundMetadata(
    sounds: StoredSound[],
    id: string,
    update: SoundMetadataUpdate
): StoredSound[] {
    const name = update.name.trim();
    if (!name || name.length > 80) throw new Error("Sound name must contain between 1 and 80 characters.");
    if (update.emoji != null && !isSoundEmoji(update.emoji)) throw new Error("The selected emoji is invalid.");
    const volume = update.volume ?? 1;
    const trimStart = update.trimStart ?? 0;
    const trimEnd = update.trimEnd ?? null;
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) {
        throw new Error("Sound volume must be between 0% and 200%.");
    }
    if (!Number.isFinite(trimStart) || trimStart < 0
        || (trimEnd != null && (!Number.isFinite(trimEnd) || trimEnd <= trimStart))) {
        throw new Error("The sound trim range is invalid.");
    }

    let found = false;
    const next = sounds.map(sound => {
        if (sound.id !== id) return sound;
        found = true;
        const updated: StoredSound = { ...sound, name, customName: name, trimStart, volume };
        if (update.emoji) updated.emoji = update.emoji;
        else delete updated.emoji;
        if (trimEnd == null) delete updated.trimEnd;
        else updated.trimEnd = trimEnd;
        return updated;
    });
    if (!found) throw new Error("The sound could not be found.");
    return next;
}

function orderedSounds(sounds: readonly StoredSound[]): StoredSound[] {
    return [...sounds].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

function normalizeOrders(sounds: readonly StoredSound[]): StoredSound[] {
    return orderedSounds(sounds).map((sound, order) => sound.order === order ? sound : { ...sound, order });
}

export function selectVisibleSounds(sounds: readonly StoredSound[], query: string): StoredSound[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizeOrders(sounds)
        .filter(sound => !normalizedQuery
            || sound.name.toLocaleLowerCase().includes(normalizedQuery)
            || sound.fileName.toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (a.order ?? 0) - (b.order ?? 0));
}

export function toggleStoredSoundFavorite(sounds: StoredSound[], id: string): StoredSound[] {
    let found = false;
    const next = sounds.map(sound => {
        if (sound.id !== id) return sound;
        found = true;
        return { ...sound, favorite: !sound.favorite };
    });
    if (!found) throw new Error("The sound could not be found.");
    return next;
}

export function moveStoredSound(sounds: StoredSound[], draggedId: string, targetId: string): StoredSound[] {
    const ordered = normalizeOrders(sounds);
    const from = ordered.findIndex(sound => sound.id === draggedId);
    const to = ordered.findIndex(sound => sound.id === targetId);
    if (from < 0 || to < 0) throw new Error("The sound could not be found.");
    if (from === to) return ordered;
    const [dragged] = ordered.splice(from, 1);
    ordered.splice(to, 0, dragged);
    return ordered.map((sound, order) => ({ ...sound, order }));
}

const blobHashCache = new WeakMap<Blob, string>();

export async function hashBlob(blob: Blob): Promise<string> {
    const cached = blobHashCache.get(blob);
    if (cached) return cached;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    blobHashCache.set(blob, hash);
    return hash;
}

function preservedMetadata(previous: StoredSound | undefined): Partial<StoredSound> {
    if (!previous) return {};
    return {
        ...(previous.customName ? { customName: previous.customName, name: previous.customName } : {}),
        ...(previous.emoji ? { emoji: previous.emoji } : {}),
        ...(previous.favorite ? { favorite: true } : {}),
        ...(previous.volume != null ? { volume: previous.volume } : {}),
        ...(previous.trimStart != null ? { trimStart: previous.trimStart } : {}),
        ...(previous.trimEnd != null ? { trimEnd: previous.trimEnd } : {}),
        ...(previous.order != null ? { order: previous.order } : {})
    };
}

export async function mergeLibraryFilesDeduplicated(
    existing: StoredSound[],
    files: Iterable<File>,
    source: SoundSource,
    options: { replaceFolderEntries?: boolean; } = {}
): Promise<LibraryMergeResult> {
    const replaceFolderEntries = source === "folder" && options.replaceFolderEntries !== false;
    const previousFolderSounds = new Map<string, StoredSound>();
    if (replaceFolderEntries) {
        for (const sound of existing.filter(sound => sound.source === "folder")) {
            const contentHash = sound.contentHash ?? await hashBlob(sound.blob);
            if (!previousFolderSounds.has(contentHash)) previousFolderSounds.set(contentHash, sound);
        }
    }
    const kept = replaceFolderEntries ? existing.filter(sound => sound.source !== "folder") : [...existing];
    const hydrated = await Promise.all(kept.map(async sound => sound.contentHash
        ? sound
        : { ...sound, contentHash: await hashBlob(sound.blob) }));
    const hashes = new Set(hydrated.map(sound => sound.contentHash!));
    const usedIds = new Set(hydrated.map(sound => sound.id));
    let totalBytes = hydrated.reduce((total, sound) => total + sound.size, 0);
    let nextOrder = Math.max(-1, ...existing.map(sound => sound.order ?? -1)) + 1;
    let duplicateCount = 0;
    const additions: StoredSound[] = [];

    for (const file of files) {
        if (!isSupportedAudioFile(file)) continue;
        validateAudioFileSize(file);
        const contentHash = await hashBlob(file);
        if (hashes.has(contentHash)) {
            duplicateCount++;
            continue;
        }
        if (hydrated.length + additions.length >= MAX_LIBRARY_SOUNDS) {
            throw new Error(`The maximum number of sounds is ${MAX_LIBRARY_SOUNDS}.`);
        }
        totalBytes += file.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_LIBRARY_BYTES) {
            throw new Error("The total library size exceeds 500 MiB.");
        }
        hashes.add(contentHash);
        const previous = previousFolderSounds.get(contentHash);
        const id = uniqueId(previous?.id ?? soundIdBase(file, source), usedIds);
        additions.push({
            ...fileToSound(file, new Map()),
            id,
            blob: file,
            source,
            contentHash,
            order: previous?.order ?? nextOrder++,
            ...preservedMetadata(previous)
        });
    }

    const sounds = normalizeOrders(disambiguateNames([...hydrated, ...additions]));
    validateLibraryLimits(sounds);
    return { duplicateCount, importedCount: additions.length, sounds };
}

export function mergeLibraryFiles(
    existing: StoredSound[],
    files: Iterable<File>,
    source: SoundSource
): StoredSound[] {
    const previousFolderSounds = source === "folder"
        ? new Map(existing.filter(sound => sound.source === "folder").map(sound => [sound.id, sound]))
        : new Map<string, StoredSound>();
    const kept = source === "folder" ? existing.filter(sound => sound.source !== "folder") : [...existing];
    const usedIds = new Set(kept.map(sound => sound.id));
    const additions = [...files]
        .filter(isSupportedAudioFile)
        .map(file => {
            const id = uniqueId(soundIdBase(file, source), usedIds);
            const previous = previousFolderSounds.get(id);
            return {
                ...fileToSound(file, new Map()),
                id,
                blob: file as Blob,
                source,
                ...(previous?.customName ? { customName: previous.customName, name: previous.customName } : {}),
                ...(previous?.emoji ? { emoji: previous.emoji } : {})
            };
        });

    const merged = disambiguateNames([...kept, ...additions])
        .sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base", numeric: true }));
    validateLibraryLimits(merged);
    return merged;
}

export function removeStoredSound(sounds: StoredSound[], id: string): StoredSound[] {
    return disambiguateNames(sounds.filter(sound => sound.id !== id));
}

function isBlobLike(value: unknown): value is Blob {
    if (!value || typeof value !== "object") return false;
    const blob = value as Partial<Blob>;
    return typeof blob.arrayBuffer === "function"
        && typeof blob.size === "number"
        && Number.isFinite(blob.size)
        && typeof blob.type === "string";
}

export function normalizeStoredLibrary(value: unknown): NormalizedLibrary {
    if (!Array.isArray(value)) return { changed: value != null, sounds: [] };

    let changed = false;
    let total = 0;
    const usedIds = new Set<string>();
    const sounds: StoredSound[] = [];

    for (const raw of value) {
        if (!raw || typeof raw !== "object") {
            changed = true;
            continue;
        }

        const candidate = raw as Partial<StoredSound>;
        if (typeof candidate.fileName !== "string" || candidate.fileName.length === 0
            || !isBlobLike(candidate.blob)
            || (candidate.source !== "import" && candidate.source !== "folder")) {
            changed = true;
            continue;
        }

        const type = typeof candidate.type === "string" ? candidate.type : candidate.blob.type;
        const { size } = candidate.blob;
        if (!isSupportedAudioFile({ name: candidate.fileName, type })
            || size > MAX_AUDIO_FILE_BYTES
            || sounds.length >= MAX_LIBRARY_SOUNDS
            || total + size > MAX_LIBRARY_BYTES) {
            changed = true;
            continue;
        }

        const requestedId = typeof candidate.id === "string" && candidate.id.length > 0
            ? candidate.id
            : `${candidate.source}:${encodeURIComponent(candidate.fileName)}:${size}:migrated`;
        const id = uniqueId(requestedId, usedIds);
        const sound: StoredSound = {
            id,
            blob: candidate.blob,
            fileName: candidate.fileName,
            name: typeof candidate.name === "string" ? candidate.name : baseName(candidate.fileName),
            size,
            source: candidate.source,
            type,
            order: Number.isSafeInteger(candidate.order) && candidate.order! >= 0 ? candidate.order : sounds.length
        };
        if (sound.order !== candidate.order) changed = true;
        if (typeof candidate.contentHash === "string" && /^[a-f0-9]{64}$/.test(candidate.contentHash)) {
            sound.contentHash = candidate.contentHash;
        } else if (candidate.contentHash != null) changed = true;
        if (candidate.favorite === true) sound.favorite = true;
        else if (candidate.favorite != null && candidate.favorite !== false) changed = true;
        if (candidate.volume != null) {
            if (Number.isFinite(candidate.volume) && candidate.volume >= 0 && candidate.volume <= 2) sound.volume = candidate.volume;
            else changed = true;
        }
        if (candidate.trimStart != null) {
            if (Number.isFinite(candidate.trimStart) && candidate.trimStart >= 0) sound.trimStart = candidate.trimStart;
            else changed = true;
        }
        if (candidate.trimEnd != null) {
            if (Number.isFinite(candidate.trimEnd) && candidate.trimEnd > (sound.trimStart ?? 0)) sound.trimEnd = candidate.trimEnd;
            else changed = true;
        }
        if (typeof candidate.customName === "string") {
            const customName = candidate.customName.trim();
            if (customName && customName.length <= 80) {
                sound.customName = customName;
                sound.name = customName;
            } else {
                changed = true;
            }
        }
        if (candidate.emoji != null) {
            if (isSoundEmoji(candidate.emoji)) sound.emoji = candidate.emoji;
            else changed = true;
        }
        if (id !== candidate.id || size !== candidate.size || type !== candidate.type) changed = true;
        total += size;
        sounds.push(sound);
    }

    const named = normalizeOrders(disambiguateNames(sounds));
    if (named.some((sound, index) => sound !== sounds[index])) changed = true;
    return { changed, sounds: named };
}

export async function collectSoundFiles(
    directory: DirectoryLike,
    ignoredContentHashes: ReadonlySet<string> = new Set()
): Promise<File[]> {
    const files: File[] = [];
    const contentHashes = new Set<string>();
    let scannedEntries = 0;
    let hashedBytes = 0;
    let totalSize = 0;

    for await (const entry of directory.values()) {
        scannedEntries++;
        if (scannedEntries > MAX_FOLDER_SCAN_ENTRIES) {
            throw new Error(`The folder contains more than ${MAX_FOLDER_SCAN_ENTRIES} entries.`);
        }
        if (entry.kind !== "file") continue;
        const file = await (entry as FileHandleLike).getFile();
        if (!isSupportedAudioFile(file)) continue;
        validateAudioFileSize(file);
        hashedBytes += file.size;
        if (!Number.isSafeInteger(hashedBytes) || hashedBytes > MAX_FOLDER_HASH_BYTES) {
            throw new Error("The folder requires hashing more than 1000 MiB of audio.");
        }
        const contentHash = await hashBlob(file);
        if (ignoredContentHashes.has(contentHash) || contentHashes.has(contentHash)) continue;
        contentHashes.add(contentHash);
        if (files.length >= MAX_LIBRARY_SOUNDS) {
            throw new Error(`The maximum number of sounds is ${MAX_LIBRARY_SOUNDS}.`);
        }
        totalSize += file.size;
        if (!Number.isSafeInteger(totalSize) || totalSize > MAX_LIBRARY_BYTES) {
            throw new Error("The total library size exceeds 500 MiB.");
        }
        files.push(file);
    }

    return files;
}

export async function scanSoundFiles(directory: DirectoryLike): Promise<SoundEntry[]> {
    const files = await collectSoundFiles(directory);
    files.sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }));
    return importSoundFiles(files);
}

export function shouldInjectPanelButton(replaceNativeSoundboard: boolean): boolean {
    return !replaceNativeSoundboard;
}

export interface SinglePlaybackController {
    play(sound: SoundEntry): Promise<void>;
    stop(): void;
}

export function createSinglePlaybackController(
    start: (sound: SoundEntry, signal: AbortSignal) => Promise<void>
): SinglePlaybackController {
    let active: AbortController | null = null;

    return {
        async play(sound) {
            active?.abort();
            const controller = new AbortController();
            active = controller;
            try {
                await start(sound, controller.signal);
            } finally {
                if (active === controller) active = null;
            }
        },
        stop() {
            active?.abort();
            active = null;
        }
    };
}
