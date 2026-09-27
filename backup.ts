/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strToU8, Unzip, type UnzipFile, UnzipInflate, Zip, ZipPassThrough } from "fflate";

import {
    hashBlob,
    isSupportedAudioFile,
    MAX_AUDIO_FILE_BYTES,
    MAX_LIBRARY_BYTES,
    MAX_LIBRARY_SOUNDS,
    MAX_SOUND_DISPLAY_NAME_LENGTH,
    MAX_SOUND_FILE_NAME_LENGTH,
    SoundEmoji,
    StoredSound,
    validateAudioFileSize
} from "./core";

const MANIFEST_PATH = "manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_LIBRARY_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024;

export interface BackupSoundMetadata {
    contentHash: string;
    customName?: string;
    emoji?: SoundEmoji;
    favorite?: boolean;
    name: string;
    order: number;
    trimEnd?: number;
    trimStart: number;
    type: string;
    volume: number;
}

interface BackupManifestSound {
    fileName: string;
    metadata: BackupSoundMetadata;
    path: string;
}

interface BackupManifest {
    sounds: BackupManifestSound[];
    version: 1;
}

export interface RestoredSound {
    file: File;
    metadata: BackupSoundMetadata;
}

interface ArchiveSource {
    blob: Blob;
    path: string;
}

function zipArchive(files: readonly ArchiveSource[]): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const chunks: ArrayBuffer[] = [];
        let outputSize = 0;
        let settled = false;
        const archive = new Zip((error, chunk, final) => {
            if (settled) return;
            if (error) {
                settled = true;
                reject(error);
                return;
            }
            outputSize += chunk.length;
            if (!Number.isSafeInteger(outputSize) || outputSize > MAX_ARCHIVE_BYTES) {
                settled = true;
                archive.terminate();
                reject(new Error("The backup archive is too large."));
                return;
            }
            if (chunk.length > 0) {
                const copy = new Uint8Array(chunk.length);
                copy.set(chunk);
                chunks.push(copy.buffer);
            }
            if (final) {
                settled = true;
                resolve(new Blob(chunks, { type: "application/zip" }));
            }
        });

        void (async () => {
            try {
                for (const file of files) {
                    if (settled) return;
                    const entry = new ZipPassThrough(file.path);
                    archive.add(entry);
                    const reader = file.blob.stream().getReader();
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            entry.push(value ?? new Uint8Array(), done);
                            if (done) break;
                        }
                    } finally {
                        reader.releaseLock();
                    }
                }
                archive.end();
            } catch (error) {
                if (!settled) {
                    settled = true;
                    archive.terminate();
                    reject(error);
                }
            }
        })();
    });
}

function isSafeArchivePath(path: string): boolean {
    return path.length > 0
        && path.length <= 256
        && !path.startsWith("/")
        && !path.includes("\\")
        && !path.includes("\0")
        && path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

type UnzipFactory = (handler: NonNullable<ConstructorParameters<typeof Unzip>[0]>) => Unzip;

export function unzipArchive(
    file: File,
    createArchive: UnzipFactory = handler => new Unzip(handler)
): Promise<Map<string, Blob>> {
    return new Promise((resolve, reject) => {
        const files = new Map<string, Blob>();
        const seenNames = new Set<string>();
        let actualTotalSize = 0;
        let declaredTotalSize = 0;
        let entryCount = 0;
        let pendingEntries = 0;
        let inputFinished = false;
        let settled = false;
        const activeEntries = new Set<UnzipFile>();

        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            for (const entry of activeEntries) {
                try { entry.terminate(); } catch { }
            }
            activeEntries.clear();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const finishIfReady = () => {
            if (!settled && inputFinished && pendingEntries === 0) {
                settled = true;
                resolve(files);
            }
        };
        const archive = createArchive(entry => {
            if (settled) {
                entry.terminate();
                return;
            }
            activeEntries.add(entry);
            try {
                if (!isSafeArchivePath(entry.name)) throw new Error("The backup archive contains an unsafe path.");
                if (seenNames.has(entry.name)) throw new Error("The backup archive contains duplicate file names.");
                seenNames.add(entry.name);
                entryCount++;
                if (entryCount > MAX_LIBRARY_SOUNDS + 1) throw new Error("The backup archive contains too many files.");
                const maximum = entry.name === MANIFEST_PATH ? MAX_MANIFEST_BYTES : MAX_AUDIO_FILE_BYTES;
                if (entry.originalSize != null) {
                    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > maximum) {
                        throw new Error("The backup archive contains an oversized file.");
                    }
                    declaredTotalSize += entry.originalSize;
                    if (!Number.isSafeInteger(declaredTotalSize) || declaredTotalSize > MAX_ARCHIVE_BYTES) {
                        throw new Error("The backup archive is too large.");
                    }
                }

                const chunks: ArrayBuffer[] = [];
                let entrySize = 0;
                pendingEntries++;
                entry.ondata = (error, chunk, final) => {
                    if (settled) return;
                    if (error) {
                        fail(error);
                        return;
                    }
                    entrySize += chunk.length;
                    actualTotalSize += chunk.length;
                    if (!Number.isSafeInteger(entrySize) || entrySize > maximum) {
                        fail(new Error("The backup archive contains an oversized file."));
                        return;
                    }
                    if (!Number.isSafeInteger(actualTotalSize) || actualTotalSize > MAX_ARCHIVE_BYTES) {
                        fail(new Error("The backup archive is too large."));
                        return;
                    }
                    if (chunk.length > 0) {
                        const copy = new Uint8Array(chunk.length);
                        copy.set(chunk);
                        chunks.push(copy.buffer);
                    }
                    if (final) {
                        activeEntries.delete(entry);
                        files.set(entry.name, new Blob(chunks));
                        pendingEntries--;
                        finishIfReady();
                    }
                };
                entry.start();
            } catch (error) {
                fail(error);
            }
        });
        archive.register(UnzipInflate);

        void (async () => {
            const reader = file.stream().getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (settled) {
                        await reader.cancel();
                        return;
                    }
                    archive.push(value ?? new Uint8Array(), done);
                    if (done) {
                        inputFinished = true;
                        finishIfReady();
                        return;
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                reader.releaseLock();
            }
        })();
    });
}

function archiveExtension(fileName: string): string {
    const extension = fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
    return extension ? `.${extension}` : ".audio";
}

function validEmoji(value: unknown): value is SoundEmoji {
    if (!value || typeof value !== "object") return false;
    const emoji = value as Partial<SoundEmoji>;
    if (emoji.type === "unicode") return typeof emoji.value === "string" && emoji.value.length > 0 && emoji.value.length <= 64;
    return emoji.type === "custom"
        && typeof emoji.id === "string"
        && /^\d{15,25}$/.test(emoji.id)
        && typeof emoji.name === "string"
        && emoji.name.length > 0
        && emoji.name.length <= 64
        && typeof emoji.animated === "boolean";
}

function parseMetadata(value: unknown): BackupSoundMetadata {
    if (!value || typeof value !== "object") throw new Error("The backup manifest contains invalid sound metadata.");
    const candidate = value as Partial<BackupSoundMetadata>;
    if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > MAX_SOUND_DISPLAY_NAME_LENGTH
        || typeof candidate.type !== "string"
        || !Number.isSafeInteger(candidate.order) || candidate.order! < 0
        || !Number.isFinite(candidate.volume) || candidate.volume! < 0 || candidate.volume! > 2
        || !Number.isFinite(candidate.trimStart) || candidate.trimStart! < 0
        || (candidate.trimEnd != null && (!Number.isFinite(candidate.trimEnd) || candidate.trimEnd <= candidate.trimStart!))) {
        throw new Error("The backup manifest contains invalid sound metadata.");
    }
    if (typeof candidate.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.contentHash)) {
        throw new Error("The backup manifest contains an invalid audio hash.");
    }
    if (candidate.customName != null && (typeof candidate.customName !== "string" || !candidate.customName.trim() || candidate.customName.length > 80)) {
        throw new Error("The backup manifest contains an invalid custom name.");
    }
    if (candidate.emoji != null && !validEmoji(candidate.emoji)) throw new Error("The backup manifest contains an invalid emoji.");
    if (candidate.favorite != null && typeof candidate.favorite !== "boolean") throw new Error("The backup manifest contains an invalid favorite flag.");

    return {
        contentHash: candidate.contentHash,
        ...(candidate.customName ? { customName: candidate.customName } : {}),
        ...(candidate.emoji ? { emoji: candidate.emoji } : {}),
        ...(candidate.favorite ? { favorite: true } : {}),
        name: candidate.name.trim(),
        order: candidate.order!,
        ...(candidate.trimEnd != null ? { trimEnd: candidate.trimEnd } : {}),
        trimStart: candidate.trimStart!,
        type: candidate.type,
        volume: candidate.volume!
    };
}

export async function createSoundboardBackup(sounds: readonly StoredSound[]): Promise<Blob> {
    if (sounds.length > MAX_LIBRARY_SOUNDS) throw new Error("The soundboard contains too many sounds to export.");
    const files: ArchiveSource[] = [];
    const manifest: BackupManifest = { version: 1, sounds: [] };
    let total = 0;

    for (const [index, sound] of sounds.entries()) {
        validateAudioFileSize({ name: sound.fileName, size: sound.blob.size });
        total += sound.blob.size;
        if (!Number.isSafeInteger(total) || total > MAX_LIBRARY_BYTES) throw new Error("The soundboard is too large to export.");
        const path = `sounds/${index.toString().padStart(4, "0")}${archiveExtension(sound.fileName)}`;
        const contentHash = await hashBlob(sound.blob);
        files.push({ blob: sound.blob, path });
        manifest.sounds.push({
            fileName: sound.fileName,
            path,
            metadata: {
                contentHash,
                ...(sound.customName ? { customName: sound.customName } : {}),
                ...(sound.emoji ? { emoji: sound.emoji } : {}),
                ...(sound.favorite ? { favorite: true } : {}),
                name: sound.name,
                order: sound.order ?? index,
                ...(sound.trimEnd != null ? { trimEnd: sound.trimEnd } : {}),
                trimStart: sound.trimStart ?? 0,
                type: sound.type || sound.blob.type,
                volume: sound.volume ?? 1
            }
        });
    }

    const manifestBytes = strToU8(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("The backup manifest is too large.");
    files.push({ blob: new Blob([manifestBytes], { type: "application/json" }), path: MANIFEST_PATH });
    return zipArchive(files);
}

export async function readSoundboardBackup(file: File): Promise<RestoredSound[]> {
    if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) throw new Error("The backup archive is empty or too large.");
    const files = await unzipArchive(file);
    const manifestBlob = files.get(MANIFEST_PATH);
    if (!manifestBlob || manifestBlob.size > MAX_MANIFEST_BYTES) throw new Error("The backup manifest is missing or invalid.");

    let rawManifest: unknown;
    try {
        rawManifest = JSON.parse(await manifestBlob.text());
    } catch {
        throw new Error("The backup manifest is not valid JSON.");
    }
    if (!rawManifest || typeof rawManifest !== "object") throw new Error("The backup manifest is invalid.");
    const candidate = rawManifest as Partial<BackupManifest>;
    if (candidate.version !== 1 || !Array.isArray(candidate.sounds) || candidate.sounds.length > MAX_LIBRARY_SOUNDS) {
        throw new Error("The backup manifest version or sound list is invalid.");
    }

    const allowedPaths = new Set([MANIFEST_PATH]);
    const restored: RestoredSound[] = [];
    let total = 0;
    for (const rawSound of candidate.sounds) {
        if (!rawSound || typeof rawSound !== "object") throw new Error("The backup manifest contains an invalid sound.");
        const entry = rawSound as Partial<BackupManifestSound>;
        if (typeof entry.path !== "string" || !isSafeArchivePath(entry.path) || !entry.path.startsWith("sounds/")
            || typeof entry.fileName !== "string" || !entry.fileName || entry.fileName.length > MAX_SOUND_FILE_NAME_LENGTH
            || entry.fileName.includes("/") || entry.fileName.includes("\\")
            || allowedPaths.has(entry.path)) {
            throw new Error("The backup manifest contains an invalid archive path.");
        }
        const payload = files.get(entry.path);
        if (!payload) throw new Error("The backup archive is missing an audio file.");
        allowedPaths.add(entry.path);
        const metadata = parseMetadata(entry.metadata);
        const restoredFile = new File([payload], entry.fileName, { type: metadata.type });
        if (!isSupportedAudioFile(restoredFile)) throw new Error("The backup contains an unsupported audio file.");
        validateAudioFileSize(restoredFile);
        total += restoredFile.size;
        if (!Number.isSafeInteger(total) || total > MAX_LIBRARY_BYTES) throw new Error("The restored soundboard exceeds 500 MiB.");
        const actualHash = await hashBlob(restoredFile);
        if (metadata.contentHash !== actualHash) throw new Error("The backup audio hash does not match its manifest.");
        restored.push({ file: restoredFile, metadata });
    }

    if ([...files.keys()].some(path => !allowedPaths.has(path))) {
        throw new Error("The backup archive contains unlisted files.");
    }
    return restored.sort((a, b) => a.metadata.order - b.metadata.order);
}
