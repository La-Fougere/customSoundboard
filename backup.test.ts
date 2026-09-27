/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { strToU8, Zip, ZipPassThrough, zipSync } from "fflate";

import { createSoundboardBackup, readSoundboardBackup, unzipArchive } from "./backup";
import { StoredSound } from "./core";

function sound(id: string, fileName: string, bytes: number[], order: number): StoredSound {
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
    return {
        id,
        blob,
        customName: "Custom name",
        emoji: { type: "unicode", value: "🔊" },
        favorite: true,
        fileName,
        name: "Custom name",
        order,
        size: blob.size,
        source: "import",
        trimEnd: 3.5,
        trimStart: 0.5,
        type: blob.type,
        volume: 1.5
    };
}

function duplicateNameArchive(entries: Array<readonly [string, Uint8Array]>): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const archive = new Zip((error, chunk, final) => {
            if (error) {
                reject(error);
                return;
            }
            chunks.push(chunk.slice());
            if (final) {
                const size = chunks.reduce((sum, current) => sum + current.length, 0);
                const output = new Uint8Array(size);
                let offset = 0;
                for (const current of chunks) {
                    output.set(current, offset);
                    offset += current.length;
                }
                resolve(output);
            }
        });
        for (const [name, bytes] of entries) {
            const entry = new ZipPassThrough(name);
            archive.add(entry);
            entry.push(bytes, true);
        }
        archive.end();
    });
}

test("complete backup round-trips audio and all user metadata", async () => {
    const archive = await createSoundboardBackup([sound("one", "air horn.mp3", [1, 2, 3], 0)]);
    const restored = await readSoundboardBackup(new File([archive], "soundboard.zip", { type: "application/zip" }));

    assert.equal(restored.length, 1);
    assert.deepEqual([...new Uint8Array(await restored[0].file.arrayBuffer())], [1, 2, 3]);
    assert.equal(restored[0].file.name, "air horn.mp3");
    assert.match(restored[0].metadata.contentHash ?? "", /^[a-f0-9]{64}$/);
    const { contentHash: _contentHash, ...metadata } = restored[0].metadata;
    assert.deepEqual(metadata, {
        customName: "Custom name",
        emoji: { type: "unicode", value: "🔊" },
        favorite: true,
        name: "Custom name",
        order: 0,
        trimEnd: 3.5,
        trimStart: 0.5,
        type: "audio/mpeg",
        volume: 1.5
    });
});

test("complete backup round-trips generated display names longer than the custom-name limit", async () => {
    const longName = "a".repeat(81);
    const entry = sound("long", `${longName}.mp3`, [1, 2, 3], 0);
    entry.name = longName;
    delete entry.customName;

    const archive = await createSoundboardBackup([entry]);
    const [restored] = await readSoundboardBackup(new File([archive], "soundboard.zip", { type: "application/zip" }));

    assert.equal(restored.file.name, `${longName}.mp3`);
    assert.equal(restored.metadata.name, longName);
    assert.equal(restored.metadata.customName, undefined);
});

test("backup export streams payloads instead of retaining a second full copy", async () => {
    const entry = sound("one", "sound.mp3", [1, 2, 3], 0);
    let arrayBufferCalls = 0;
    Object.defineProperty(entry.blob, "arrayBuffer", {
        value: async () => {
            arrayBufferCalls++;
            return Blob.prototype.arrayBuffer.call(entry.blob);
        }
    });

    await createSoundboardBackup([entry]);
    assert.equal(arrayBufferCalls, 1);
});

test("backup import streams the archive instead of reading it into one full buffer", async () => {
    const archive = await createSoundboardBackup([sound("one", "sound.mp3", [1, 2, 3], 0)]);
    const file = new File([archive], "soundboard.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", {
        value: async () => { throw new Error("whole archive buffering is forbidden"); }
    });

    const restored = await readSoundboardBackup(file);
    assert.equal(restored.length, 1);
});

test("backup import rejects archives without a valid manifest", async () => {
    const archive = zipSync({ "unexpected.txt": strToU8("not a soundboard") });
    await assert.rejects(
        readSoundboardBackup(new File([archive], "broken.zip", { type: "application/zip" })),
        /manifest/i
    );
});

test("backup import requires every manifest entry to include its SHA-256 hash", async () => {
    const manifest = {
        version: 1,
        sounds: [{
            path: "sounds/0000.mp3",
            fileName: "sound.mp3",
            metadata: { name: "Sound", order: 0, type: "audio/mpeg", volume: 1, trimStart: 0 }
        }]
    };
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest)),
        "sounds/0000.mp3": new Uint8Array([1, 2, 3])
    });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "missing-hash.zip", { type: "application/zip" })),
        /hash/i
    );
});

test("backup import rejects duplicate raw ZIP entry names", async () => {
    const manifest = strToU8(JSON.stringify({
        version: 1,
        sounds: [{
            path: "sounds/0000.mp3",
            fileName: "sound.mp3",
            metadata: {
                contentHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                name: "Sound",
                order: 0,
                type: "audio/mpeg",
                volume: 1,
                trimStart: 0
            }
        }]
    }));
    const archive = await duplicateNameArchive([
        ["manifest.json", manifest],
        ["manifest.json", manifest],
        ["sounds/0000.mp3", new Uint8Array([1, 2, 3])]
    ]);

    await assert.rejects(
        readSoundboardBackup(new File([archive.buffer as ArrayBuffer], "duplicates.zip", { type: "application/zip" })),
        /duplicate/i
    );
});

test("backup import rejects payloads whose SHA-256 does not match the manifest", async () => {
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify({
            version: 1,
            sounds: [{
                path: "sounds/0000.mp3",
                fileName: "sound.mp3",
                metadata: {
                    contentHash: "0".repeat(64),
                    name: "Sound",
                    order: 0,
                    type: "audio/mpeg",
                    volume: 1,
                    trimStart: 0
                }
            }]
        })),
        "sounds/0000.mp3": new Uint8Array([1, 2, 3])
    });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "hash-mismatch.zip", { type: "application/zip" })),
        /hash/i
    );
});

test("backup import rejects a manifest whose payload is missing", async () => {
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify({
            version: 1,
            sounds: [{
                path: "sounds/0000.mp3",
                fileName: "sound.mp3",
                metadata: {
                    contentHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                    name: "Sound",
                    order: 0,
                    type: "audio/mpeg",
                    volume: 1,
                    trimStart: 0
                }
            }]
        }))
    });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "missing-payload.zip", { type: "application/zip" })),
        /missing/i
    );
});

test("backup import rejects payloads not listed in the manifest", async () => {
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 1, sounds: [] })),
        "sounds/0000.mp3": new Uint8Array([1, 2, 3])
    });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "unlisted.zip", { type: "application/zip" })),
        /unlisted/i
    );
});

test("backup import rejects a compressed payload that expands beyond the per-file limit", async () => {
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 1, sounds: [] })),
        "sounds/0000.mp3": oversized
    }, { level: 9 });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "expansion.zip", { type: "application/zip" })),
        /oversized|large/i
    );
});

test("backup import terminates the active entry as soon as an expanded-size limit is exceeded", async () => {
    let handler: ((entry: {
        name: string;
        originalSize?: number;
        ondata: (error: Error | null, chunk: Uint8Array, final: boolean) => void;
        start(): void;
        terminate(): void;
    }) => void) | undefined;
    let terminateCalls = 0;
    const entry = {
        name: "manifest.json",
        ondata(_error: Error | null, _chunk: Uint8Array, _final: boolean) { },
        start() {
            this.ondata(null, new Uint8Array(1024 * 1024 + 1), false);
        },
        terminate() {
            terminateCalls++;
        }
    };
    const archive = {
        register() { },
        push() {
            handler?.(entry);
        }
    };

    await assert.rejects(
        unzipArchive(
            new File([new Uint8Array([1])], "expansion.zip", { type: "application/zip" }),
            callback => {
                handler = callback as typeof handler;
                return archive as never;
            }
        ),
        /oversized|large/i
    );
    assert.equal(terminateCalls, 1);
});

test("backup import rejects traversal paths and unlisted payloads", async () => {
    const manifest = {
        version: 1,
        sounds: [{
            path: "../escape.mp3",
            fileName: "escape.mp3",
            metadata: { name: "Escape", order: 0, type: "audio/mpeg", volume: 1, trimStart: 0 }
        }]
    };
    const archive = zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest)),
        "../escape.mp3": new Uint8Array([1])
    });

    await assert.rejects(
        readSoundboardBackup(new File([archive], "unsafe.zip", { type: "application/zip" })),
        /path|archive/i
    );
});
