import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

        this._createActor();
        this._bindSettings();
        this._setupStateListener();
        this._setupClock();
        this._updatePosition();
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
        this._pill = new St.Widget({
            style_class: 'dynamic-pill',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 255,
        });

        // Content box inside pill
        this._contentBox = new St.BoxLayout({
            style_class: 'dynamic-pill-content',
            vertical: false,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._pill.add_child(this._contentBox);
        this._container.add_child(this._pill);

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
            // console.log(`[DynamicPill] state -> ${event.id} / ${state}`)
            this._onStateChanged(event, state);
        };
        this._stateManager.addListener(this._stateListener);
        // Start idle
        this._stateManager.showIdle();
    }

    _onStateChanged(event, state) {
        if (!event) return;

        if (event.id === 'idle') {
            this._animateToView('idle', event.data);
        } else {
            this._animateToView(event.view, event.data, event);
        }
    }

    _handleClick() {
        const cur = this._stateManager.current;
        if (!cur || cur.id === 'idle') {
            // Idle click: open calendar / quick settings
            try {
                if (Main.panel.statusArea.dateMenu) {
                    Main.panel.statusArea.dateMenu.menu.toggle();
                } else if (Main.panel.statusArea.quickSettings) {
                    Main.panel.statusArea.quickSettings.menu.toggle();
                }
            } catch (e) { log(`[DynamicPill] idle click error: ${e}`); }
            return;
        }

        // View-specific actions
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
            case 'volume':
                try {
                    // Open sound settings
                    Gio.AppInfo.launch_default_for_uri('gnome-control-center sound', null);
                } catch (e) {
                    try { Main.panel.statusArea.quickSettings.menu.open(); } catch (_) {}
                }
                break;
            case 'brightness':
                try { Gio.AppInfo.launch_default_for_uri('gnome-control-center display', null); } catch (e) {}
                break;
            case 'notification':
                // Dismiss and optionally open app
                this._stateManager.dismiss(cur.id);
                break;
            default:
                break;
        }
    }

    _clearContent() {
        this._contentBox.remove_all_children();
        this._views.clear();
    }

    _showIdleView() {
        this._clearContent();
        this._currentView = 'idle';

        const box = new St.BoxLayout({
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
        });

        box.add_child(label);
        this._contentBox.add_child(box);
        this._views.set('idle-label', label);
        this._views.set('idle-box', box);
    }

    _showVolumeView(data = {}) {
        this._clearContent();
        this._currentView = 'volume';

        const level = data.level ?? 0.5;
        const muted = data.muted ?? false;
        const pct = Math.round(level * 100);

        const outer = new St.BoxLayout({ vertical: true, style_class: 'dynamic-pill-content', x_expand: true, width: 280 });
        const topRow = new St.BoxLayout({ vertical: false, x_align: Clutter.ActorAlign.FILL });
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

        const outer = new St.BoxLayout({ vertical: true, style_class: 'dynamic-pill-content', x_expand: true, width: 280 });
        const topRow = new St.BoxLayout({ vertical: false, x_align: Clutter.ActorAlign.FILL });
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

        const outer = new St.BoxLayout({ vertical: false, spacing: 12, width: 380, style_class: 'dynamic-pill-content' });

        // Art
        const artBox = new St.Widget({ style_class: 'dynamic-pill-media-art', width: 48, height: 48, layout_manager: new Clutter.BinLayout() });
        let artIcon;
        if (data.artUrl) {
            // Try to load via St.Icon fallback — we use icon; real album art would need texture cache
            artIcon = new St.Icon({ icon_name: 'media-optical-symbolic', icon_size: 32, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        } else {
            artIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 24, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        }
        artBox.add_child(artIcon);

        const textCol = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const title = new St.Label({ text: data.title || 'No track', style_class: 'dynamic-pill-media-title' });
        const artist = new St.Label({ text: data.artist || data.album || 'Unknown', style_class: 'dynamic-pill-media-artist' });
        textCol.add_child(title);
        textCol.add_child(artist);

        const controls = new St.BoxLayout({ vertical: false, spacing: 6, y_align: Clutter.ActorAlign.CENTER, style_class: 'dynamic-pill-media-controls' });

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

        const box = new St.BoxLayout({ vertical: false, spacing: 8, style_class: 'dynamic-pill-content' });
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
        const box = new St.BoxLayout({ vertical: false, spacing: 6, style_class: 'dynamic-pill-content' });
        const icon = new St.Icon({ icon_name: 'view-grid-symbolic', style_class: 'dynamic-pill-icon' });
        const label = new St.Label({ text: `Workspace ${idx}`, style_class: 'dynamic-pill-workspace' });
        box.add_child(icon); box.add_child(label);
        this._contentBox.add_child(box);
    }

    _showNotificationView(data = {}) {
        this._clearContent();
        this._currentView = 'notification';
        const outer = new St.BoxLayout({ vertical: false, spacing: 10, width: 360, style_class: 'dynamic-pill-content' });
        const dot = new St.Widget({ style_class: 'dynamic-pill-notification-dot', y_align: Clutter.ActorAlign.CENTER });
        dot.set_size(8, 8);
        const textCol = new St.BoxLayout({ vertical: true, x_expand: true });
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
        const box = new St.BoxLayout({ vertical: false, spacing: 8, style_class: 'dynamic-pill-content' });
        const icon = new St.Icon({ icon_name: data.icon || 'dialog-information-symbolic', style_class: 'dynamic-pill-icon' });
        const col = new St.BoxLayout({ vertical: true });
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

                // Animate pill width naturally via layout; do opacity/scale
                this._pill.set_scale(0.96, 0.96);
                this._contentBox.opacity = 0;
                this._pill.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                this._contentBox.ease({
                    opacity: 255,
                    duration: duration * 0.8,
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
        if (this._container) {
            Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._pill = null;
        this._contentBox = null;
    }
}
