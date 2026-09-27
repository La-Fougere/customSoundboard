/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RestoredSound } from "./backup";
import {
    collectDirectImportFiles,
    collectSoundFiles,
    hashBlob,
    LibraryMergeResult,
    mergeLibraryFilesDeduplicated,
    moveStoredSound,
    normalizeStoredLibrary,
    removeStoredSound,
    SoundMetadataUpdate,
    StoredSound,
    toggleStoredSoundFavorite,
    updateStoredSoundMetadata,
    validateAudioFileContent,
    validateTrimRange
} from "./core";

export const LIBRARY_KEY = "CustomSoundboard_library_v1";
export const FOLDER_KEY = "CustomSoundboard_folder_v1";
export const IGNORED_FOLDER_HASHES_KEY = "CustomSoundboard_ignored_folder_hashes_v1";

export interface LibraryStorage {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
}

export type AudioFileValidator = (file: File) => Promise<number>;

interface PermissionCapableDirectoryHandle extends FileSystemDirectoryHandle {
    queryPermission(descriptor: { mode: "read" | "readwrite"; }): Promise<PermissionState>;
    requestPermission(descriptor: { mode: "read" | "readwrite"; }): Promise<PermissionState>;
}

export interface LibraryStore {
    clearLibrary(): Promise<void>;
    disconnectSoundboardFolder(): Promise<StoredSound[]>;
    getLibrary(): Promise<StoredSound[]>;
    getSound(id: string): Promise<StoredSound | null>;
    getSoundboardFolder(): Promise<FileSystemDirectoryHandle | null>;
    importFiles(files: Iterable<File>): Promise<LibraryMergeResult>;
    moveSound(draggedId: string, targetId: string): Promise<StoredSound[]>;
    refreshSoundboardFolder(requestedHandle?: FileSystemDirectoryHandle | null): Promise<StoredSound[]>;
    removeSound(id: string): Promise<StoredSound[]>;
    restoreImported(restored: RestoredSound[], mode: "add" | "replace"): Promise<LibraryMergeResult>;
    setSoundboardFolder(handle: FileSystemDirectoryHandle): Promise<StoredSound[]>;
    toggleFavorite(id: string): Promise<StoredSound[]>;
    updateSoundMetadata(id: string, update: SoundMetadataUpdate): Promise<StoredSound[]>;
}

async function ensurePermission(handle: FileSystemDirectoryHandle, mode: "read" | "readwrite"): Promise<void> {
    const permissionHandle = handle as PermissionCapableDirectoryHandle;
    if (typeof permissionHandle.queryPermission !== "function" || typeof permissionHandle.requestPermission !== "function") {
        throw new Error("Unable to verify access to the soundboard folder.");
    }

    const permission = await permissionHandle.queryPermission({ mode });
    if (permission !== "granted" && await permissionHandle.requestPermission({ mode }) !== "granted") {
        throw new Error("Access to the soundboard folder was denied.");
    }
}

export function createLibraryStore(
    storage: LibraryStorage,
    onChange: () => void = () => undefined,
    validateAudioFile: AudioFileValidator = validateAudioFileContent
): LibraryStore {
    let cache: StoredSound[] | null = null;
    let loadPromise: Promise<StoredSound[]> | null = null;
    let mutationTail = Promise.resolve();

    async function loadLibrary(): Promise<StoredSound[]> {
        if (cache) return cache;
        if (loadPromise) return loadPromise;

        loadPromise = (async () => {
            const raw = await storage.get<unknown>(LIBRARY_KEY);
            const normalized = normalizeStoredLibrary(raw);
            if (normalized.changed) await storage.set(LIBRARY_KEY, normalized.sounds);
            cache = normalized.sounds;
            return cache;
        })();

        try {
            return await loadPromise;
        } finally {
            loadPromise = null;
        }
    }

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = mutationTail.then(operation, operation);
        mutationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    function commit(sounds: StoredSound[]): StoredSound[] {
        cache = sounds;
        onChange();
        return sounds;
    }

    async function saveLibrary(sounds: StoredSound[]): Promise<StoredSound[]> {
        await storage.set(LIBRARY_KEY, sounds);
        return commit(sounds);
    }

    interface RelatedStorageChange {
        apply(): Promise<void>;
        rollback(): Promise<void>;
    }

    async function saveLibraryWithRelatedChanges(
        current: StoredSound[],
        next: StoredSound[],
        changes: readonly RelatedStorageChange[]
    ): Promise<StoredSound[]> {
        await storage.set(LIBRARY_KEY, next);
        const applied: RelatedStorageChange[] = [];
        try {
            for (const change of changes) {
                await change.apply();
                applied.push(change);
            }
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            for (const change of applied.reverse()) {
                try { await change.rollback(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            }
            try { await storage.set(LIBRARY_KEY, current); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            if (rollbackErrors.length > 0) {
                throw new AggregateError([error, ...rollbackErrors], "The change failed and its durable state could not be restored.");
            }
            throw error;
        }
        return commit(next);
    }

    async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
        const value = await storage.get<unknown>(FOLDER_KEY);
        if (!value || typeof value !== "object") return null;
        const handle = value as Partial<FileSystemDirectoryHandle>;
        return handle.kind === "directory" && typeof handle.values === "function"
            ? value as FileSystemDirectoryHandle
            : null;
    }

    async function loadIgnoredFolderHashes(): Promise<Set<string>> {
        const value = await storage.get<unknown>(IGNORED_FOLDER_HASHES_KEY);
        if (!Array.isArray(value)) return new Set();
        return new Set(value.filter((hash): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)));
    }

    async function writeIgnoredFolderHashes(hashes: ReadonlySet<string>): Promise<void> {
        if (hashes.size === 0) await storage.del(IGNORED_FOLDER_HASHES_KEY);
        else await storage.set(IGNORED_FOLDER_HASHES_KEY, [...hashes].sort());
    }

    async function saveLibraryAndIgnoredHashes(
        current: StoredSound[],
        next: StoredSound[],
        currentIgnored: ReadonlySet<string>,
        nextIgnored: ReadonlySet<string>
    ): Promise<StoredSound[]> {
        await storage.set(LIBRARY_KEY, next);
        try {
            await writeIgnoredFolderHashes(nextIgnored);
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            try { await storage.set(LIBRARY_KEY, current); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            try { await writeIgnoredFolderHashes(currentIgnored); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            if (rollbackErrors.length > 0) {
                throw new AggregateError([error, ...rollbackErrors], "The restore failed and its library state could not be rolled back.");
            }
            throw error;
        }
        return commit(next);
    }

    async function validateFiles(files: readonly File[]): Promise<Map<File, number>> {
        const durations = new Map<File, number>();
        for (const file of files) durations.set(file, await validateAudioFile(file));
        return durations;
    }

    return {
        getLibrary: loadLibrary,

        importFiles(files) {
            let snapshot: File[];
            try {
                snapshot = collectDirectImportFiles(files).files;
            } catch (error) {
                return Promise.reject(error);
            }
            return serialize(async () => {
                await validateFiles(snapshot);
                const current = await loadLibrary();
                const result = await mergeLibraryFilesDeduplicated(current, snapshot, "import");
                await saveLibrary(result.sounds);
                return result;
            });
        },

        moveSound(draggedId, targetId) {
            return serialize(async () => {
                const current = await loadLibrary();
                return saveLibrary(moveStoredSound(current, draggedId, targetId));
            });
        },

        removeSound(id) {
            return serialize(async () => {
                const current = await loadLibrary();
                return saveLibrary(removeStoredSound(current, id));
            });
        },

        restoreImported(restored, mode) {
            const snapshot = [...restored];
            return serialize(async () => {
                const durations = await validateFiles(snapshot.map(sound => sound.file));
                for (const sound of snapshot) {
                    validateTrimRange(sound.metadata.trimStart, sound.metadata.trimEnd, durations.get(sound.file)!);
                }
                const current = await loadLibrary();
                const folder = await loadFolder();
                const currentIgnored = folder ? await loadIgnoredFolderHashes() : new Set<string>();
                const currentFolderByHash = new Map<string, File>();
                const currentFolderFiles: File[] = [];
                if (folder) {
                    await ensurePermission(folder, "read");
                    for (const file of await collectSoundFiles(folder, currentIgnored)) {
                        currentFolderByHash.set(await hashBlob(file), file);
                        currentFolderFiles.push(file);
                    }
                }
                const base = mode === "replace"
                    ? []
                    : folder
                        ? (await mergeLibraryFilesDeduplicated(current, currentFolderFiles, "folder")).sounds
                        : current;
                const existingHashes = new Set<string>();
                for (const sound of base) {
                    existingHashes.add(sound.contentHash ?? await hashBlob(sound.blob));
                }
                const metadataByHash = new Map<string, RestoredSound["metadata"]>();
                const additions: RestoredSound[] = [];
                let duplicateCount = 0;
                for (const restoredSound of snapshot) {
                    const contentHash = restoredSound.metadata.contentHash ?? await hashBlob(restoredSound.file);
                    if (existingHashes.has(contentHash)) {
                        duplicateCount++;
                        continue;
                    }
                    existingHashes.add(contentHash);
                    const metadata = { ...restoredSound.metadata, contentHash };
                    metadataByHash.set(contentHash, metadata);
                    additions.push({ ...restoredSound, metadata });
                }

                const nextIgnored = new Set(currentIgnored);
                if (folder && mode === "replace") {
                    for (const contentHash of currentFolderByHash.keys()) nextIgnored.add(contentHash);
                    for (const sound of additions) nextIgnored.delete(sound.metadata.contentHash!);
                }
                const reusedFolderFiles: File[] = [];
                const importedFiles: File[] = [];
                for (const sound of additions) {
                    const existing = mode === "replace"
                        ? currentFolderByHash.get(sound.metadata.contentHash!)
                        : undefined;
                    if (existing) reusedFolderFiles.push(existing);
                    else importedFiles.push(sound.file);
                }

                const withFolder = await mergeLibraryFilesDeduplicated(base, reusedFolderFiles, "folder", {
                    replaceFolderEntries: false
                });
                const result = await mergeLibraryFilesDeduplicated(withFolder.sounds, importedFiles, "import", {
                    replaceFolderEntries: false
                });
                const existingIds = new Set(base.map(sound => sound.id));
                const sounds = result.sounds.map(sound => {
                    if (existingIds.has(sound.id) || !sound.contentHash) return sound;
                    const metadata = metadataByHash.get(sound.contentHash);
                    if (!metadata) return sound;
                    return {
                        ...sound,
                        name: metadata.name,
                        ...(metadata.customName ? { customName: metadata.customName } : {}),
                        ...(metadata.emoji ? { emoji: metadata.emoji } : {}),
                        ...(metadata.favorite ? { favorite: true } : {}),
                        order: mode === "replace" ? metadata.order : sound.order,
                        ...(metadata.trimEnd != null ? { trimEnd: metadata.trimEnd } : {}),
                        trimStart: metadata.trimStart,
                        volume: metadata.volume
                    };
                }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                    .map((sound, order) => ({ ...sound, order }));
                const saved = folder && mode === "replace"
                    ? await saveLibraryAndIgnoredHashes(current, sounds, currentIgnored, nextIgnored)
                    : await saveLibrary(sounds);
                return {
                    duplicateCount,
                    importedCount: withFolder.importedCount + result.importedCount,
                    sounds: saved
                };
            });
        },

        updateSoundMetadata(id, update) {
            return serialize(async () => {
                const current = await loadLibrary();
                const sound = current.find(candidate => candidate.id === id);
                if (!sound) throw new Error("The sound could not be found.");
                const duration = await validateAudioFile(new File([sound.blob], sound.fileName, {
                    type: sound.type || sound.blob.type
                }));
                validateTrimRange(update.trimStart ?? 0, update.trimEnd, duration);
                return saveLibrary(updateStoredSoundMetadata(current, id, update));
            });
        },

        clearLibrary() {
            return serialize(async () => {
                const current = await loadLibrary();
                const currentFolder = await loadFolder();
                const currentIgnored = await loadIgnoredFolderHashes();
                await saveLibraryWithRelatedChanges(current, [], [
                    {
                        apply: () => storage.del(FOLDER_KEY),
                        rollback: () => currentFolder ? storage.set(FOLDER_KEY, currentFolder) : storage.del(FOLDER_KEY)
                    },
                    {
                        apply: () => storage.del(IGNORED_FOLDER_HASHES_KEY),
                        rollback: () => writeIgnoredFolderHashes(currentIgnored)
                    }
                ]);
            });
        },

        getSoundboardFolder: loadFolder,

        setSoundboardFolder(handle) {
            return serialize(async () => {
                await ensurePermission(handle, "read");
                const files = await collectSoundFiles(handle);
                await validateFiles(files);
                const current = await loadLibrary();
                const currentFolder = await loadFolder();
                const currentIgnored = await loadIgnoredFolderHashes();
                const next = (await mergeLibraryFilesDeduplicated(current, files, "folder")).sounds;
                return saveLibraryWithRelatedChanges(current, next, [
                    {
                        apply: () => storage.set(FOLDER_KEY, handle),
                        rollback: () => currentFolder ? storage.set(FOLDER_KEY, currentFolder) : storage.del(FOLDER_KEY)
                    },
                    {
                        apply: () => storage.del(IGNORED_FOLDER_HASHES_KEY),
                        rollback: () => writeIgnoredFolderHashes(currentIgnored)
                    }
                ]);
            });
        },

        toggleFavorite(id) {
            return serialize(async () => {
                const current = await loadLibrary();
                return saveLibrary(toggleStoredSoundFavorite(current, id));
            });
        },

        refreshSoundboardFolder(requestedHandle) {
            return serialize(async () => {
                const handle = requestedHandle ?? await this.getSoundboardFolder();
                if (!handle) return loadLibrary();
                await ensurePermission(handle, "read");
                const ignored = await loadIgnoredFolderHashes();
                const files = await collectSoundFiles(handle, ignored);
                await validateFiles(files);
                const current = await loadLibrary();
                return saveLibrary((await mergeLibraryFilesDeduplicated(current, files, "folder")).sounds);
            });
        },

        disconnectSoundboardFolder() {
            return serialize(async () => {
                const current = await loadLibrary();
                const next = current.filter(sound => sound.source !== "folder");
                const currentFolder = await loadFolder();
                const currentIgnored = await loadIgnoredFolderHashes();
                return saveLibraryWithRelatedChanges(current, next, [
                    {
                        apply: () => storage.del(FOLDER_KEY),
                        rollback: () => currentFolder ? storage.set(FOLDER_KEY, currentFolder) : storage.del(FOLDER_KEY)
                    },
                    {
                        apply: () => storage.del(IGNORED_FOLDER_HASHES_KEY),
                        rollback: () => writeIgnoredFolderHashes(currentIgnored)
                    }
                ]);
            });
        },

        async getSound(id) {
            return (await loadLibrary()).find(sound => sound.id === id) ?? null;
        }
    };
}
