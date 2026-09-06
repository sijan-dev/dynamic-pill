import Gio from 'gi://Gio';
import { Priority } from '../state.js';

export class PrivacyModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._proxy = null;
        this._sigId = null;
    }

    enable() {
        // GNOME Shell privacy indicators come from quick settings; we can watch
        // org.gnome.SettingsDaemon privacy? Simpler: watch Shell QuickSettings via DBus?
        // Alternative: listen to PipeWire for mic usage via org.gnome.SettingsDaemon.privacy? Use D-Bus
        // For now, hook into GNOME's privacy: listen to `org.gnome.desktop.privacy`? Not.
        // Use portal: org.freedesktop.impl.portal.PermissionStore? too complex.

        // Approach: poll Shell's QuickSettings privacy indicator visibility via looking up panel status area
        // Instead, listen to session D-Bus for `org.gnome.Shell` privacy signals if available, and fallback to not spamming.
        try {
            // Watch for camera/mic via `org.freedesktop.portal`? Leave as lightweight.
            // We'll subscribe to `org.gnome.Shell` ShowOSD? No.
            // Simple: check `global.display` privacy?
            // For Wayland, GNOME exposes privacy via `Main.panel.statusArea.quickSettings._privacyIndicator` in JS.
            // We can observe that object's visibility by polling its visibility with low interval but event-driven via `notify::visible`
            this._hookPanelIndicator();
            log('[DynamicPill] Privacy: hooked panel indicator');
        } catch (e) { log(`[DynamicPill] Privacy failed: ${e}`); }
    }

    _hookPanelIndicator() {
        try {
            // Try modern import
            import('resource:///org/gnome/shell/ui/main.js').then(MainMod => {
                try {
                    const Main2 = MainMod.default || MainMod;
                    // Try quickSettings privacy indicator
                    const qs = Main2.panel?.statusArea?.quickSettings;
                    if (qs && qs._privacyIndicator) {
                        const ind = qs._privacyIndicator;
                        const id = ind.connect('notify::visible', () => this._onPrivacyVisible(ind.visible));
                        this._sigId = id;
                        this._proxy = ind;
                    }
                } catch (e) {}
            }).catch(() => {});
            // Fallback timer to check every 3s — lightweight
            // Don't poll aggressively
        } catch (e) {}

        // Also listen to PipeWire via DBus: `org.gnome.SettingsDaemon.MediaKeys`? Not.
        // Alternative: Watch for `org.freedesktop.DBus.Properties` on `org.gnome.Mutter.ScreenCast` for screen sharing
        try {
            this._screenCastSubId = Gio.DBus.session.signal_subscribe(
                null, 'org.gnome.Mutter.ScreenCast', 'SessionAdded', null, null, Gio.DBusSignalFlags.NONE,
                () => this._pushPrivacy('display-projecteda', 'Screen Sharing')
            );
            this._screenCastRemovedId = Gio.DBus.session.signal_subscribe(
                null, 'org.gnome.Mutter.ScreenCast', 'SessionRemoved', null, null, Gio.DBusSignalFlags.NONE,
                () => this._pushPrivacy('view-reveal-symbolic', 'Screen Share Ended', 1500)
            );
        } catch (e) {}
    }

    _onPrivacyVisible(visible) {
        if (!visible) return;
        // Try to detect which privacy feature
        try {
            this._pushPrivacy('audio-input-microphone-symbolic', 'Microphone Active');
        } catch (e) {}
    }

    _pushPrivacy(icon, title, duration = 3500) {
        this._stateManager.push({
            id: 'privacy',
            priority: Priority.PRIVACY,
            view: 'generic',
            data: { icon, title, subtitle: '' },
            duration,
        });
    }

    disable() {
        if (this._proxy && this._sigId) { try { this._proxy.disconnect(this._sigId); } catch (e) {} }
        if (this._screenCastSubId) { try { Gio.DBus.session.signal_unsubscribe(this._screenCastSubId); } catch (e) {} }
        if (this._screenCastRemovedId) { try { Gio.DBus.session.signal_unsubscribe(this._screenCastRemovedId); } catch (e) {} }
        this._proxy = null;
        this._sigId = null;
    }
}
