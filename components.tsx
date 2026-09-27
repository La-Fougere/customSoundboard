/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { PencilIcon } from "@components/Icons";
import { saveFile } from "@utils/web";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findLazy } from "@webpack";
import { ChannelStore, Forms, Modal, openModal, SelectedChannelStore, SelectedGuildStore, showToast, Slider, TextInput, Toasts, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentProps, ComponentType, SyntheticEvent } from "react";

import { getActiveSoundIds, hasVoiceInput, playSound, stopSound, subscribePlaybackState } from "./audio";
import { chooseEmojiGuildId, collectDirectImportFiles, DISCORD_CHAT_EMOJI_INTENTION, normalizeDiscordCdnEmoji, normalizeDiscordEmoji, selectVisibleSounds, SoundEmoji, StoredSound } from "./core";
import {
    clearLibrary,
    createBackup,
    disconnectSoundboardFolder,
    getLibrary,
    getSoundboardFolder,
    importFiles,
    moveSound,
    refreshSoundboardFolder,
    removeSound,
    restoreBackup,
    setSoundboardFolder,
    subscribeLibrary,
    toggleFavorite,
    updateSoundMetadata
} from "./library";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

type FileInputComponent = ComponentType<{
    filters?: { name?: string; extensions: string[]; }[];
    multiple?: boolean;
    onChange(event: SyntheticEvent<HTMLInputElement>): void;
}>;

const FileInput: FileInputComponent = findLazy(module => module.prototype?.activateUploadDialogue && module.prototype.setRef);
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "opus", "flac", "m4a", "aac", "webm"];

interface DiscordEmoji {
    animated?: boolean;
    id?: string | null;
    name?: string;
    surrogates?: string;
}

interface EmojiPickerProps {
    channel?: Channel;
    closePopout(): void;
    containerWidth?: number;
    guildId?: string;
    onSelectEmoji(emoji: DiscordEmoji): void;
    pickerIntention: number;
}

const EmojiPicker = findComponentByCodeLazy<EmojiPickerProps>(
    "shouldShowSoundmojiInEmojiPicker:",
    "onSelectEmoji:"
);


interface DirectoryPickerWindow extends Window {
    showDirectoryPicker(options?: { mode?: "read" | "readwrite"; }): Promise<FileSystemDirectoryHandle>;
}

export interface SoundboardVolumes {
    autoLevelEnabled: boolean;
    monitorVolume: number;
    relativeLevelDb: number;
    sendVolume: number;
    onMonitorVolumeChange(value: number): void;
    onSendVolumeChange(value: number): void;
}

function notifyError(error: unknown): void {
    const message = error instanceof Error ? error.message : "An unknown error occurred.";
    showToast(message, Toasts.Type.FAILURE);
}

function runUiAction(action: () => Promise<unknown>): void {
    void action().catch(notifyError);
}

function useLibrary(): StoredSound[] {
    const [sounds, setSounds] = useState<StoredSound[]>([]);

    useEffect(() => {
        let active = true;
        const reload = () => {
            void getLibrary()
                .then(value => {
                    if (active) setSounds([...value]);
                })
                .catch(notifyError);
        };
        reload();
        const unsubscribe = subscribeLibrary(reload);
        return () => {
            active = false;
            unsubscribe();
        };
    }, []);

    return sounds;
}

async function importAudioFiles(files: Iterable<File>): Promise<void> {
    const { files: supported, unsupportedCount } = collectDirectImportFiles(files);
    if (supported.length === 0) throw new Error("No supported audio file was selected.");

    const result = await importFiles(supported);
    const parts = [result.importedCount === 0
        ? "No new sounds imported."
        : `${result.importedCount} sound${result.importedCount === 1 ? "" : "s"} imported.`];
    if (unsupportedCount > 0) parts.push(`${unsupportedCount} unsupported file${unsupportedCount === 1 ? "" : "s"} skipped.`);
    parts.push(`${result.sounds.length} sound${result.sounds.length === 1 ? "" : "s"} in the library.`);
    showToast(parts.join(" "), Toasts.Type.SUCCESS);
}

interface FilePickerButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "onClick"> {
    extensions: string[];
    label: string;
    multiple?: boolean;
    onFiles(files: Iterable<File>): Promise<void> | void;
}

function FilePickerButton({ extensions, label, multiple = false, onFiles, ...buttonProps }: FilePickerButtonProps) {
    const [inputKey, setInputKey] = useState(0);
    const onChange = (event: SyntheticEvent<HTMLInputElement>) => {
        event.stopPropagation();
        event.preventDefault();
        const { files } = event.currentTarget;
        if (!files?.length) return;
        runUiAction(async () => {
            try {
                await onFiles(files);
            } finally {
                setInputKey(value => value + 1);
            }
        });
    };

    return (
        <Button {...buttonProps}>
            <span className="vc-csb-file-picker-label">
                {label}
                <FileInput
                    key={inputKey}
                    filters={[{ extensions }]}
                    multiple={multiple}
                    onChange={onChange}
                />
            </span>
        </Button>
    );
}

async function exportBackup(): Promise<void> {
    const archive = await createBackup();
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    saveFile(new File([archive], `custom-soundboard-${date}.zip`, { type: "application/zip" }));
    showToast("Complete soundboard backup exported.", Toasts.Type.SUCCESS);
}

function RestoreBackupModal({ file, modalProps }: { file: File; modalProps: RenderModalProps; }) {
    const [restoringMode, setRestoringMode] = useState<"add" | "replace" | null>(null);
    const restoringRef = useRef(false);
    const restore = (mode: "add" | "replace") => {
        if (restoringRef.current) return;
        restoringRef.current = true;
        setRestoringMode(mode);
        runUiAction(async () => {
            try {
                const result = await restoreBackup(file, mode);
                showToast(
                    `${result.importedCount} sound${result.importedCount === 1 ? "" : "s"} restored. ${result.sounds.length} sound${result.sounds.length === 1 ? "" : "s"} in the library.`,
                    Toasts.Type.SUCCESS
                );
            } finally {
                restoringRef.current = false;
                setRestoringMode(null);
            }
            modalProps.onClose();
        });
    };
    const restoring = restoringMode != null;
    return (
        <Modal
            {...modalProps}
            size="small"
            title="Restore Soundboard Backup"
            subtitle={file.name}
            actions={[
                { text: "Cancel", variant: "secondary", disabled: restoring, onClick: modalProps.onClose },
                { text: "Add", variant: "primary", disabled: restoring, loading: restoringMode === "add", onClick: () => restore("add") },
                { text: "Replace", variant: "dangerPrimary", disabled: restoring, loading: restoringMode === "replace", onClick: () => restore("replace") }
            ]}
        >
            <Forms.FormText>
                Add keeps the current library. Replace clears the current library before restoring this backup.
                Exact audio already present in a connected folder is reused. Missing audio is restored to local storage without modifying folder files.
            </Forms.FormText>
        </Modal>
    );
}

function openBackupFile(files: Iterable<File>): void {
    const file = files[Symbol.iterator]().next().value;
    if (!file) return;
    openModal(modalProps => <RestoreBackupModal file={file} modalProps={modalProps} />);
}

async function chooseFolder(): Promise<FileSystemDirectoryHandle> {
    const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) throw new Error("Folder selection is not supported by this client.");
    const handle = await picker.call(window, { mode: "read" });
    await setSoundboardFolder(handle);
    return handle;
}

function SoundIcon({ size = 20 }: { size?: number | string; }) {
    const pixelSize = typeof size === "number" ? size : 20;
    return (
        <svg width={pixelSize} height={pixelSize} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="2" fill="currentColor" />
            <rect x="14" y="3" width="7" height="7" rx="2" fill="currentColor" opacity=".8" />
            <rect x="3" y="14" width="7" height="7" rx="2" fill="currentColor" opacity=".8" />
            <path fill="currentColor" d="M16 13.5v4.1a2.8 2.8 0 1 0 1.5 2.5v-4.6l3-.7v1.3a1 1 0 0 0 2 0v-3.8a1 1 0 0 0-1.2-1l-4.5 1.1a1 1 0 0 0-.8 1.1Z" />
        </svg>
    );
}

function SoundEmojiIcon({ emoji, size = 30 }: { emoji?: SoundEmoji; size?: number; }) {
    if (!emoji) return <SoundIcon size={size} />;
    if (emoji.type === "unicode") {
        return <span className="vc-csb-sound-emoji" aria-hidden="true">{emoji.value}</span>;
    }
    const extension = emoji.animated ? "gif" : "webp";
    return (
        <img
            className="vc-csb-sound-emoji-image"
            src={`https://cdn.discordapp.com/emojis/${emoji.id}.${extension}?size=64&quality=lossless`}
            alt={`:${emoji.name}:`}
            width={size}
            height={size}
        />
    );
}

function EditSoundModal({ modalProps, sound }: { modalProps: RenderModalProps; sound: StoredSound; }) {
    const [name, setName] = useState(sound.name);
    const [emoji, setEmoji] = useState<SoundEmoji | null>(sound.emoji ?? null);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [trimEnd, setTrimEnd] = useState(sound.trimEnd?.toString() ?? "");
    const [trimStart, setTrimStart] = useState((sound.trimStart ?? 0).toString());
    const [volume, setVolume] = useState(sound.volume ?? 1);
    const trimmedName = name.trim();
    const parsedTrimStart = Number(trimStart);
    const parsedTrimEnd = trimEnd.trim() ? Number(trimEnd) : null;
    const trimValid = Number.isFinite(parsedTrimStart) && parsedTrimStart >= 0
        && (parsedTrimEnd == null || Number.isFinite(parsedTrimEnd) && parsedTrimEnd > parsedTrimStart);
    const voiceChannelId = SelectedChannelStore.getVoiceChannelId();
    const voiceChannel = voiceChannelId ? ChannelStore.getChannel(voiceChannelId) : undefined;
    const emojiGuildId = chooseEmojiGuildId(voiceChannel?.guild_id, SelectedGuildStore.getGuildId() ?? undefined);

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Edit Sound"
            subtitle={sound.fileName}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                {
                    text: "Save",
                    variant: "primary",
                    disabled: trimmedName.length === 0 || trimmedName.length > 80 || !trimValid,
                    onClick: () => runUiAction(async () => {
                        await updateSoundMetadata(sound.id, {
                            name,
                            emoji,
                            trimStart: parsedTrimStart,
                            trimEnd: parsedTrimEnd,
                            volume
                        });
                        showToast("Sound updated.", Toasts.Type.SUCCESS);
                        modalProps.onClose();
                    })
                }
            ]}
        >
            <div className="vc-csb-edit-sound">
                <label>
                    <strong>Name</strong>
                    <TextInput value={name} onChange={setName} maxLength={80} placeholder="Sound name" />
                </label>
                <div className="vc-csb-edit-field">
                    <div className="vc-csb-volume-label">
                        <strong>Sound Volume</strong>
                        <span>{Math.round(volume * 100)}%</span>
                    </div>
                    <Slider
                        initialValue={volume}
                        markers={[0, 0.5, 1, 1.5, 2]}
                        minValue={0}
                        maxValue={2}
                        onValueChange={setVolume}
                        onValueRender={value => `${Math.round(value * 100)}%`}
                        onMarkerRender={value => `${Math.round(value * 100)}%`}
                        stickToMarkers={false}
                    />
                    <Forms.FormText>Applied before Auto Level and the Send Volume Cap.</Forms.FormText>
                </div>
                <div className="vc-csb-trim-controls">
                    <label>
                        <strong>Start (seconds)</strong>
                        <input type="number" min="0" step="0.01" value={trimStart} onChange={event => setTrimStart(event.currentTarget.value)} />
                    </label>
                    <label>
                        <strong>End (seconds)</strong>
                        <input type="number" min="0" step="0.01" placeholder="Full length" value={trimEnd} onChange={event => setTrimEnd(event.currentTarget.value)} />
                    </label>
                    <Forms.FormText>Trim is non-destructive. Leave End empty to play through the original end.</Forms.FormText>
                </div>
                <div>
                    <strong>Button Emoji</strong>
                    <div className="vc-csb-emoji-controls">
                        <div className="vc-csb-emoji-preview"><SoundEmojiIcon emoji={emoji ?? undefined} /></div>
                        <Button size="small" variant="secondary" onClick={() => setShowEmojiPicker(value => !value)}>
                            {showEmojiPicker ? "Close Emoji Picker" : "Choose Discord Emoji"}
                        </Button>
                        <Button size="small" variant="secondary" disabled={!emoji} onClick={() => setEmoji(null)}>
                            Remove Emoji
                        </Button>
                    </div>
                    <Forms.FormText>Choose a Unicode emoji or a custom Discord emoji available in the picker.</Forms.FormText>
                </div>
                {showEmojiPicker && (
                    <div
                        className="vc-csb-emoji-picker"
                        onClickCapture={event => {
                            if (!(event.target instanceof HTMLImageElement)) return;
                            const selected = normalizeDiscordCdnEmoji(event.target.src, event.target.alt);
                            if (!selected) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setEmoji(selected);
                            setShowEmojiPicker(false);
                        }}
                    >
                        <EmojiPicker
                            pickerIntention={DISCORD_CHAT_EMOJI_INTENTION}
                            channel={voiceChannel}
                            guildId={emojiGuildId}
                            containerWidth={440}
                            closePopout={() => setShowEmojiPicker(false)}
                            onSelectEmoji={selected => {
                                const normalized = normalizeDiscordEmoji(selected);
                                if (!normalized) {
                                    showToast("This emoji could not be used.", Toasts.Type.FAILURE);
                                    return;
                                }
                                setEmoji(normalized);
                                setShowEmojiPicker(false);
                            }}
                        />
                    </div>
                )}
            </div>
        </Modal>
    );
}

function openEditSound(sound: StoredSound): void {
    openModal(modalProps => <EditSoundModal modalProps={modalProps} sound={sound} />);
}

async function play(
    sound: StoredSound,
    sendVolume: number,
    monitorVolume: number,
    autoLevelEnabled: boolean,
    relativeLevelDb: number
): Promise<void> {
    try {
        await playSound(sound, sendVolume, monitorVolume, {
            enabled: autoLevelEnabled,
            relativeDb: relativeLevelDb
        });
    } catch (error) {
        notifyError(error);
    }
}

function useActiveSounds(): Set<string> {
    const [activeIds, setActiveIds] = useState(() => new Set(getActiveSoundIds()));
    useEffect(() => subscribePlaybackState(ids => setActiveIds(new Set(ids))), []);
    return activeIds;
}

function useVoiceReady(): boolean {
    const [ready, setReady] = useState(hasVoiceInput());

    useEffect(() => {
        const update = () => setReady(hasVoiceInput());
        const timer = window.setInterval(update, 500);
        update();
        return () => window.clearInterval(timer);
    }, []);

    return ready;
}

function useFolderName(sounds: StoredSound[]): string | null {
    const [folderName, setFolderName] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        void getSoundboardFolder()
            .then(folder => {
                if (active) setFolderName(folder?.name ?? null);
            })
            .catch(notifyError);
        return () => { active = false; };
    }, [sounds]);

    return folderName;
}

function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange(value: number): void; }) {
    return (
        <div className="vc-csb-volume-control">
            <div className="vc-csb-volume-label">
                <strong>{label}</strong>
                <span>{Math.round(value * 100)}%</span>
            </div>
            <Slider
                initialValue={value}
                markers={[0, 0.25, 0.5, 0.75, 1]}
                minValue={0}
                maxValue={1}
                onValueChange={onChange}
                onValueRender={sliderValue => `${Math.round(sliderValue * 100)}%`}
                onMarkerRender={sliderValue => `${Math.round(sliderValue * 100)}%`}
                stickToMarkers={false}
            />
        </div>
    );
}

export function SoundboardModal({
    autoLevelEnabled,
    modalProps,
    monitorVolume: initialMonitorVolume,
    onMonitorVolumeChange,
    onSendVolumeChange,
    relativeLevelDb,
    sendVolume: initialSendVolume
}: { modalProps: RenderModalProps; } & SoundboardVolumes) {
    const sounds = useLibrary();
    const activeSounds = useActiveSounds();
    const folderName = useFolderName(sounds);
    const voiceReady = useVoiceReady();
    const [draggedSoundId, setDraggedSoundId] = useState<string | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const [monitorVolume, setMonitorVolume] = useState(initialMonitorVolume);
    const [query, setQuery] = useState("");
    const [sendVolume, setSendVolume] = useState(initialSendVolume);
    const visibleSounds = selectVisibleSounds(sounds, query);
    const updateMonitorVolume = (value: number) => {
        setMonitorVolume(value);
        onMonitorVolumeChange(value);
    };

    const updateSendVolume = (value: number) => {
        setSendVolume(value);
        onSendVolumeChange(value);
    };

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={
                <div className="vc-csb-modal-title">
                    <SoundIcon size={22} />
                    <span>Custom Soundboard</span>
                </div>
            }
            subtitle="Your local sounds, mixed directly into the voice stream."
        >
            <div
                className={`vc-csb-modal-content ${dropActive ? "vc-csb-drop-active" : ""}`}
                onDragEnter={event => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    setDropActive(true);
                }}
                onDragOver={event => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={event => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setDropActive(false);
                }}
                onDrop={event => {
                    event.preventDefault();
                    setDropActive(false);
                    if (event.dataTransfer.files.length > 0) runUiAction(() => importAudioFiles(event.dataTransfer.files));
                }}
            >
                {dropActive && <div className="vc-csb-drop-overlay">Drop audio files to import</div>}
                <div
                    className={`vc-csb-voice-status ${voiceReady ? "vc-csb-voice-ready" : "vc-csb-voice-offline"}`}
                    aria-live="polite"
                >
                    <span className="vc-csb-status-dot" />
                    <div>
                        <strong>{voiceReady ? "Ready to play" : "No voice connection"}</strong>
                        <span>
                            {voiceReady
                                ? "Sounds will be mixed into your microphone stream."
                                : "Join or reconnect to a voice channel to play a sound."}
                        </span>
                    </div>
                </div>

                <div className="vc-csb-volume-controls">
                    <VolumeControl label="Monitor Volume" value={monitorVolume} onChange={updateMonitorVolume} />
                    <VolumeControl label="Send Volume Cap" value={sendVolume} onChange={updateSendVolume} />
                </div>

                <div className="vc-csb-toolbar vc-csb-modal-toolbar">
                    <div className="vc-csb-toolbar-actions">
                        <FilePickerButton
                            extensions={AUDIO_EXTENSIONS}
                            label="Import Sounds"
                            multiple
                            onFiles={importAudioFiles}
                            size="small"
                        />
                        <Button size="small" variant="secondary" onClick={() => runUiAction(chooseFolder)}>
                            {folderName ? "Change Soundboard Folder" : "Choose Soundboard Folder"}
                        </Button>
                        <Button size="small" variant="secondary" disabled={!folderName} onClick={() => runUiAction(refreshSoundboardFolder)}>
                            Refresh Folder
                        </Button>
                        <Button size="small" variant="dangerSecondary" onClick={() => stopSound()}>
                            Stop Playback
                        </Button>
                    </div>
                    <span className="vc-csb-count">{sounds.length} sound{sounds.length === 1 ? "" : "s"}</span>
                </div>

                {sounds.length > 0 && (
                    <div className="vc-csb-search">
                        <TextInput value={query} onChange={setQuery} placeholder="Search sounds" aria-label="Search sounds" />
                        <span>{visibleSounds.length} shown</span>
                    </div>
                )}

                {sounds.length === 0
                    ? (
                        <div className="vc-csb-empty">
                            <SoundIcon size={38} />
                            <strong>No sounds in your library</strong>
                            <span>Import audio files here or choose a soundboard folder.</span>
                            <FilePickerButton
                                extensions={AUDIO_EXTENSIONS}
                                label="Choose Files"
                                multiple
                                onFiles={importAudioFiles}
                                size="small"
                            />
                        </div>
                    )
                    : (
                        <>
                            <div className="vc-csb-grid-help">Drag sounds to reorder them. Use the star to favorite or the pencil to edit.</div>
                            {visibleSounds.length === 0
                                ? <div className="vc-csb-empty vc-csb-no-results">No sounds match this search.</div>
                                : (
                                    <div className="vc-csb-grid">
                                        {visibleSounds.map(sound => (
                                            <div
                                                className={`vc-csb-sound-card ${activeSounds.has(sound.id) ? "vc-csb-sound-active" : ""}`}
                                                draggable
                                                key={sound.id}
                                                onDragStart={event => {
                                                    setDraggedSoundId(sound.id);
                                                    event.dataTransfer.effectAllowed = "move";
                                                    event.dataTransfer.setData("text/plain", sound.id);
                                                }}
                                                onDragEnd={() => setDraggedSoundId(null)}
                                                onDragOver={event => {
                                                    if (!draggedSoundId || draggedSoundId === sound.id) return;
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect = "move";
                                                }}
                                                onDrop={event => {
                                                    if (!draggedSoundId || draggedSoundId === sound.id) return;
                                                    event.preventDefault();
                                                    const draggedId = draggedSoundId;
                                                    setDraggedSoundId(null);
                                                    runUiAction(() => moveSound(draggedId, sound.id));
                                                }}
                                            >
                                                <button
                                                    className="vc-csb-sound"
                                                    aria-disabled={!voiceReady}
                                                    onClick={() => {
                                                        if (!voiceReady) return;
                                                        void play(
                                                            sound,
                                                            sendVolume,
                                                            monitorVolume,
                                                            autoLevelEnabled,
                                                            relativeLevelDb
                                                        );
                                                    }}
                                                    title={voiceReady ? sound.fileName : "Join a voice channel to play this sound"}
                                                >
                                                    <SoundEmojiIcon emoji={sound.emoji} size={30} />
                                                    <span>{sound.name}</span>
                                                </button>
                                                <button
                                                    className={`vc-csb-favorite ${sound.favorite ? "vc-csb-favorite-on" : ""}`}
                                                    aria-label={sound.favorite ? `Remove ${sound.name} from favorites` : `Add ${sound.name} to favorites`}
                                                    title={sound.favorite ? "Remove from favorites" : "Add to favorites"}
                                                    onClick={() => runUiAction(() => toggleFavorite(sound.id))}
                                                >
                                                    {sound.favorite ? "★" : "☆"}
                                                </button>
                                                <button
                                                    className="vc-csb-edit"
                                                    aria-label={`Edit ${sound.name}`}
                                                    title="Edit sound"
                                                    onClick={() => openEditSound(sound)}
                                                >
                                                    <PencilIcon />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                        </>
                    )}
            </div>
        </Modal>
    );
}

export function openSoundboard(volumes: SoundboardVolumes): void {
    openModal(modalProps => <SoundboardModal modalProps={modalProps} {...volumes} />);
}

export function SoundboardPanelButton({ nameplate, ...volumes }: SoundboardVolumes & { nameplate?: unknown; }) {
    return (
        <PanelButton
            tooltipText="Open Custom Soundboard"
            icon={SoundIcon}
            plated={nameplate != null}
            onClick={() => openSoundboard(volumes)}
        />
    );
}

function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function LibrarySettings() {
    const sounds = useLibrary();
    const folderName = useFolderName(sounds);
    const totalBytes = sounds.reduce((total, sound) => total + sound.size, 0);

    return (
        <div className="vc-csb-settings">
            <Forms.FormTitle>Local Library</Forms.FormTitle>
            <Forms.FormText>
                Imported files are stored locally in IndexedDB. The selected folder can be rescanned at any time.
            </Forms.FormText>
            <div className="vc-csb-toolbar">
                <FilePickerButton
                    extensions={AUDIO_EXTENSIONS}
                    label="Import Files"
                    multiple
                    onFiles={importAudioFiles}
                    size="small"
                />
                <Button size="small" variant="secondary" onClick={() => runUiAction(chooseFolder)}>
                    {folderName ? "Change Soundboard Folder" : "Choose Soundboard Folder"}
                </Button>
                <Button size="small" variant="secondary" disabled={!folderName} onClick={() => runUiAction(refreshSoundboardFolder)}>
                    Rescan
                </Button>
                <Button size="small" variant="secondary" disabled={!folderName} onClick={() => runUiAction(disconnectSoundboardFolder)}>
                    Disconnect Folder
                </Button>
                <Button size="small" variant="secondary" disabled={sounds.length === 0} onClick={() => runUiAction(exportBackup)}>
                    Export Backup
                </Button>
                <FilePickerButton
                    extensions={["zip"]}
                    label="Import Backup"
                    onFiles={openBackupFile}
                    size="small"
                    variant="secondary"
                />
                <Button size="small" variant="dangerSecondary" disabled={sounds.length === 0 && !folderName} onClick={() => runUiAction(clearLibrary)}>
                    Delete All
                </Button>
            </div>
            <div className="vc-csb-folder">
                Folder: <strong>{folderName ?? "None"}</strong>
            </div>
            <div className="vc-csb-library">
                {sounds.length === 0 && <div className="vc-csb-empty">The library is empty.</div>}
                {sounds.map(sound => (
                    <div className="vc-csb-library-row" key={sound.id}>
                        <div>
                            <strong>{sound.name}</strong>
                            <span>{sound.source === "folder" ? "Folder" : "Imported"} · {formatBytes(sound.size)}</span>
                        </div>
                        <Button size="xs" variant="dangerSecondary" onClick={() => runUiAction(() => removeSound(sound.id))}>Delete</Button>
                    </div>
                ))}
            </div>
            <div className="vc-csb-diagnostic">
                <strong>Diagnostic</strong>
                <span>Sounds: {sounds.length} / 200</span>
                <span>Audio storage: {formatBytes(totalBytes)} / 500 MiB</span>
                <span>Connected folder: {folderName ?? "None"}</span>
                <span>Folder import support: {"showDirectoryPicker" in window ? "Available" : "Unavailable"}</span>
                <span>Concurrent playback limit: 8</span>
            </div>
            <Forms.FormText className="vc-csb-source-hint">
                Looking for more sounds? Try MyInstants. (Not affiliated with MyInstants.)
            </Forms.FormText>
        </div>
    );
}
