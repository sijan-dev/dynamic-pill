import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Priority } from '../state.js';

export class VolumeModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._mixer = null;
        this._signals = [];
        this._debounceId = null;
        this._lastLevel = -1;
    }

    enable() {
        // Try Gvc first
        try {
            const Gvc = (globalThis.imports && globalThis.imports.gi && globalThis.imports.gi.Gvc) || null;
            if (Gvc) {
                this._mixer = new Gvc.MixerControl({ name: 'DynamicPill Volume' });
                this._mixer.open();
                const id = this._mixer.connect('default-sink-changed', (mixer, id) => this._onSinkChanged());
                this._signals.push([this._mixer, id]);
                // Also connect to stream changes via idle
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    this._hookSink();
                    return GLib.SOURCE_REMOVE;
                });
                log('[DynamicPill] Volume: using Gvc.MixerControl');
                return;
            }
        } catch (e) {
            log(`[DynamicPill] Gvc not available, falling back: ${e.message}`);
        }

        // Fallback: listen to GNOME Shell OSD via DBus ShowOSD
        try {
            this._osdSubId = Gio.DBus.session.signal_subscribe(
                null,
                'org.gnome.Shell',
                'ShowOSD',
                '/org/gnome/Shell',
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => this._onShowOSD(params)
            );
            log('[DynamicPill] Volume: using Shell ShowOSD fallback');
        } catch (e) {
            log(`[DynamicPill] Volume fallback failed: ${e}`);
        }

        // Additional fallback: poll via pactl only when we can detect change via shell keybinding?
        // We also hook MediaKeys volume signals via D-Bus
        try {
            this._mediaKeysId = Gio.DBus.session.signal_subscribe(
                'org.gnome.SettingsDaemon.MediaKeys',
                'org.gnome.SettingsDaemon.MediaKeys',
                null, null, null,
                Gio.DBusSignalFlags.NONE,
                () => {}
            );
        } catch (e) {}

        // Try PulseAudio D-Bus: org.PulseAudio1
        // As last resort, use Gio.Settings for sound? Not reliable for level.
        // We create a simple listener for `amixer`-style via shell OSD already covers most.
    }

    _hookSink() {
        if (!this._mixer) return;
        try {
            const sink = this._mixer.get_default_sink();
            if (!sink) return;
            const id1 = sink.connect('notify::volume', () => this._onVolumeChanged());
            const id2 = sink.connect('notify::is-muted', () => this._onVolumeChanged());
            this._signals.push([sink, id1], [sink, id2]);
        } catch (e) { }
    }

    _onSinkChanged() {
        this._hookSink();
        this._onVolumeChanged();
    }

    _onVolumeChanged() {
        if (this._debounceId) GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._debounceId = null;
            try {
                const sink = this._mixer.get_default_sink();
                if (!sink) return GLib.SOURCE_REMOVE;
                const vol = sink.get_volume();
                const max = this._mixer.get_vol_max_norm();
                const level = max ? vol / max : 0;
                const muted = sink.get_is_muted();
                if (Math.abs(level - this._lastLevel) < 0.005 && muted === this._lastMuted) return GLib.SOURCE_REMOVE;
                this._lastLevel = level;
                this._lastMuted = muted;
                this._stateManager.push({
                    id: 'volume',
                    priority: Priority.VOLUME,
                    view: 'volume',
                    data: { level, muted },
                    duration: 2200,
                });
            } catch (e) { }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onShowOSD(params) {
        try {
            const unpacked = params.recursiveUnpack();
            const _u = v => (v && typeof v === 'object' && v.unpack) ? v.unpack() : v;
            // ShowOSD params is a{sv} with keys like 'level', 'icon', 'label'
            // Example: {'icon': <'audio-volume-high-symbolic'>, 'level': <0.72>}
            let level, icon;
            if (Array.isArray(unpacked)) {
                const dict = unpacked[0];
                if (dict && typeof dict === 'object') {
                    level = dict['level'] !== undefined ? _u(dict['level']) : undefined;
                    icon = dict['icon'] !== undefined ? _u(dict['icon']) : undefined;
                }
            } else if (unpacked && typeof unpacked === 'object') {
                level = unpacked['level'] !== undefined ? _u(unpacked['level']) : undefined;
                icon = unpacked['icon'] !== undefined ? _u(unpacked['icon']) : undefined;
            }
            if (level !== undefined || (icon && icon.includes('audio-volume'))) {
                const muted = icon && icon.includes('muted');
                const lvl = level !== undefined ? level : this._lastLevel;
                this._stateManager.push({
                    id: 'volume',
                    priority: Priority.VOLUME,
                    view: 'volume',
                    data: { level: muted ? 0 : (lvl ?? 0.5), muted },
                    duration: 2200,
                });
            }
        } catch (e) { }
    }

    disable() {
        if (this._debounceId) { GLib.source_remove(this._debounceId); this._debounceId = null; }
        for (const [obj, id] of this._signals) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._signals = [];
        if (this._mixer) { try { this._mixer.close(); } catch (e) {} this._mixer = null; }
        if (this._osdSubId) { try { Gio.DBus.session.signal_unsubscribe(this._osdSubId); } catch (e) {} this._osdSubId = null; }
        if (this._mediaKeysId) { try { Gio.DBus.session.signal_unsubscribe(this._mediaKeysId); } catch (e) {} }
    }
}
