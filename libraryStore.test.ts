/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RestoredSound } from "./backup";
import { MAX_LIBRARY_SOUNDS, type StoredSound } from "./core";
import {
    createLibraryStore,
    FOLDER_KEY,
    IGNORED_FOLDER_HASHES_KEY,
    LIBRARY_KEY,
    type LibraryStorage } from "./libraryStore";

function fakeFile(name: string, size = 128, lastModified = 1): File {
    const bytes = new Uint8Array(size);
    bytes.fill(name.charCodeAt(0) || 1);
    return new File([bytes], name, { lastModified, type: "audio/mpeg" });
}

function stored(id: string, fileName: string, source: "import" | "folder" = "import"): StoredSound {
    const blob = new Blob([new Uint8Array([1])], { type: "audio/mpeg" });
    return {
        id,
        fileName,
        name: fileName.replace(/\.[^.]+$/, ""),
        size: blob.size,
        type: blob.type,
        blob,
        source
    };
}

function fakeDirectory(
    files: File[],
    permission: PermissionState = "granted",
    name = "sounds"
): FileSystemDirectoryHandle {
    return {
        kind: "directory",
        name,
        async queryPermission() {
            return permission;
        },
        async requestPermission() {
            return permission;
        },
        async *values() {
            for (const file of files) {
                yield {
                    kind: "file",
                    name: file.name,
                    getFile: async () => file
                };
            }
        }
    } as unknown as FileSystemDirectoryHandle;
}

function writableDirectory(behavior: { corruptReadback?: boolean; failRemove?: boolean; raceCreate?: boolean; } = {}): {
    handle: FileSystemDirectoryHandle;
    files: Map<string, File>;
    racedNames: string[];
} {
    const files = new Map<string, File>();
    const racedNames: string[] = [];
    const handle = {
        kind: "directory",
        name: "sounds",
        async queryPermission() { return "granted"; },
        async requestPermission() { return "granted"; },
        async *values() {
            for (const file of files.values()) yield { kind: "file", name: file.name, getFile: async () => file };
        },
        async getFileHandle(name: string, options?: { create?: boolean; }) {
            if (!options?.create && !files.has(name)) throw new DOMException("Missing", "NotFoundError");
            if (options?.create && behavior.raceCreate && !files.has(name) && racedNames.length === 0) {
                files.set(name, new File([new Uint8Array([9, 9, 9])], name, { type: "audio/mpeg" }));
                racedNames.push(name);
            }
            if (options?.create && !files.has(name)) files.set(name, new File([], name));
            let pending: Blob | null = null;
            return {
                kind: "file",
                name,
                async createWritable() {
                    return {
                        async write(data: Blob) { pending = data; },
                        async close() {
                            if (!pending) throw new Error("Nothing was written.");
                            files.set(name, new File([pending], name, { type: pending.type }));
                        },
                        async abort() { pending = null; }
                    };
                },
                async getFile() {
                    const file = files.get(name);
                    if (!file) throw new DOMException("Missing", "NotFoundError");
                    if (behavior.corruptReadback && file.size > 0) {
                        return new File([new Uint8Array([255])], name, { type: file.type });
                    }
                    return file;
                }
            };
        },
        async removeEntry(name: string) {
            if (behavior.failRemove) throw new Error("Removal failed.");
            files.delete(name);
        }
    } as unknown as FileSystemDirectoryHandle;
    return { handle, files, racedNames };
}

class MemoryStorage implements LibraryStorage {
    readonly values = new Map<string, unknown>();
    readonly events: string[] = [];
    failLibrarySet = false;
    failFolderDelete = false;

    async get<T>(key: string): Promise<T | undefined> {
        this.events.push(`get:${key}`);
        return this.values.get(key) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        this.events.push(`set:${key}`);
        if (key === LIBRARY_KEY && this.failLibrarySet) throw new Error("library write failed");
        this.values.set(key, value);
    }

    async del(key: string): Promise<void> {
        this.events.push(`del:${key}`);
        if (key === FOLDER_KEY && this.failFolderDelete) throw new Error("folder delete failed");
        this.values.delete(key);
    }
}

function createTestStore(storage: LibraryStorage) {
    return createLibraryStore(storage, () => undefined, async () => 120);
}

test("concurrent imports are serialized without lost updates", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);

    const [first, second] = await Promise.all([
        store.importFiles([fakeFile("one.mp3")]),
        store.importFiles([fakeFile("two.mp3")])
    ]);

    assert.equal(first.sounds.length, 1);
    assert.equal(first.importedCount, 1);
    assert.deepEqual(second.sounds.map(sound => sound.fileName).sort(), ["one.mp3", "two.mp3"]);
    assert.deepEqual((await store.getLibrary()).map(sound => sound.fileName).sort(), ["one.mp3", "two.mp3"]);
});

test("direct import stops collecting before validating an oversized selection", async () => {
    const storage = new MemoryStorage();
    let yielded = 0;
    let validations = 0;
    const store = createLibraryStore(storage, () => undefined, async () => {
        validations++;
        return 120;
    });
    const files = {
        *[Symbol.iterator]() {
            for (let index = 0; index < MAX_LIBRARY_SOUNDS + 50; index++) {
                yielded++;
                yield fakeFile(`sound-${index}.mp3`);
            }
        }
    };

    await assert.rejects(store.importFiles(files), new RegExp(`maximum number of sounds is ${MAX_LIBRARY_SOUNDS}`, "i"));

    assert.equal(yielded, MAX_LIBRARY_SOUNDS + 1);
    assert.equal(validations, 0);
    assert.equal(storage.events.some(event => event.startsWith("set:")), false);
});

test("a failed durable write never updates the in-memory library", async () => {
    const storage = new MemoryStorage();
    const original = [stored("original", "original.mp3")];
    storage.values.set(LIBRARY_KEY, original);
    const store = createTestStore(storage);
    await store.getLibrary();
    storage.failLibrarySet = true;

    await assert.rejects(store.importFiles([fakeFile("new.mp3")]), /library write failed/);

    assert.deepEqual((await store.getLibrary()).map(sound => sound.id), ["original"]);
});

test("clear rolls back the durable library and cache if folder deletion fails", async () => {
    const storage = new MemoryStorage();
    const original = [stored("original", "original.mp3")];
    const folder = fakeDirectory([]);
    storage.values.set(LIBRARY_KEY, original);
    storage.values.set(FOLDER_KEY, folder);
    const store = createTestStore(storage);
    await store.getLibrary();
    storage.failFolderDelete = true;

    await assert.rejects(store.clearLibrary(), /folder delete failed/);

    assert.deepEqual((storage.values.get(LIBRARY_KEY) as StoredSound[]).map(sound => sound.id), ["original"]);
    assert.deepEqual((await store.getLibrary()).map(sound => sound.id), ["original"]);
    assert.equal(storage.values.get(FOLDER_KEY), folder);
});

test("setSoundboardFolder rejects denied permission without persisting anything", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);

    await assert.rejects(
        store.setSoundboardFolder(fakeDirectory([fakeFile("sound.mp3")], "denied")),
        /denied/i
    );

    assert.equal(storage.events.some(event => event.startsWith("set:")), false);
    assert.equal(storage.values.has(FOLDER_KEY), false);
});

test("setSoundboardFolder requests read-only access", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);
    const modes: string[] = [];
    const handle = {
        kind: "directory",
        name: "sounds",
        async queryPermission({ mode }: { mode: string; }) {
            modes.push(`query:${mode}`);
            return mode === "read" ? "granted" : "denied";
        },
        async requestPermission({ mode }: { mode: string; }) {
            modes.push(`request:${mode}`);
            return mode === "read" ? "granted" : "denied";
        },
        async *values() {
            const file = fakeFile("sound.mp3");
            yield { kind: "file", name: file.name, getFile: async () => file };
        }
    } as unknown as FileSystemDirectoryHandle;

    await store.setSoundboardFolder(handle);

    assert.deepEqual(modes, ["query:read"]);
});

test("setSoundboardFolder scans and writes the library before persisting the handle", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);
    const folder = fakeDirectory([fakeFile("sound.mp3")]);

    await store.setSoundboardFolder(folder);

    assert.ok(storage.events.indexOf(`set:${LIBRARY_KEY}`) < storage.events.indexOf(`set:${FOLDER_KEY}`));
    assert.equal(storage.values.get(FOLDER_KEY), folder);
});

test("setSoundboardFolder hashes each accepted file only once", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);
    const file = new File([new Uint8Array([1, 2, 3])], "sound.mp3", { type: "audio/mpeg" });
    const original = file.arrayBuffer.bind(file);
    let reads = 0;
    file.arrayBuffer = async () => {
        reads++;
        return original();
    };

    await store.setSoundboardFolder(fakeDirectory([file]));

    assert.equal(reads, 1);
});

test("setSoundboardFolder does not persist the handle when the library write fails", async () => {
    const storage = new MemoryStorage();
    storage.failLibrarySet = true;
    const store = createTestStore(storage);

    await assert.rejects(store.setSoundboardFolder(fakeDirectory([fakeFile("sound.mp3")])), /library write failed/);

    assert.equal(storage.values.has(FOLDER_KEY), false);
    assert.equal(storage.events.includes(`set:${FOLDER_KEY}`), false);
});

test("folder rescan preserves metadata when only lastModified changes", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);
    const originalFile = fakeFile("sound.mp3", 128, 1);
    const connected = fakeDirectory([originalFile]);
    const [original] = await store.setSoundboardFolder(connected);
    await store.updateSoundMetadata(original.id, {
        emoji: { type: "unicode", value: "🔊" },
        name: "Custom Sound",
        trimEnd: 0.9,
        trimStart: 0.1,
        volume: 1.6
    });
    await store.toggleFavorite(original.id);

    const rescanned = await store.refreshSoundboardFolder(fakeDirectory([fakeFile("sound.mp3", 128, 2)]));

    assert.equal(rescanned[0].id, original.id);
    assert.equal(rescanned[0].name, "Custom Sound");
    assert.deepEqual(rescanned[0].emoji, { type: "unicode", value: "🔊" });
    assert.equal(rescanned[0].favorite, true);
    assert.equal(rescanned[0].order, 0);
    assert.equal(rescanned[0].volume, 1.6);
    assert.equal(rescanned[0].trimStart, 0.1);
    assert.equal(rescanned[0].trimEnd, 0.9);
});

test("disconnectSoundboardFolder removes folder sounds and keeps imports", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [
        stored("imported", "saved.mp3"),
        stored("folder", "folder.mp3", "folder")
    ]);
    storage.values.set(FOLDER_KEY, fakeDirectory([]));
    const store = createTestStore(storage);

    const sounds = await store.disconnectSoundboardFolder();

    assert.deepEqual(sounds.map(sound => sound.id), ["imported"]);
    assert.equal(storage.values.has(FOLDER_KEY), false);
});

test("disconnectSoundboardFolder clears persisted rescan exclusions", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [stored("folder", "folder.mp3", "folder")]);
    storage.values.set(FOLDER_KEY, fakeDirectory([]));
    storage.values.set(IGNORED_FOLDER_HASHES_KEY, ["0".repeat(64)]);
    const store = createTestStore(storage);

    await store.disconnectSoundboardFolder();

    assert.equal(storage.values.has(IGNORED_FOLDER_HASHES_KEY), false);
});

test("persisted library data is validated, migrated and deduplicated before use", async () => {
    const storage = new MemoryStorage();
    const first = stored("duplicate", "airhorn.mp3");
    const second = stored("duplicate", "airhorn.wav");
    storage.values.set(LIBRARY_KEY, [first, { broken: true }, second]);
    const store = createTestStore(storage);

    const sounds = await store.getLibrary();

    assert.equal(sounds.length, 2);
    assert.equal(new Set(sounds.map(sound => sound.id)).size, 2);
    assert.deepEqual(sounds.map(sound => sound.name), ["airhorn", "airhorn (2)"]);
    assert.ok(storage.events.includes(`set:${LIBRARY_KEY}`));
});

test("updateSoundMetadata persists a custom name and Discord emoji", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [stored("sound", "airhorn.mp3")]);
    const store = createTestStore(storage);

    const sounds = await store.updateSoundMetadata("sound", {
        name: "Big Horn",
        emoji: { type: "custom", id: "123456789012345678", name: "horn", animated: false }
    });

    assert.equal(sounds[0].name, "Big Horn");
    assert.deepEqual((storage.values.get(LIBRARY_KEY) as StoredSound[])[0].emoji, sounds[0].emoji);
});

test("updateSoundMetadata rejects trim points beyond the measured audio duration", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [stored("sound", "airhorn.mp3")]);
    const store = createLibraryStore(storage, () => undefined, async () => 1 as never);

    await assert.rejects(store.updateSoundMetadata("sound", {
        emoji: null,
        name: "Airhorn",
        trimStart: 1.1,
        volume: 1
    }), /trim|duration|outside/i);

    assert.equal((storage.values.get(LIBRARY_KEY) as StoredSound[])[0].trimStart, undefined);
});

test("imports skip exact duplicates and report only newly imported sounds", async () => {
    const storage = new MemoryStorage();
    const store = createTestStore(storage);
    const first = new File([new Uint8Array([1, 2, 3])], "one.mp3", { type: "audio/mpeg" });
    const duplicate = new File([new Uint8Array([1, 2, 3])], "copy.mp3", { type: "audio/mpeg" });

    await store.importFiles([first]);
    const result = await store.importFiles([duplicate]);

    assert.equal(result.importedCount, 0);
    assert.equal(result.sounds.length, 1);
    assert.deepEqual(result.sounds.map(sound => sound.fileName), ["one.mp3"]);
});

test("favorite and manual order changes are durable", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [
        { ...stored("one", "one.mp3"), order: 0 },
        { ...stored("two", "two.mp3"), order: 1 },
        { ...stored("three", "three.mp3"), order: 2 }
    ]);
    const store = createTestStore(storage);

    await store.toggleFavorite("two");
    const moved = await store.moveSound("three", "one");

    assert.deepEqual(moved.map(sound => sound.id), ["three", "one", "two"]);
    assert.equal(moved.find(sound => sound.id === "two")?.favorite, true);
    assert.deepEqual((storage.values.get(LIBRARY_KEY) as StoredSound[]).map(sound => sound.order), [0, 1, 2]);
});

test("backup restore can add sounds or replace the entire imported library", async () => {
    const storage = new MemoryStorage();
    storage.values.set(LIBRARY_KEY, [{ ...stored("old", "old.mp3"), order: 0 }]);
    const store = createTestStore(storage);
    const restoredFile = new File([new Uint8Array([9, 8, 7])], "backup.mp3", { type: "audio/mpeg" });
    const restored: RestoredSound[] = [{
        file: restoredFile,
        metadata: {
            contentHash: "06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3",
            favorite: true,
            name: "Backup Sound",
            order: 0,
            trimEnd: 2,
            trimStart: 0.25,
            type: "audio/mpeg",
            volume: 1.5
        }
    }];

    const added = await store.restoreImported(restored, "add");
    assert.deepEqual(added.sounds.map(sound => sound.name), ["old", "Backup Sound"]);
    assert.equal(added.sounds[1].favorite, true);

    const replaced = await store.restoreImported(restored, "replace");
    assert.deepEqual(replaced.sounds.map(sound => sound.name), ["Backup Sound"]);
    assert.equal(replaced.sounds[0].volume, 1.5);
    assert.equal(replaced.sounds[0].trimStart, 0.25);
    assert.equal(replaced.sounds[0].trimEnd, 2);
});

test("backup restore rejects trim points beyond the measured audio duration", async () => {
    const storage = new MemoryStorage();
    const store = createLibraryStore(storage, () => undefined, async () => 1);
    const file = new File([new Uint8Array([9, 8, 7])], "backup.mp3", { type: "audio/mpeg" });

    await assert.rejects(store.restoreImported([{
        file,
        metadata: {
            contentHash: "06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3",
            name: "Backup Sound",
            order: 0,
            trimStart: 1.1,
            type: file.type,
            volume: 1
        }
    }], "add"), /trim|duration|outside/i);

    assert.equal(storage.values.has(LIBRARY_KEY), false);
});

test("backup restore stores missing audio locally without mutating the connected folder", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    storage.values.set(FOLDER_KEY, directory.handle);
    const store = createTestStore(storage);
    const file = new File([new Uint8Array([4, 5, 6])], "backup.mp3", { type: "audio/mpeg" });

    const restored = await store.restoreImported([{
        file,
        metadata: {
            contentHash: "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
            name: "Folder Backup",
            order: 0,
            trimStart: 0,
            type: file.type,
            volume: 1
        }
    }], "add");

    assert.deepEqual([...directory.files.keys()], []);
    assert.equal(restored.sounds[0].source, "import");
    assert.equal(restored.sounds[0].name, "Folder Backup");
});

test("folder restore never invokes writable folder APIs", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory({ raceCreate: true });
    storage.values.set(FOLDER_KEY, directory.handle);
    const store = createTestStore(storage);
    const file = new File([new Uint8Array([4, 5, 6])], "backup.mp3", { type: "audio/mpeg" });

    const restored = await store.restoreImported([{
        file,
        metadata: {
            contentHash: "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
            name: "Folder Backup",
            order: 0,
            trimStart: 0,
            type: file.type,
            volume: 1
        }
    }], "add");

    assert.deepEqual(directory.racedNames, []);
    assert.deepEqual([...directory.files.keys()], []);
    assert.equal(restored.sounds[0].source, "import");
});

test("a failed restore never deletes or overwrites connected-folder files", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory({ failRemove: true, raceCreate: true });
    const concurrent = new File([new Uint8Array([7, 7, 7])], "concurrent.mp3", { type: "audio/mpeg" });
    directory.files.set(concurrent.name, concurrent);
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, [{ ...stored("old", "old.mp3"), order: 0 }]);
    const store = createTestStore(storage);
    await store.getLibrary();
    storage.failLibrarySet = true;
    const file = new File([new Uint8Array([4, 5, 6])], "backup.mp3", { type: "audio/mpeg" });

    await assert.rejects(store.restoreImported([{
        file,
        metadata: {
            contentHash: "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
            name: "Folder Backup",
            order: 0,
            trimStart: 0,
            type: file.type,
            volume: 1
        }
    }], "add"), /library write failed/i);

    assert.deepEqual(directory.racedNames, []);
    assert.deepEqual([...directory.files.keys()], ["concurrent.mp3"]);
    assert.deepEqual([...new Uint8Array(await directory.files.get("concurrent.mp3")!.arrayBuffer())], [7, 7, 7]);
    assert.deepEqual((storage.values.get(LIBRARY_KEY) as StoredSound[]).map(sound => sound.id), ["old"]);
});

test("backup Add restore preserves existing connected-folder sounds", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    const existingFile = new File([new Uint8Array([1])], "existing.mp3", { type: "audio/mpeg" });
    directory.files.set(existingFile.name, existingFile);
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, [{
        ...stored("folder-existing", existingFile.name, "folder"),
        blob: existingFile,
        size: existingFile.size
    }]);
    const store = createTestStore(storage);
    const restoredFile = new File([new Uint8Array([4, 5, 6])], "restored.mp3", { type: "audio/mpeg" });

    const restored = await store.restoreImported([{
        file: restoredFile,
        metadata: {
            contentHash: "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
            name: "Restored",
            order: 1,
            trimStart: 0,
            type: restoredFile.type,
            volume: 1
        }
    }], "add");

    assert.deepEqual(restored.sounds.map(sound => sound.fileName), ["existing.mp3", "restored.mp3"]);
    assert.deepEqual([...directory.files.keys()], ["existing.mp3"]);
});

test("backup Add never treats a missing cached folder blob as a physical folder file", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    const restoredFile = new File([new Uint8Array([4, 5, 6])], "restored.mp3", { type: "audio/mpeg" });
    const contentHash = "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472";
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, [{
        ...stored("stale-folder", restoredFile.name, "folder"),
        blob: restoredFile,
        contentHash,
        size: restoredFile.size
    }]);
    const store = createTestStore(storage);

    const restored = await store.restoreImported([{
        file: restoredFile,
        metadata: {
            contentHash,
            name: "Restored",
            order: 0,
            trimStart: 0,
            type: restoredFile.type,
            volume: 1
        }
    }], "add");
    const rescanned = await store.refreshSoundboardFolder();

    assert.equal(restored.importedCount, 1);
    assert.equal(restored.duplicateCount, 0);
    assert.equal(restored.sounds[0].source, "import");
    assert.deepEqual(rescanned.map(sound => sound.fileName), ["restored.mp3"]);
});

test("backup Replace never treats a missing cached folder blob as a physical folder file", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    const restoredFile = new File([new Uint8Array([4, 5, 6])], "restored.mp3", { type: "audio/mpeg" });
    const contentHash = "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472";
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, [{
        ...stored("stale-folder", restoredFile.name, "folder"),
        blob: restoredFile,
        contentHash,
        size: restoredFile.size
    }]);
    const store = createTestStore(storage);

    const restored = await store.restoreImported([{
        file: restoredFile,
        metadata: {
            contentHash,
            name: "Restored",
            order: 0,
            trimStart: 0,
            type: restoredFile.type,
            volume: 1
        }
    }], "replace");
    const rescanned = await store.refreshSoundboardFolder();

    assert.equal(restored.sounds[0].source, "import");
    assert.deepEqual(rescanned.map(sound => sound.fileName), ["restored.mp3"]);
});

test("backup Replace keeps old folder files on disk but excludes them from later rescans", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    const oldFile = new File([new Uint8Array([1])], "old.mp3", { type: "audio/mpeg" });
    directory.files.set(oldFile.name, oldFile);
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, [{
        ...stored("folder-old", oldFile.name, "folder"),
        blob: oldFile,
        size: oldFile.size
    }]);
    const store = createTestStore(storage);
    const restoredFile = new File([new Uint8Array([9, 8, 7])], "replacement.mp3", { type: "audio/mpeg" });

    const replaced = await store.restoreImported([{
        file: restoredFile,
        metadata: {
            contentHash: "06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3",
            name: "Replacement",
            order: 0,
            trimStart: 0,
            type: restoredFile.type,
            volume: 1
        }
    }], "replace");
    const rescanned = await store.refreshSoundboardFolder();

    assert.deepEqual(replaced.sounds.map(sound => sound.fileName), ["replacement.mp3"]);
    assert.deepEqual([...directory.files.keys()], ["old.mp3"]);
    assert.deepEqual(rescanned.map(sound => sound.fileName), ["replacement.mp3"]);
});

test("backup Replace excludes unscanned pre-existing folder files from later rescans", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    const unscannedFile = new File([new Uint8Array([1])], "unscanned.mp3", { type: "audio/mpeg" });
    directory.files.set(unscannedFile.name, unscannedFile);
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, []);
    const store = createTestStore(storage);
    const restoredFile = new File([new Uint8Array([9, 8, 7])], "replacement.mp3", { type: "audio/mpeg" });

    await store.restoreImported([{
        file: restoredFile,
        metadata: {
            contentHash: "06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3",
            name: "Replacement",
            order: 0,
            trimStart: 0,
            type: restoredFile.type,
            volume: 1
        }
    }], "replace");
    const rescanned = await store.refreshSoundboardFolder();

    assert.deepEqual(rescanned.map(sound => sound.fileName), ["replacement.mp3"]);
});

test("ignored folder files do not consume the logical sound quota during rescan", async () => {
    const storage = new MemoryStorage();
    const directory = writableDirectory();
    for (let index = 0; index < 201; index++) {
        const file = new File([new Uint8Array([1])], `old-${index}.mp3`, { type: "audio/mpeg" });
        directory.files.set(file.name, file);
    }
    storage.values.set(FOLDER_KEY, directory.handle);
    storage.values.set(LIBRARY_KEY, []);
    storage.values.set(IGNORED_FOLDER_HASHES_KEY, ["4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a"]);
    const store = createTestStore(storage);

    const rescanned = await store.refreshSoundboardFolder();

    assert.deepEqual(rescanned, []);
});

test("imports validate real audio before any durable library write", async () => {
    const storage = new MemoryStorage();
    let validations = 0;
    const store = createLibraryStore(storage, () => undefined, async () => {
        validations++;
        throw new Error("The audio file cannot be read.");
    });

    await assert.rejects(store.importFiles([fakeFile("not-audio.mp3")]), /cannot be read/i);

    assert.equal(validations, 1);
    assert.equal(storage.events.some(event => event.startsWith("set:")), false);
});
