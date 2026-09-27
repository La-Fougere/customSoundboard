/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { React } from "@webpack/common";

import {
    AudioInput,
    interceptSpeaking,
    isInputPlaying,
    mixInput,
    releaseInput,
    setAutoLevelMonitoring,
    setSpeakingOnMuteChange,
    shouldEnableInput,
    shutdownAudio
} from "./audio";
import { LibrarySettings, openSoundboard, SoundboardPanelButton, SoundboardVolumes } from "./components";
import { shouldInjectPanelButton } from "./core";

export const settings = definePluginSettings({
    volume: {
        type: OptionType.SLIDER,
        description: "Maximum soundboard volume sent to the voice channel",
        markers: makeRange(0, 1, 0.05),
        default: 0.5,
        stickToMarkers: false
    },
    monitorVolume: {
        type: OptionType.SLIDER,
        description: "Local soundboard monitoring volume",
        markers: makeRange(0, 1, 0.05),
        default: 0.8,
        stickToMarkers: false
    },
    autoLevelEnabled: {
        type: OptionType.BOOLEAN,
        description: "Automatically level transmitted sounds relative to your speaking volume",
        default: true,
        onChange: setAutoLevelMonitoring
    },
    relativeLevelDb: {
        type: OptionType.SLIDER,
        description: "Target soundboard level relative to your learned speaking volume",
        markers: makeRange(-18, 0, 1),
        default: -6,
        stickToMarkers: true
    },
    replaceNativeSoundboard: {
        type: OptionType.BOOLEAN,
        description: "Replace the Discord soundboard button action with Custom Soundboard",
        default: false,
        restartNeeded: true
    },
    library: {
        type: OptionType.COMPONENT,
        component: LibrarySettings
    }
});

function getSoundboardVolumes(): SoundboardVolumes {
    return {
        autoLevelEnabled: settings.store.autoLevelEnabled,
        monitorVolume: settings.store.monitorVolume,
        relativeLevelDb: settings.store.relativeLevelDb,
        sendVolume: settings.store.volume,
        onMonitorVolumeChange: value => settings.store.monitorVolume = value,
        onSendVolumeChange: value => settings.store.volume = value
    };
}

export default definePlugin({
    name: "CustomSoundboard",
    description: "Plays local audio files in voice channels through the microphone stream on Vesktop.",
    authors: [{ name: "1fougere", id: 552764242667765761n }],
    tags: ["Fun", "Voice"],
    settings,

    patches: [
        {
            find: "SoundboardRTCPanelButton",
            predicate: () => shouldInjectPanelButton(settings.store.replaceNativeSoundboard),
            replacement: {
                match: /children:\[(\i&&!\i\?\(0,\i\.jsx\)\(\i,{channel:\i}\):null),/,
                replace: "children:[$self.SoundboardPanelButton({}),$1,"
            }
        },
        {
            find: "SoundboardRTCPanelButton",
            predicate: () => settings.store.replaceNativeSoundboard,
            group: true,
            replacement: [
                {
                    match: /onClick:\(\)=>\{null!=\i&&\i!==\i\.\i\.CUSTOM_CALL_SOUNDS_PICKER_UPSELL&&\i\(\i\.\i\.UNKNOWN\),\i\(\),\i\(\),\(0,\i\.\i\)\(\i,\i\.\i\.SOUNDBOARD\)\}/,
                    replace: "onClick:()=>{$self.openSoundboard()}"
                },
                {
                    match: /disabled:\i(?=,onClick:.{0,250}?onMouseEnter:.{0,180}?onMouseLeave:.{0,180}?onContextMenu:\i,fullWidth:!0)/,
                    replace: "disabled:false"
                },
                {
                    match: /onMouseEnter:\(\)=>\{\i\(\),\i\(\)\},onMouseLeave:\(\)=>\{\i\(\),\i\(\)\},onContextMenu:\i,fullWidth:!0/,
                    replace: "onMouseEnter:()=>{},onMouseLeave:()=>{},onContextMenu:()=>{},fullWidth:!0"
                },
                {
                    match: /shouldShow:\i,position:"top",onRequestClose/,
                    replace: "shouldShow:false,position:\"top\",onRequestClose"
                },
                {
                    match: /event:(\i)\.(\i)\.TOGGLE_SOUNDBOARD,handler:\i\}\)/,
                    replace: "event:$1.$2.TOGGLE_SOUNDBOARD,handler:()=>{$self.openSoundboard();}})"
                }
            ]
        },
        {
            find: "ActionBarSoundboardButton",
            predicate: () => settings.store.replaceNativeSoundboard,
            group: true,
            replacement: [
                {
                    match: /onClick:\i,onMouseEnter:/,
                    replace: "onClick:()=>{$self.openSoundboard()},onMouseEnter:"
                },
                {
                    match: /shouldShow:\i,animation:(\i\.\i)\.Animation\.FADE/,
                    replace: "shouldShow:false,animation:$1.Animation.FADE"
                },
                {
                    match: /shouldShowSoundboardPicker:\i/,
                    replace: "shouldShowSoundboardPicker:false"
                }
            ]
        },
        {
            find: "AudioInput: No MediaStream",
            group: true,
            replacement: [
                {
                    match: /return this\.updateMode\(\),this\.updateAudioTracks\(\)/,
                    replace: "this.stream=$self.mixInput(this,this.stream);return this.updateMode(),this.updateAudioTracks()"
                },
                {
                    match: /release\((\i)\)\{\1\.getTracks\(\)/,
                    replace: "release($1){$self.releaseInput($1);$1.getTracks()"
                },
                {
                    match: /(?<=\.enabled=)!this\._mute/,
                    replace: "$self.shouldEnableInput(this)"
                },
                {
                    match: /set mute\((\i)\)\{this\._mute=\1,this\.updateAudioTracks\(\),this\.setSpeaking\(!1\)/,
                    replace: "set mute($1){this._mute=$1,this.updateAudioTracks(),$self.setSpeakingOnMuteChange(this)"
                },
                {
                    match: /setSpeaking\((\i)\)\{this\.speaking!==\1&&/,
                    replace: "setSpeaking($1){$1=$self.interceptSpeaking(this,$1),this.speaking!==$1&&"
                }
            ]
        }
    ],

    SoundboardPanelButton: ErrorBoundary.wrap((props: { nameplate?: unknown; }) => (
        React.createElement(SoundboardPanelButton, { ...props, ...getSoundboardVolumes() })
    ), { noop: true }),

    openSoundboard() {
        openSoundboard(getSoundboardVolumes());
    },

    mixInput(input: AudioInput, stream: MediaStream) {
        return mixInput(input, stream);
    },

    releaseInput(stream: MediaStream) {
        releaseInput(stream);
    },

    shouldEnableInput(input: AudioInput) {
        return shouldEnableInput(input);
    },

    setSpeakingOnMuteChange(input: AudioInput) {
        setSpeakingOnMuteChange(input);
    },

    interceptSpeaking(input: AudioInput, speaking: boolean) {
        return interceptSpeaking(input, speaking);
    },

    isInputPlaying(input: AudioInput) {
        return isInputPlaying(input);
    },

    stop() {
        shutdownAudio();
    }
});
