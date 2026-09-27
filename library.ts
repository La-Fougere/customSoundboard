/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { del, get, set } from "@api/DataStore";

import { createSoundboardBackup, readSoundboardBackup } from "./backup";
import { type LibraryMergeResult, type SoundMetadataUpdate, type StoredSound,validateAudioFileContent } from "./core";
import { createLibraryStore } from "./libraryStore";

const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

const store = createLibraryStore({
    del,
    get,
    set
}, notify, validateAudioFileContent);

export function subscribeLibrary(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getLibrary(): Promise<StoredSound[]> {
    return store.getLibrary();
}

export function importFiles(files: Iterable<File>): Promise<LibraryMergeResult> {
    return store.importFiles(files);
}

export async function createBackup(): Promise<Blob> {
    return createSoundboardBackup(await store.getLibrary());
}

export async function restoreBackup(file: File, mode: "add" | "replace"): Promise<LibraryMergeResult> {
    return store.restoreImported(await readSoundboardBackup(file), mode);
}

export function removeSound(id: string): Promise<StoredSound[]> {
    return store.removeSound(id);
}

export function updateSoundMetadata(id: string, update: SoundMetadataUpdate): Promise<StoredSound[]> {
    return store.updateSoundMetadata(id, update);
}

export function toggleFavorite(id: string): Promise<StoredSound[]> {
    return store.toggleFavorite(id);
}

export function moveSound(draggedId: string, targetId: string): Promise<StoredSound[]> {
    return store.moveSound(draggedId, targetId);
}

export function clearLibrary(): Promise<void> {
    return store.clearLibrary();
}

export function getSoundboardFolder(): Promise<FileSystemDirectoryHandle | null> {
    return store.getSoundboardFolder();
}

export function setSoundboardFolder(handle: FileSystemDirectoryHandle): Promise<StoredSound[]> {
    return store.setSoundboardFolder(handle);
}

export function refreshSoundboardFolder(
    requestedHandle?: FileSystemDirectoryHandle | null
): Promise<StoredSound[]> {
    return store.refreshSoundboardFolder(requestedHandle);
}

export function disconnectSoundboardFolder(): Promise<StoredSound[]> {
    return store.disconnectSoundboardFolder();
}

export function getSound(id: string): Promise<StoredSound | null> {
    return store.getSound(id);
}
