/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    chooseEmojiGuildId,
    createSinglePlaybackController,
    DISCORD_CHAT_EMOJI_INTENTION,
    importSoundFiles,
    MAX_AUDIO_FILE_BYTES,
    MAX_FOLDER_HASH_BYTES,
    MAX_FOLDER_SCAN_ENTRIES,
    MAX_LIBRARY_BYTES,
    MAX_LIBRARY_SOUNDS,
    mergeLibraryFiles,
    mergeLibraryFilesDeduplicated,
    moveStoredSound,
    normalizeDiscordCdnEmoji,
    normalizeDiscordEmoji,
    removeStoredSound,
    scanSoundFiles,
    selectVisibleSounds,
    shouldInjectPanelButton,
    StoredSound,
    toggleStoredSoundFavorite,
    updateStoredSoundMetadata,
    validateAudioFileContent
} from "./core";

function fakeFile(name: string, type: string, size = 128, lastModified = 1): File {
    return {
        name,
        type,
        size,
        lastModified,
        arrayBuffer: async () => new TextEncoder().encode(`${name}:${lastModified}`).buffer
    } as File;
}

function fakeDirectory(files: File[]): FileSystemDirectoryHandle {
    return {
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

function stored(id: string, fileName: string, source: "import" | "folder" = "import"): StoredSound {
    return {
        id,
        fileName,
        name: fileName.replace(/\.[^.]+$/, ""),
        size: 128,
        type: "audio/mpeg",
        blob: fakeFile(fileName, "audio/mpeg"),
        source
    };
}

test("real audio validation rejects media that the browser cannot decode", async () => {
    const originalAudio = globalThis.Audio;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    class InvalidAudio {
        duration = Number.NaN;
        onerror: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        preload = "";
        set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
        load() { }
        removeAttribute() { }
    }
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: InvalidAudio });
    URL.createObjectURL = () => "blob:invalid-audio";
    URL.revokeObjectURL = () => undefined;
    try {
        const file = new File([new Uint8Array([1, 2, 3])], "not-audio.mp3", { type: "audio/mpeg" });
        await assert.rejects(validateAudioFileContent(file), /cannot be read/i);
    } finally {
        Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

test("real audio validation rejects sounds longer than two minutes", async () => {
    const originalAudio = globalThis.Audio;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    class LongAudio {
        duration = 121;
        onerror: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        preload = "";
        set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
        load() { }
        removeAttribute() { }
    }
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: LongAudio });
    URL.createObjectURL = () => "blob:long-audio";
    URL.revokeObjectURL = () => undefined;
    try {
        const file = new File([new Uint8Array([1, 2, 3])], "long.mp3", { type: "audio/mpeg" });
        await assert.rejects(validateAudioFileContent(file), /duration|2 minutes/i);
    } finally {
        Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
});

test("scanSoundFiles returns only supported audio files in display order", async () => {
    const directory = fakeDirectory([
        fakeFile("Zulu.WAV", "audio/wav"),
        fakeFile("notes.txt", "text/plain"),
        fakeFile("alpha.mp3", "audio/mpeg"),
        fakeFile("cover.png", "image/png")
    ]);

    const sounds = await scanSoundFiles(directory);

    assert.deepEqual(sounds.map(sound => ({ fileName: sound.fileName, name: sound.name })), [
        { fileName: "alpha.mp3", name: "alpha" },
        { fileName: "Zulu.WAV", name: "Zulu" }
    ]);
});

test("scanSoundFiles stops reading as soon as the sound-count limit is exceeded", async () => {
    let reads = 0;
    const directory = {
        async *values() {
            for (let index = 0; index < MAX_LIBRARY_SOUNDS + 20; index++) {
                yield {
                    kind: "file" as const,
                    name: `${index}.mp3`,
                    getFile: async () => {
                        reads++;
                        return fakeFile(`${index}.mp3`, "audio/mpeg", 1);
                    }
                };
            }
        }
    };

    await assert.rejects(scanSoundFiles(directory), /maximum number of sounds/i);
    assert.equal(reads, MAX_LIBRARY_SOUNDS + 1);
});

test("scanSoundFiles deduplicates exact content before enforcing the logical sound limit", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const files = Array.from({ length: MAX_LIBRARY_SOUNDS + 1 }, (_, index) =>
        new File([bytes], `copy-${index}.mp3`, { type: "audio/mpeg" }));

    const sounds = await scanSoundFiles(fakeDirectory(files));

    assert.deepEqual(sounds.map(sound => sound.fileName), ["copy-0.mp3"]);
});

test("scanSoundFiles bounds all directory entries before reading indefinitely", async () => {
    let yielded = 0;
    const directory = {
        async *values() {
            for (let index = 0; index <= MAX_FOLDER_SCAN_ENTRIES; index++) {
                yielded++;
                yield { kind: "directory", name: `folder-${index}` };
            }
        }
    };

    await assert.rejects(scanSoundFiles(directory), /more than 5000 entries/i);
    assert.equal(yielded, MAX_FOLDER_SCAN_ENTRIES + 1);
});

test("scanSoundFiles rejects excessive hashing work before reading the overflowing file", async () => {
    let arrayBufferCalls = 0;
    const fileCount = Math.floor(MAX_FOLDER_HASH_BYTES / MAX_AUDIO_FILE_BYTES) + 1;
    const files = Array.from({ length: fileCount }, (_, index) => {
        const file = fakeFile(`large-${index}.mp3`, "audio/mpeg", MAX_AUDIO_FILE_BYTES, index);
        file.arrayBuffer = async () => {
            arrayBufferCalls++;
            return new Uint8Array([1, 2, 3]).buffer;
        };
        return file;
    });

    await assert.rejects(scanSoundFiles(fakeDirectory(files)), /1000 MiB/i);
    assert.equal(arrayBufferCalls, fileCount - 1);
});

test("importSoundFiles keeps supported files and disambiguates duplicate names", () => {
    const sounds = importSoundFiles([
        fakeFile("airhorn.mp3", "audio/mpeg"),
        fakeFile("airhorn.wav", "audio/wav"),
        fakeFile("readme.md", "text/markdown")
    ]);

    assert.deepEqual(sounds.map(sound => ({ fileName: sound.fileName, name: sound.name })), [
        { fileName: "airhorn.mp3", name: "airhorn" },
        { fileName: "airhorn.wav", name: "airhorn (2)" }
    ]);
});

test("single playback controller stops the previous sound before starting another", async () => {
    const events: string[] = [];
    const controller = createSinglePlaybackController(async (sound, signal) => {
        events.push(`start:${sound.fileName}`);
        await new Promise<void>(resolve => signal.addEventListener("abort", () => {
            events.push(`stop:${sound.fileName}`);
            resolve();
        }, { once: true }));
    });

    const first = controller.play({ fileName: "one.mp3", name: "one", size: 1, type: "audio/mpeg" });
    const second = controller.play({ fileName: "two.mp3", name: "two", size: 1, type: "audio/mpeg" });

    assert.deepEqual(events.slice(0, 3), ["start:one.mp3", "stop:one.mp3", "start:two.mp3"]);
    controller.stop();
    await Promise.all([first, second]);
});

test("mergeLibraryFiles replaces folder entries but preserves imported sounds", () => {
    const imported = mergeLibraryFiles([], [fakeFile("saved.mp3", "audio/mpeg")], "import");
    const firstFolder = mergeLibraryFiles(imported, [fakeFile("old.wav", "audio/wav")], "folder");
    const refreshed = mergeLibraryFiles(firstFolder, [fakeFile("new.ogg", "audio/ogg")], "folder");

    assert.deepEqual(refreshed.map(sound => [sound.fileName, sound.source]), [
        ["new.ogg", "folder"],
        ["saved.mp3", "import"]
    ]);
});

test("mergeLibraryFiles assigns unique ids and display names within and across batches", () => {
    const first = mergeLibraryFiles([], [
        fakeFile("airhorn.mp3", "audio/mpeg"),
        fakeFile("airhorn.mp3", "audio/mpeg")
    ], "import");
    const second = mergeLibraryFiles(first, [fakeFile("airhorn.wav", "audio/wav")], "import");

    assert.equal(new Set(second.map(sound => sound.id)).size, 3);
    assert.deepEqual(second.map(sound => sound.name), ["airhorn", "airhorn (2)", "airhorn (3)"]);
});

test("removeStoredSound removes only the exact id", () => {
    const sounds = [stored("import:a" , "a.mp3"), stored("import:a#2", "a.mp3")];

    assert.deepEqual(removeStoredSound(sounds, "import:a").map(sound => sound.id), ["import:a#2"]);
});

test("sound metadata supports Unicode and Discord custom emojis", () => {
    assert.deepEqual(normalizeDiscordEmoji({ id: null, name: "grinning", surrogates: "😀" }), {
        type: "unicode",
        value: "😀"
    });
    assert.deepEqual(normalizeDiscordEmoji({ id: "123456789012345678", name: "party", animated: true }), {
        type: "custom",
        id: "123456789012345678",
        name: "party",
        animated: true
    });
    assert.equal(normalizeDiscordEmoji({ id: "not-a-snowflake", name: "broken" }), null);
});

test("custom Discord emoji images can be assigned even when the native picker marks them locked", () => {
    assert.deepEqual(
        normalizeDiscordCdnEmoji(
            "https://cdn.discordapp.com/emojis/123456789012345678.webp?size=56&animated=true",
            ":party_blob:"
        ),
        { type: "custom", id: "123456789012345678", name: "party_blob", animated: true }
    );
    assert.equal(normalizeDiscordCdnEmoji("https://example.com/not-discord.webp", ":nope:"), null);
});

test("the emoji picker uses the connected voice guild before the viewed guild", () => {
    assert.equal(chooseEmojiGuildId("voice-guild", "viewed-guild"), "voice-guild");
    assert.equal(chooseEmojiGuildId(undefined, "viewed-guild"), "viewed-guild");
    assert.equal(chooseEmojiGuildId(undefined, undefined), undefined);
});

test("the Discord emoji picker uses the live client chat intention", () => {
    assert.equal(DISCORD_CHAT_EMOJI_INTENTION, 3);
});

test("renamed sounds and emojis survive a folder rescan", () => {
    const file = fakeFile("airhorn.mp3", "audio/mpeg", 128, 42);
    const initial = mergeLibraryFiles([], [file], "folder");
    const edited = updateStoredSoundMetadata(initial, initial[0].id, {
        name: "Big Horn",
        emoji: { type: "custom", id: "123456789012345678", name: "horn", animated: false }
    });

    const refreshed = mergeLibraryFiles(edited, [file], "folder");

    assert.equal(refreshed[0].name, "Big Horn");
    assert.equal(refreshed[0].customName, "Big Horn");
    assert.deepEqual(refreshed[0].emoji, edited[0].emoji);
});

test("sound metadata updates reject empty names", () => {
    assert.throws(
        () => updateStoredSoundMetadata([stored("sound", "sound.mp3")], "sound", { name: "   ", emoji: null }),
        /name/i
    );
});

test("sound metadata stores bounded volume and non-destructive trim points", () => {
    const sounds = updateStoredSoundMetadata([stored("sound", "sound.mp3")], "sound", {
        name: "Sound",
        emoji: null,
        volume: 1.75,
        trimStart: 1.25,
        trimEnd: 4.5
    });

    assert.equal(sounds[0].volume, 1.75);
    assert.equal(sounds[0].trimStart, 1.25);
    assert.equal(sounds[0].trimEnd, 4.5);
    assert.throws(() => updateStoredSoundMetadata(sounds, "sound", {
        name: "Sound",
        emoji: null,
        volume: 2.1,
        trimStart: 0,
        trimEnd: null
    }), /volume/i);
    assert.throws(() => updateStoredSoundMetadata(sounds, "sound", {
        name: "Sound",
        emoji: null,
        volume: 1,
        trimStart: 5,
        trimEnd: 4
    }), /trim/i);
});

test("favorites sort first while search matches display and file names", () => {
    const sounds = [
        { ...stored("one", "vine-boom.mp3"), name: "Impact", order: 0 },
        { ...stored("two", "anime-wow.wav"), name: "Wow", favorite: true, order: 1 },
        { ...stored("three", "airhorn.mp3"), name: "Horn", order: 2 }
    ];

    assert.deepEqual(selectVisibleSounds(sounds, "").map(sound => sound.id), ["two", "one", "three"]);
    assert.deepEqual(selectVisibleSounds(sounds, "vine").map(sound => sound.id), ["one"]);
    assert.deepEqual(selectVisibleSounds(sounds, "wow").map(sound => sound.id), ["two"]);
});

test("favorite and manual ordering updates preserve stable sound identities", () => {
    const sounds = [stored("one", "one.mp3"), stored("two", "two.mp3"), stored("three", "three.mp3")]
        .map((sound, order) => ({ ...sound, order }));

    const favorited = toggleStoredSoundFavorite(sounds, "two");
    assert.equal(favorited[1].favorite, true);
    const moved = moveStoredSound(favorited, "three", "one");
    assert.deepEqual(moved.map(sound => sound.id), ["three", "one", "two"]);
    assert.deepEqual(moved.map(sound => sound.order), [0, 1, 2]);
});

test("deduplicated merge ignores exact audio duplicates regardless of filename", async () => {
    const first = new File([new Uint8Array([1, 2, 3])], "first.mp3", { type: "audio/mpeg", lastModified: 1 });
    const duplicate = new File([new Uint8Array([1, 2, 3])], "copy.mp3", { type: "audio/mpeg", lastModified: 2 });
    const distinct = new File([new Uint8Array([1, 2, 4])], "distinct.mp3", { type: "audio/mpeg", lastModified: 3 });

    const initial = await mergeLibraryFilesDeduplicated([], [first], "import");
    const merged = await mergeLibraryFilesDeduplicated(initial.sounds, [duplicate, distinct], "import");

    assert.equal(merged.importedCount, 1);
    assert.equal(merged.duplicateCount, 1);
    assert.deepEqual(merged.sounds.map(sound => sound.fileName), ["first.mp3", "distinct.mp3"]);
    assert.ok(merged.sounds.every(sound => /^[a-f0-9]{64}$/.test(sound.contentHash ?? "")));
});

test("deduplicated merge stops processing once the unique sound limit is exceeded", async () => {
    let reads = 0;
    const files = Array.from({ length: MAX_LIBRARY_SOUNDS + 20 }, (_, index) => {
        const file = new File([new Uint8Array([index >> 8, index & 0xff])], `sound-${index}.mp3`, { type: "audio/mpeg" });
        const original = file.arrayBuffer.bind(file);
        file.arrayBuffer = async () => {
            reads++;
            return original();
        };
        return file;
    });

    await assert.rejects(mergeLibraryFilesDeduplicated([], files, "import"), /maximum number/i);
    assert.equal(reads, MAX_LIBRARY_SOUNDS + 1);
});

test("audio limits reject a large file before it enters the library", () => {
    assert.throws(
        () => mergeLibraryFiles([], [fakeFile("huge.wav", "audio/wav", MAX_AUDIO_FILE_BYTES + 1)], "import"),
        /too large/i
    );
});

test("audio limits reject too many sounds", () => {
    const files = Array.from({ length: MAX_LIBRARY_SOUNDS + 1 }, (_, index) =>
        fakeFile(`sound-${index}.mp3`, "audio/mpeg", 1, index));

    assert.throws(() => mergeLibraryFiles([], files, "import"), /maximum number/i);
});

test("audio limits reject a library whose total byte size is too large", () => {
    const fileSize = Math.min(MAX_AUDIO_FILE_BYTES, Math.ceil(MAX_LIBRARY_BYTES / 2));
    const fileCount = Math.floor(MAX_LIBRARY_BYTES / fileSize) + 1;
    const files = Array.from({ length: fileCount }, (_, index) =>
        fakeFile(`sound-${index}.wav`, "audio/wav", fileSize, index));

    assert.throws(() => mergeLibraryFiles([], files, "import"), /total library size/i);
});

test("the additional panel button is disabled when the native soundboard is replaced", () => {
    assert.equal(shouldInjectPanelButton(false), true);
    assert.equal(shouldInjectPanelButton(true), false);
});
