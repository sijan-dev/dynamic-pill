import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

// Newer St (GNOME 46+) dropped the construct-only "spacing" property from
// St.BoxLayout — spacing is now expressed purely through CSS. This wrapper
// keeps the old call sites unchanged while applying spacing via inline style.
function newBoxLayout(props = {}) {
    const { spacing, ...rest } = props;
    const box = new St.BoxLayout(rest);
    if (spacing !== undefined && spacing !== null)
        box.style = `${rest.style ? rest.style + ' ' : ''}spacing: ${spacing}px;`;
    return box;
}

export class DynamicPill {
    constructor(stateManager, settings, extensionPath) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._extensionPath = extensionPath;

        this._container = null;
        this._pill = null;
        this._contentBox = null;
        this._currentView = null;
        this._views = new Map();
        this._idleClockId = null;
        this._hoverTimeoutId = null;
        this._leaveTimeoutId = null;

        this._animationDuration = settings ? settings.get_int('animation-speed') : 260;

        // Dashboard internals
        this._dashboardData = null;
        this._volumeSlider = null;
        this._brightnessSlider = null;
        this._mixer = null;
        this._mixerSignals = [];
        this._brightnessProxy = null;
        this._brightnessSigId = null;
        this._mediaCache = null; // last MPRIS data

        this._createActor();
        this._bindSettings();
        this._setupStateListener();
        this._setupClock();
        this._updatePosition();
        this._listenMediaForDashboard();
    }

    _createActor() {
        // Container positions the pill at top center
        this._container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style: 'padding-top: 6px;',
        });

        // The actual pill
        this._pill = newBoxLayout({
            style_class: 'dynamic-pill',
            vertical: false,
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 255,
            clip_to_allocation: true,
            x_expand: false,
            y_expand: false,
        });

        // Content box inside pill
        this._contentBox = newBoxLayout({
            style_class: 'dynamic-pill-content',
            vertical: false,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });

        this._pill.add_child(this._contentBox);
        this._container.add_child(this._pill);
        // ensure no leftover scale from previous animation
        this._pill.set_scale(1.0, 1.0);

        // Make pill clickable
        this._pill.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === 1) {
                this._handleClick();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Hover behavior
        this._pill.connect('enter-event', () => {
            if (!this._settings.get_boolean('hover-expand')) return Clutter.EVENT_PROPAGATE;
            if (this._hoverTimeoutId) GLib.source_remove(this._hoverTimeoutId);
            if (this._leaveTimeoutId) {
                GLib.source_remove(this._leaveTimeoutId);
                this._leaveTimeoutId = null;
            }
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._hoverTimeoutId = null;
                if (this._stateManager.state === 'idle') {
                    // Gentle expand — show a hint
                    this._pill.add_style_pseudo_class('hover');
                }
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });

        this._pill.connect('leave-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (this._leaveTimeoutId) GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._leaveTimeoutId = null;
                this._pill.remove_style_pseudo_class('hover');
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });

        // Add to Chrome — keeps it above windows but respects overview
        Main.layoutManager.addTopChrome(this._container, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        // Ensure correct layering: behind panel but above background, or above panel centered
        this._container.set_z_position(10);
        this._syncMonitor();
        this._syncOpacity();

        // Initially idle
        this._showIdleView();
    }

    _bindSettings() {
        if (!this._settings) return;

        this._settings.connect('changed::vertical-offset', () => this._updatePosition());
        this._settings.connect('changed::position', () => this._updatePosition());
        this._settings.connect('changed::monitor-mode', () => this._syncMonitor());
        this._settings.connect('changed::animation-speed', () => {
            this._animationDuration = this._settings.get_int('animation-speed');
        });
        this._settings.connect('changed::pill-opacity', () => this._syncOpacity());
        this._settings.connect('changed::compact-mode', () => this._syncCompact());
        this._settings.connect('changed::show-shadow', () => this._syncShadow());

        // Monitor changes
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._syncMonitor(),
            this._container
        );
    }

    _syncOpacity() {
        const op = this._settings ? this._settings.get_double('pill-opacity') : 0.92;
        // St opacity 0-255; use style for background alpha instead of actor opacity
        // but also set actor opacity slightly
        this._pill.opacity = Math.round(255 * Math.min(1, Math.max(0.5, op + 0.08)));
    }

    _syncCompact() {
        const compact = this._settings ? this._settings.get_boolean('compact-mode') : false;
        if (compact) this._pill.add_style_class_name('compact');
        else this._pill.remove_style_class_name('compact');
    }

    _syncShadow() {
        const show = this._settings ? this._settings.get_boolean('show-shadow') : true;
        if (!show) this._pill.set_style('box-shadow: none;');
        else this._pill.set_style(null);
    }

    _updatePosition() {
        const offset = this._settings ? this._settings.get_int('vertical-offset') : 6;
        const position = this._settings ? this._settings.get_string('position') : 'top-center';

        let y = offset;
        // Try to place just below panel height if panel visible
        try {
            const panelH = Main.panel ? Main.panel.height : 0;
            if (position === 'below-panel') y = panelH + offset;
            else if (position === 'panel-integrated') y = Math.max(0, (panelH - this._pill.height) / 2);
            else y = offset; // top-center
        } catch (e) { y = offset; }

        this._container.set_style(`padding-top: ${y}px;`);
    }

    _syncMonitor() {
        try {
            const mode = this._settings ? this._settings.get_string('monitor-mode') : 'primary';
            let monitorIndex = Main.layoutManager.primaryIndex;
            if (mode === 'active') {
                monitorIndex = global.display ? global.display.get_current_monitor() : monitorIndex;
            }
            const monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
            if (monitor) {
                // Center horizontally on that monitor
                this._container.set_width(monitor.width);
                this._container.set_position(monitor.x, monitor.y);
            }
        } catch (e) {
            log(`[DynamicPill] monitor sync error: ${e}`);
        }
    }

    _setupClock() {
        this._updateIdleClock();
        this._idleClockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateIdleClock();
            return GLib.SOURCE_CONTINUE;
        });
        // Also update exactly at next minute boundary
        const now = GLib.DateTime.new_now_local();
        const secsToNextMinute = 60 - now.get_second();
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secsToNextMinute, () => {
            this._updateIdleClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIdleClock() {
        if (this._currentView !== 'idle') return;
        const label = this._views.get('idle-label');
        if (label) {
            const fmt = this._settings ? this._settings.get_string('idle-time-format') : '%H:%M';
            const dt = GLib.DateTime.new_now_local();
            const str = dt ? dt.format(fmt) : '--:--';
            label.text = str;
        }
    }

    _setupStateListener() {
        this._stateListener = (event, state) => {
            this._onStateChanged(event, state);
        };
        this._stateManager.addListener(this._stateListener);
        // Start idle
        this._stateManager.showIdle();
    }

    _listenMediaForDashboard() {
        // Cache last media event to show in dashboard even when idle
        this._mediaListener = (event) => {
            if (event && event.view === 'media') {
                this._mediaCache = event.data;
                // If dashboard is open, update its media row live
                if (this._currentView === 'dashboard') {
                    this._updateDashboardMedia();
                }
            }
        };
        this._stateManager.addListener(this._mediaListener);
    }

    _onStateChanged(event, state) {
        if (!event) return;
        // If dashboard is open and a volume/brightness event arrives, just update sliders
        if (this._currentView === 'dashboard' && (event.view === 'volume' || event.view === 'brightness')) {
            if (event.view === 'volume' && this._volumeSlider) {
                this._volumeSlider._ignoreNotify = true;
                this._volumeSlider.value = event.data.muted ? 0 : event.data.level;
                this._volumeSlider._ignoreNotify = false;
            }
            if (event.view === 'brightness' && this._brightnessSlider) {
                this._brightnessSlider._ignoreNotify = true;
                this._brightnessSlider.value = event.data.level;
                this._brightnessSlider._ignoreNotify = false;
            }
            return;
        }
        if (event.id === 'idle') {
            this._animateToView('idle', event.data);
        } else {
            this._animateToView(event.view, event.data, event);
        }
    }

    _handleClick() {
        const cur = this._stateManager.current;
        if (!cur || cur.id === 'idle') {
            // Idle click: toggle in-pill dashboard (A) — no external window
            this._stateManager.push({
                id: 'dashboard',
                priority: 15, // Priority.DASHBOARD
                view: 'dashboard',
                data: {},
                duration: 8000,
            });
            return;
        }
        if (cur.id === 'dashboard') {
            this._stateManager.forceIdle();
            return;
        }

        // View-specific actions for transient pills — keep inside pill where possible
        switch (cur.view) {
            case 'media':
                try {
                    const player = cur.data?._playerName;
                    if (player) {
                        Gio.DBus.session.call(
                            `org.mpris.MediaPlayer2.${player}`,
                            '/org/mpris/MediaPlayer2',
                            'org.mpris.MediaPlayer2',
                            'Raise',
                            null, null, Gio.DBusCallFlags.NONE, -1, null, null
                        );
                    }
                } catch (e) { }
                break;
            case 'notification':
                this._stateManager.dismiss(cur.id);
                break;
            case 'volume':
            case 'brightness':
            case 'battery':
            case 'workspace':
            case 'generic':
                // For transient pills, click toggles dashboard instead of opening external settings
                this._stateManager.push({
                    id: 'dashboard',
                    priority: 15,
                    view: 'dashboard',
                    data: {},
                    duration: 8000,
                });
                break;
            default:
                this._stateManager.forceIdle();
                break;
        }
    }

    _clearContent() {
        this._cleanupDashboardResources();
        this._contentBox.remove_all_children();
        this._views.clear();
    }

    _cleanupDashboardResources() {
        if (this._mixer && this._mixerSignals.length) {
            for (const [obj, id] of this._mixerSignals) {
                try { obj.disconnect(id); } catch (e) {}
            }
            this._mixerSignals = [];
        }
        if (this._brightnessProxy && this._brightnessSigId) {
            try { this._brightnessProxy.disconnect(this._brightnessSigId); } catch (e) {}
            this._brightnessSigId = null;
        }
        // Don't close mixer persistently — keep for reuse
        this._volumeSlider = null;
        this._brightnessSlider = null;
    }

    _showIdleView() {
        this._clearContent();
        this._currentView = 'idle';

        const box = newBoxLayout({
            style_class: 'dynamic-pill-idle',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const fmt = this._settings ? this._settings.get_string('idle-time-format') : '%H:%M';
        const dt = GLib.DateTime.new_now_local();
        const text = dt ? dt.format(fmt) : '--:--';

        const label = new St.Label({
            text,
            style_class: 'dynamic-pill-idle-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'text-align: center;',
        });
        label.clutter_text.set_single_line_mode(true);
        label.clutter_text.set_ellipsize(0);

        box.add_child(label);
        this._contentBox.add_child(box);
        this._views.set('idle-label', label);
        this._views.set('idle-box', box);
    }

    _ensureMixer() {
        if (this._mixer) return this._mixer;
        try {
            const Gvc = (globalThis.imports && globalThis.imports.gi && globalThis.imports.gi.Gvc) || null;
            if (Gvc) {
                this._mixer = new Gvc.MixerControl({ name: 'DynamicPill Dashboard' });
                this._mixer.open();
                // Hook sink after a short delay
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    try {
                        const sink = this._mixer.get_default_sink();
                        if (sink) {
                            const id1 = sink.connect('notify::volume', () => this._onMixerVolumeChanged());
                            const id2 = sink.connect('notify::is-muted', () => this._onMixerVolumeChanged());
                            this._mixerSignals.push([sink, id1], [sink, id2]);
                        }
                    } catch (e) {}
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) { log(`[DynamicPill] dashboard mixer init failed: ${e}`); }
        return this._mixer;
    }

    _onMixerVolumeChanged() {
        if (this._currentView !== 'dashboard' || !this._volumeSlider) return;
        try {
            const sink = this._mixer.get_default_sink();
            if (!sink) return;
            const vol = sink.get_volume();
            const max = this._mixer.get_vol_max_norm();
            const level = max ? vol / max : 0;
            const muted = sink.get_is_muted();
            this._volumeSlider._ignoreNotify = true;
            this._volumeSlider.value = muted ? 0 : level;
            this._volumeSlider._ignoreNotify = false;
        } catch (e) {}
    }

    _ensureBrightnessProxy() {
        if (this._brightnessProxy) return;
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen',
                null,
                (proxy, res) => {
                    try {
                        this._brightnessProxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (this._brightnessProxy) {
                            const pct = this._brightnessProxy.get_cached_property('Brightness')?.unpack() ?? 50;
                            if (this._brightnessSlider) {
                                this._brightnessSlider._ignoreNotify = true;
                                this._brightnessSlider.value = pct / 100;
                                this._brightnessSlider._ignoreNotify = false;
                            }
                            this._brightnessSigId = this._brightnessProxy.connect('g-properties-changed', (p, props) => {
                                try {
                                    const dict = props.recursiveUnpack();
                                    const _u = v => (v && typeof v === 'object' && v.unpack) ? v.unpack() : v;
                                    if ('Brightness' in dict) {
                                        const lvl = _u(dict['Brightness']) / 100;
                                        if (this._brightnessSlider) {
                                            this._brightnessSlider._ignoreNotify = true;
                                            this._brightnessSlider.value = lvl;
                                            this._brightnessSlider._ignoreNotify = false;
                                        }
                                    }
                                } catch (e) {}
                            });
                        }
                    } catch (e) {}
                }
            );
        } catch (e) {}
    }

    _initDashboardToggles(wifiBtn, btBtn, micBtn) {
        // Wi-Fi — org.freedesktop.NetworkManager WirelessEnabled
        try {
            Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', null,
                (p, res) => {
                    try {
                        const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (!proxy) return;
                        this._wifiProxy = proxy;
                        const enabled = proxy.get_cached_property('WirelessEnabled')?.unpack() ?? true;
                        wifiBtn.checked = enabled;
                        wifiBtn.style_class = `dynamic-pill-toggle ${enabled ? 'active' : ''}`;
                        // Click toggles
                        wifiBtn.connect('clicked', () => {
                            const cur = wifiBtn.checked;
                            const next = !cur;
                            wifiBtn.checked = next;
                            wifiBtn.style_class = `dynamic-pill-toggle ${next ? 'active' : ''}`;
                            proxy.call('Set', new GLib.Variant('(ssv)', ['org.freedesktop.NetworkManager', 'WirelessEnabled', new GLib.Variant('b', next)]),
                                Gio.DBusCallFlags.NONE, -1, null, () => {});
                            // also via Properties.Set
                            Gio.DBus.system.call('org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.DBus.Properties', 'Set',
                                new GLib.Variant('(ssv)', ['org.freedesktop.NetworkManager', 'WirelessEnabled', new GLib.Variant('b', next)]),
                                null, Gio.DBusCallFlags.NONE, -1, null, null);
                        });
                        proxy.connect('g-properties-changed', (pr, props) => {
                            try {
                                const dict = props.recursiveUnpack();
                                const _u = v => (v && typeof v === 'object' && v.unpack) ? v.unpack() : v;
                                if ('WirelessEnabled' in dict) {
                                    const en = _u(dict['WirelessEnabled']);
                                    wifiBtn.checked = en;
                                    wifiBtn.style_class = `dynamic-pill-toggle ${en ? 'active' : ''}`;
                                }
                            } catch (e) {}
                        });
                    } catch (e) {}
                });
        } catch (e) { log(`[DynamicPill] wifi toggle init failed: ${e}`); }

        // Bluetooth — BlueZ Adapter1 Powered (fallback to no-op if no adapter)
        try {
            // Try common adapter path
            const tryAdapter = (path) => {
                Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                    'org.bluez', path, 'org.bluez.Adapter1', null,
                    (pr, res) => {
                        try {
                            const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                            if (!proxy) return;
                            this._btProxy = proxy;
                            const powered = proxy.get_cached_property('Powered')?.unpack() ?? false;
                            btBtn.checked = powered;
                            btBtn.style_class = `dynamic-pill-toggle ${powered ? 'active' : ''}`;
                            btBtn.connect('clicked', () => {
                                const cur = btBtn.checked;
                                const next = !cur;
                                btBtn.checked = next;
                                btBtn.style_class = `dynamic-pill-toggle ${next ? 'active' : ''}`;
                                Gio.DBus.system.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'Set',
                                    new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered', new GLib.Variant('b', next)]),
                                    null, Gio.DBusCallFlags.NONE, -1, null, null);
                            });
                            proxy.connect('g-properties-changed', (p, props) => {
                                try {
                                    const dict = props.recursiveUnpack();
                                    const _u = v => (v && typeof v === 'object' && v.unpack) ? v.unpack() : v;
                                    if ('Powered' in dict) {
                                        const pw = _u(dict['Powered']);
                                        btBtn.checked = pw;
                                        btBtn.style_class = `dynamic-pill-toggle ${pw ? 'active' : ''}`;
                                    }
                                } catch (e) {}
                            });
                        } catch (e) {}
                    });
            };
            tryAdapter('/org/bluez/hci0');
            // Also listen for adapter added later — no-op for minimal B
        } catch (e) { log(`[DynamicPill] bt toggle init failed: ${e}`); }

        // Mic — Gvc default source (input) mute toggle
        try {
            const Gvc = (globalThis.imports && globalThis.imports.gi && globalThis.imports.gi.Gvc) || null;
            if (Gvc && this._mixer) {
                const src = this._mixer.get_default_source?.();
                if (src) {
                    const muted = src.get_is_muted();
                    micBtn.checked = !muted;
                    micBtn.style_class = `dynamic-pill-toggle ${!muted ? 'active' : ''}`;
                    micBtn.connect('clicked', () => {
                        const curMuted = src.get_is_muted();
                        src.set_is_muted(!curMuted);
                        const nowMuted = src.get_is_muted();
                        micBtn.checked = !nowMuted;
                        micBtn.style_class = `dynamic-pill-toggle ${!nowMuted ? 'active' : ''}`;
                    });
                    const sid = src.connect('notify::is-muted', () => {
                        const m = src.get_is_muted();
                        micBtn.checked = !m;
                        micBtn.style_class = `dynamic-pill-toggle ${!m ? 'active' : ''}`;
                    });
                    this._mixerSignals.push([src, sid]);
                } else {
                    // No mic source — keep active placeholder, toggle just flips UI
                    micBtn.connect('clicked', () => {
                        micBtn.checked = !micBtn.checked;
                        micBtn.style_class = `dynamic-pill-toggle ${micBtn.checked ? 'active' : ''}`;
                    });
                }
            } else {
                micBtn.connect('clicked', () => {
                    micBtn.checked = !micBtn.checked;
                    micBtn.style_class = `dynamic-pill-toggle ${micBtn.checked ? 'active' : ''}`;
                });
            }
        } catch (e) { log(`[DynamicPill] mic toggle init failed: ${e}`); }
    }

    _showDashboardView() {
        this._clearContent();
        this._currentView = 'dashboard';

        const outer = newBoxLayout({
            vertical: true,
            style_class: 'dynamic-pill-dashboard',
            x_expand: false,
            y_expand: false,
            spacing: 10,
            width: 420,
        });

        // Media row (if cached)
        const media = this._mediaCache;
        if (media) {
            const mediaRow = newBoxLayout({ vertical: false, spacing: 10, style_class: 'dynamic-pill-dashboard-media', x_expand: true });
            const artBox = new St.Widget({ style_class: 'dynamic-pill-media-art', width: 44, height: 44, layout_manager: new Clutter.BinLayout() });
            const artIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 22, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            artBox.add_child(artIcon);
            const textCol = newBoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            const title = new St.Label({ text: media.title || 'No track', style_class: 'dynamic-pill-media-title' });
            title.clutter_text.set_single_line_mode(true);
            const artist = new St.Label({ text: media.artist || media.album || 'Unknown', style_class: 'dynamic-pill-media-artist' });
            artist.clutter_text.set_single_line_mode(true);
            textCol.add_child(title);
            textCol.add_child(artist);
            const controls = newBoxLayout({ vertical: false, spacing: 6, y_align: Clutter.ActorAlign.CENTER, style_class: 'dynamic-pill-media-controls' });
            const prevBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
            prevBtn.add_child(new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 14 }));
            prevBtn.connect('clicked', () => this._mediaAction(media._playerName, 'Previous'));
            const playIconName = media.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            const playBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
            playBtn.add_child(new St.Icon({ icon_name: playIconName, icon_size: 16 }));
            playBtn.connect('clicked', () => this._mediaAction(media._playerName, 'PlayPause'));
            const nextBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
            nextBtn.add_child(new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 14 }));
            nextBtn.connect('clicked', () => this._mediaAction(media._playerName, 'Next'));
            controls.add_child(prevBtn); controls.add_child(playBtn); controls.add_child(nextBtn);
            mediaRow.add_child(artBox); mediaRow.add_child(textCol); mediaRow.add_child(controls);
            outer.add_child(mediaRow);
            this._views.set('dashboard-media-title', title);
            this._views.set('dashboard-media-artist', artist);
            // separator
            const sep = new St.Widget({ style_class: 'dynamic-pill-dashboard-sep', x_expand: true, height: 1 });
            outer.add_child(sep);
        } else {
            const hint = new St.Label({ text: 'No media playing — sliders below', style_class: 'dynamic-pill-subtitle', x_align: Clutter.ActorAlign.CENTER });
            outer.add_child(hint);
        }

        // Sliders row: volume + brightness
        const slidersRow = newBoxLayout({ vertical: false, spacing: 16, x_expand: true });

        // Volume column
        const volCol = newBoxLayout({ vertical: true, x_expand: true, spacing: 4 });
        const volHeader = newBoxLayout({ vertical: false, spacing: 6 });
        volHeader.add_child(new St.Icon({ icon_name: 'audio-volume-high-symbolic', style_class: 'dynamic-pill-icon', icon_size: 14 }));
        volHeader.add_child(new St.Label({ text: 'Volume', style_class: 'dynamic-pill-title', x_expand: true }));
        const volValueLabel = new St.Label({ text: '—', style_class: 'dynamic-pill-subtitle' });
        volHeader.add_child(volValueLabel);
        volCol.add_child(volHeader);
        const volSlider = new Slider.Slider(0.5);
        volSlider.x_expand = true;
        volCol.add_child(volSlider);
        slidersRow.add_child(volCol);

        // Brightness column
        const briCol = newBoxLayout({ vertical: true, x_expand: true, spacing: 4 });
        const briHeader = newBoxLayout({ vertical: false, spacing: 6 });
        briHeader.add_child(new St.Icon({ icon_name: 'display-brightness-symbolic', style_class: 'dynamic-pill-icon', icon_size: 14 }));
        briHeader.add_child(new St.Label({ text: 'Brightness', style_class: 'dynamic-pill-title', x_expand: true }));
        const briValueLabel = new St.Label({ text: '—', style_class: 'dynamic-pill-subtitle' });
        briHeader.add_child(briValueLabel);
        briCol.add_child(briHeader);
        const briSlider = new Slider.Slider(0.5);
        briSlider.x_expand = true;
        briCol.add_child(briSlider);
        slidersRow.add_child(briCol);

        outer.add_child(slidersRow);

        // Toggles row: Wi-Fi / Bluetooth / Mic — all inside pill (B)
        const togglesRow = newBoxLayout({ vertical: false, spacing: 8, x_expand: true, style_class: 'dynamic-pill-toggles', y_align: Clutter.ActorAlign.CENTER });
        const makeToggle = (iconName, labelText, active) => {
            const btn = new St.Button({ style_class: `dynamic-pill-toggle ${active ? 'active' : ''}`, can_focus: true, toggle_mode: true, checked: active });
            const box = newBoxLayout({ vertical: false, spacing: 6, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            box.add_child(new St.Icon({ icon_name: iconName, style_class: 'dynamic-pill-toggle-icon', icon_size: 14 }));
            const lbl = new St.Label({ text: labelText, style_class: 'dynamic-pill-toggle-label' });
            box.add_child(lbl);
            btn.set_child(box);
            return btn;
        };
        const wifiBtn = makeToggle('network-wireless-symbolic', 'Wi-Fi', true);
        const btBtn = makeToggle('bluetooth-active-symbolic', 'BT', false);
        const micBtn = makeToggle('audio-input-microphone-symbolic', 'Mic', true);
        togglesRow.add_child(wifiBtn);
        togglesRow.add_child(btBtn);
        togglesRow.add_child(micBtn);
        outer.add_child(togglesRow);
        this._views.set('dashboard-wifi-btn', wifiBtn);
        this._views.set('dashboard-bt-btn', btBtn);
        this._views.set('dashboard-mic-btn', micBtn);

        // Wire toggles — all D-Bus/Gvc, stays in pill, no external windows
        this._initDashboardToggles(wifiBtn, btBtn, micBtn);

        // Hint row
        const hintRow = new St.Label({ text: 'Click pill again to close • Everything stays in the pill', style_class: 'dynamic-pill-dashboard-hint', x_align: Clutter.ActorAlign.CENTER });
        outer.add_child(hintRow);

        this._contentBox.add_child(outer);

        // Wire sliders
        this._volumeSlider = volSlider;
        this._brightnessSlider = briSlider;
        this._views.set('dashboard-vol-label', volValueLabel);
        this._views.set('dashboard-bri-label', briValueLabel);

        // Init current values
        this._ensureMixer();
        this._ensureBrightnessProxy();

        // Set initial values from mixer/proxy
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            try {
                const sink = this._mixer ? this._mixer.get_default_sink() : null;
                if (sink) {
                    const vol = sink.get_volume();
                    const max = this._mixer.get_vol_max_norm();
                    const lvl = max ? vol / max : 0.5;
                    volSlider._ignoreNotify = true;
                    volSlider.value = sink.get_is_muted() ? 0 : lvl;
                    volSlider._ignoreNotify = false;
                    volValueLabel.text = sink.get_is_muted() ? 'Muted' : `${Math.round(volSlider.value * 100)}%`;
                }
            } catch (e) {}
            try {
                if (this._brightnessProxy) {
                    const b = this._brightnessProxy.get_cached_property('Brightness')?.unpack() ?? 50;
                    briSlider._ignoreNotify = true;
                    briSlider.value = b / 100;
                    briSlider._ignoreNotify = false;
                    briValueLabel.text = `${b}%`;
                }
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });

        volSlider.connect('notify::value', () => {
            if (volSlider._ignoreNotify) return;
            const v = volSlider.value;
            volValueLabel.text = v === 0 ? 'Muted' : `${Math.round(v * 100)}%`;
            try {
                const sink = this._mixer ? this._mixer.get_default_sink() : null;
                if (sink) {
                    const max = this._mixer.get_vol_max_norm();
                    sink.set_volume(Math.round(v * max));
                    sink.set_is_muted(v === 0);
                    // Push transient update so volume module doesn't overwrite dashboard
                    Gio.DBus.session.call(
                        'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
                        new GLib.Variant('(s)', ['true']), null, Gio.DBusCallFlags.NONE, -1, null, null
                    );
                }
            } catch (e) {}
        });

        briSlider.connect('notify::value', () => {
            if (briSlider._ignoreNotify) return;
            const v = briSlider.value;
            briValueLabel.text = `${Math.round(v * 100)}%`;
            try {
                if (this._brightnessProxy) {
                    this._brightnessProxy.call(
                        'Set',
                        new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness', new GLib.Variant('i', Math.round(v * 100))]),
                        Gio.DBusCallFlags.NONE, -1, null, null
                    );
                    // Fallback: try D-Bus Set via session
                    Gio.DBus.session.call(
                        'org.gnome.SettingsDaemon.Power',
                        '/org/gnome/SettingsDaemon/Power',
                        'org.freedesktop.DBus.Properties',
                        'Set',
                        new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness', new GLib.Variant('i', Math.round(v * 100))]),
                        null, Gio.DBusCallFlags.NONE, -1, null, null
                    );
                }
            } catch (e) {}
        });

        // Make dashboard sliders grab scroll
        volSlider.reactive = true;
        briSlider.reactive = true;
    }

    _updateDashboardMedia() {
        if (this._currentView !== 'dashboard') return;
        const media = this._mediaCache;
        const title = this._views.get('dashboard-media-title');
        const artist = this._views.get('dashboard-media-artist');
        if (title) title.text = media.title || 'No track';
        if (artist) artist.text = media.artist || media.album || 'Unknown';
    }

    _showVolumeView(data = {}) {
        this._clearContent();
        this._currentView = 'volume';

        const level = data.level ?? 0.5;
        const muted = data.muted ?? false;
        const pct = Math.round(level * 100);

        const outer = newBoxLayout({ vertical: true, style_class: 'dynamic-pill-content', x_expand: true, width: 280 });
        const topRow = newBoxLayout({ vertical: false, x_align: Clutter.ActorAlign.FILL });
        const iconName = muted ? 'audio-volume-muted-symbolic' : level > 0.66 ? 'audio-volume-high-symbolic' : level > 0.33 ? 'audio-volume-medium-symbolic' : 'audio-volume-low-symbolic';
        const icon = new St.Icon({ icon_name: iconName, style_class: 'dynamic-pill-icon', y_align: Clutter.ActorAlign.CENTER });
        const title = new St.Label({ text: muted ? 'Muted' : 'Volume', style_class: 'dynamic-pill-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const pctLabel = new St.Label({ text: muted ? '—' : `${pct}%`, style_class: 'dynamic-pill-subtitle', y_align: Clutter.ActorAlign.CENTER });
        topRow.add_child(icon); topRow.add_child(title); topRow.add_child(pctLabel);

        const barBg = new St.Widget({ style_class: 'dynamic-pill-progress', x_expand: true, style: 'height: 6px;' });
        const barLayout = new Clutter.BinLayout();
        barBg.layout_manager = barLayout;
        const fill = new St.Widget({ style_class: 'dynamic-pill-progress-fill', x_expand: false, y_expand: true, x_align: Clutter.ActorAlign.START });
        // Use allocation to reflect level
        fill.width = Math.round(280 * (muted ? 0 : level));
        barBg.add_child(fill);

        outer.add_child(topRow);
        outer.add_child(barBg);
        this._contentBox.add_child(outer);
    }

    _showBrightnessView(data = {}) {
        this._clearContent();
        this._currentView = 'brightness';
        const level = data.level ?? 0.5;
        const pct = Math.round(level * 100);

        const outer = newBoxLayout({ vertical: true, style_class: 'dynamic-pill-content', x_expand: true, width: 280 });
        const topRow = newBoxLayout({ vertical: false, x_align: Clutter.ActorAlign.FILL });
        const icon = new St.Icon({ icon_name: 'display-brightness-symbolic', style_class: 'dynamic-pill-icon' });
        const title = new St.Label({ text: 'Brightness', style_class: 'dynamic-pill-title', x_expand: true });
        const pctLabel = new St.Label({ text: `${pct}%`, style_class: 'dynamic-pill-subtitle' });
        topRow.add_child(icon); topRow.add_child(title); topRow.add_child(pctLabel);

        const barBg = new St.Widget({ style_class: 'dynamic-pill-progress', x_expand: true });
        barBg.layout_manager = new Clutter.BinLayout();
        const fill = new St.Widget({ style_class: 'dynamic-pill-progress-fill', x_expand: false });
        fill.width = Math.round(280 * level);
        barBg.add_child(fill);

        outer.add_child(topRow);
        outer.add_child(barBg);
        this._contentBox.add_child(outer);
    }

    _showMediaView(data = {}) {
        this._clearContent();
        this._currentView = 'media';

        const outer = newBoxLayout({ vertical: false, spacing: 12, width: 380, style_class: 'dynamic-pill-content' });

        // Art
        const artBox = new St.Widget({ style_class: 'dynamic-pill-media-art', width: 48, height: 48, layout_manager: new Clutter.BinLayout() });
        let artIcon;
        if (data.artUrl) {
            artIcon = new St.Icon({ icon_name: 'media-optical-symbolic', icon_size: 32, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        } else {
            artIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 24, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        }
        artBox.add_child(artIcon);

        const textCol = newBoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const title = new St.Label({ text: data.title || 'No track', style_class: 'dynamic-pill-media-title' });
        const artist = new St.Label({ text: data.artist || data.album || 'Unknown', style_class: 'dynamic-pill-media-artist' });
        textCol.add_child(title);
        textCol.add_child(artist);

        const controls = newBoxLayout({ vertical: false, spacing: 6, y_align: Clutter.ActorAlign.CENTER, style_class: 'dynamic-pill-media-controls' });

        const prevBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
        prevBtn.add_child(new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 14 }));
        prevBtn.connect('clicked', () => this._mediaAction(data._playerName, 'Previous'));

        const playIconName = data.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        const playBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
        playBtn.add_child(new St.Icon({ icon_name: playIconName, icon_size: 16 }));
        playBtn.connect('clicked', () => this._mediaAction(data._playerName, 'PlayPause'));

        const nextBtn = new St.Button({ style_class: 'dynamic-pill-media-button', can_focus: true });
        nextBtn.add_child(new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 14 }));
        nextBtn.connect('clicked', () => this._mediaAction(data._playerName, 'Next'));

        controls.add_child(prevBtn);
        controls.add_child(playBtn);
        controls.add_child(nextBtn);

        outer.add_child(artBox);
        outer.add_child(textCol);
        outer.add_child(controls);
        this._contentBox.add_child(outer);
    }

    _mediaAction(player, action) {
        if (!player) return;
        try {
            Gio.DBus.session.call(
                `org.mpris.MediaPlayer2.${player}`,
                '/org/mpris/MediaPlayer2',
                'org.mpris.MediaPlayer2.Player',
                action,
                null, null, Gio.DBusCallFlags.NONE, -1, null, null
            );
        } catch (e) { log(`[DynamicPill] media action ${action} failed: ${e}`); }
    }

    _showBatteryView(data = {}) {
        this._clearContent();
        this._currentView = 'battery';
        const level = data.level ?? 50;
        const state = data.state ?? 'discharging';
        const charging = state === 'charging' || state === 'pending-charge';
        const warning = data.warning || level <= 15;

        const box = newBoxLayout({ vertical: false, spacing: 8, style_class: 'dynamic-pill-content' });
        const iconName = charging ? 'battery-good-charging-symbolic' : level > 80 ? 'battery-full-symbolic' : level > 50 ? 'battery-good-symbolic' : level > 20 ? 'battery-low-symbolic' : 'battery-caution-symbolic';
        const icon = new St.Icon({ icon_name: iconName, style_class: 'dynamic-pill-icon' + (charging ? ' dynamic-pill-battery-charging' : '') });
        const label = new St.Label({ text: charging ? `Charging ${level}%` : warning ? `Battery low ${level}%` : `Battery ${level}%`, style_class: 'dynamic-pill-title' });
        box.add_child(icon); box.add_child(label);
        this._contentBox.add_child(box);
    }

    _showWorkspaceView(data = {}) {
        this._clearContent();
        this._currentView = 'workspace';
        const idx = (data.index ?? 0) + 1;
        const box = newBoxLayout({ vertical: false, spacing: 6, style_class: 'dynamic-pill-content' });
        const icon = new St.Icon({ icon_name: 'view-grid-symbolic', style_class: 'dynamic-pill-icon' });
        const label = new St.Label({ text: `Workspace ${idx}`, style_class: 'dynamic-pill-workspace' });
        box.add_child(icon); box.add_child(label);
        this._contentBox.add_child(box);
    }

    _showNotificationView(data = {}) {
        this._clearContent();
        this._currentView = 'notification';
        const outer = newBoxLayout({ vertical: false, spacing: 10, width: 360, style_class: 'dynamic-pill-content' });
        const dot = new St.Widget({ style_class: 'dynamic-pill-notification-dot', y_align: Clutter.ActorAlign.CENTER });
        dot.set_size(8, 8);
        const textCol = newBoxLayout({ vertical: true, x_expand: true });
        const app = new St.Label({ text: data.app || 'Notification', style_class: 'dynamic-pill-title' });
        const summary = new St.Label({ text: data.summary || data.body || '', style_class: 'dynamic-pill-subtitle' });
        textCol.add_child(app); textCol.add_child(summary);
        const icon = data.icon ? new St.Icon({ icon_name: data.icon, style_class: 'dynamic-pill-icon', y_align: Clutter.ActorAlign.CENTER }) : null;
        outer.add_child(dot);
        if (icon) outer.add_child(icon);
        outer.add_child(textCol);
        this._contentBox.add_child(outer);
    }

    _showGenericView(data = {}) {
        this._clearContent();
        this._currentView = 'generic';
        const box = newBoxLayout({ vertical: false, spacing: 8, style_class: 'dynamic-pill-content' });
        // DynamicGlacier-style status dot (camera green / mic orange / screen blue)
        if (data.dot) {
            const dot = new St.Widget({
                style_class: `dynamic-pill-privacy-dot ${data.dot}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(dot);
        }
        const icon = new St.Icon({ icon_name: data.icon || 'dialog-information-symbolic', style_class: 'dynamic-pill-icon' });
        const col = newBoxLayout({ vertical: true });
        const title = new St.Label({ text: data.title || '', style_class: 'dynamic-pill-title' });
        col.add_child(title);
        if (data.subtitle) {
            const sub = new St.Label({ text: data.subtitle, style_class: 'dynamic-pill-subtitle' });
            col.add_child(sub);
        }
        box.add_child(icon); box.add_child(col);
        this._contentBox.add_child(box);
    }

    _animateToView(view, data, event) {
        // Simple cross-fade + width animation
        const duration = this._animationDuration;

        // Fade out slightly, swap, fade in
        this._pill.remove_all_transitions();
        this._contentBox.remove_all_transitions();

        // Scale animation on pill
        this._contentBox.ease({
            opacity: 0,
            duration: Math.min(140, duration * 0.5),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                // Swap view
                switch (view) {
                    case 'idle': this._showIdleView(); break;
                    case 'dashboard': this._showDashboardView(); break;
                    case 'volume': this._showVolumeView(data); break;
                    case 'brightness': this._showBrightnessView(data); break;
                    case 'media': this._showMediaView(data); break;
                    case 'battery': this._showBatteryView(data); break;
                    case 'workspace': this._showWorkspaceView(data); break;
                    case 'notification': this._showNotificationView(data); break;
                    case 'generic': this._showGenericView(data); break;
                    default: this._showIdleView(); break;
                }
                this._updateIdleClock();

                // Crisp opacity-only transition — avoids subpixel scale blur that caused distortion
                this._pill.set_scale(1.0, 1.0);
                this._contentBox.opacity = 0;
                this._contentBox.ease({
                    opacity: 255,
                    duration: duration * 0.85,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                // Re-center after content change
                this._syncMonitor();
                this._updatePosition();
            },
        });

        // Subtle pill background highlight during expanded
        if (view !== 'idle') {
            this._pill.add_style_class_name('expanded');
        } else {
            this._pill.remove_style_class_name('expanded');
        }
    }

    destroy() {
        if (this._idleClockId) {
            GLib.source_remove(this._idleClockId);
            this._idleClockId = null;
        }
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }
        if (this._leaveTimeoutId) {
            GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = null;
        }
        if (this._stateManager && this._stateListener) {
            this._stateManager.removeListener(this._stateListener);
        }
        if (this._mediaListener && this._stateManager) {
            try { this._stateManager.removeListener(this._mediaListener); } catch (e) {}
        }
        this._cleanupDashboardResources();
        if (this._mixer) {
            try { this._mixer.close(); } catch (e) {}
            this._mixer = null;
        }
        if (this._container) {
            Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._pill = null;
        this._contentBox = null;
    }
}
