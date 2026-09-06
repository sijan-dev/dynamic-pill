import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Priority } from '../state.js';

export class NotificationsModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._signalIds = [];
        this._timeout = settings ? settings.get_int('notification-timeout') : 3500;
    }

    enable() {
        this._timeout = this._settings ? this._settings.get_int('notification-timeout') : 3500;
        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed::notification-timeout', () => {
                this._timeout = this._settings.get_int('notification-timeout');
            });
        }

        // Hook into Main.messageTray
        try {
            if (Main.messageTray) {
                const id = Main.messageTray.connect('source-added', (tray, source) => this._onSourceAdded(source));
                this._signalIds.push([Main.messageTray, id]);
                log('[DynamicPill] Notifications: hooked messageTray source-added');

                // Also hook existing sources
                try {
                    const sources = Main.messageTray.getSources ? Main.messageTray.getSources() : [];
                    for (const s of sources) this._onSourceAdded(s);
                } catch (e) {}
            }
        } catch (e) { log(`[DynamicPill] Notifications messageTray hook failed: ${e}`); }

        // Fallback: also listen via NotificationDaemon if available
        try {
            if (Main.notificationDaemon) {
                // notificationDaemon emits 'notification-added' in some versions
                // We try generic
            }
        } catch (e) {}

        // Also listen via DBus org.freedesktop.Notifications Notify calls
        try {
            this._dbusSubId = Gio.DBus.session.signal_subscribe(
                null,
                'org.freedesktop.Notifications',
                'NotificationClosed',
                null, null, Gio.DBusSignalFlags.NONE,
                () => {}
            );
            // We use messageTray as primary — no need to parse Notify directly
        } catch (e) {}
    }

    _onSourceAdded(source) {
        try {
            const id = source.connect('notification-added', (src, notification) => this._onNotification(notification, src));
            this._signalIds.push([source, id]);
            // label
            // log(`[DynamicPill] source added: ${source.title || source.appName}`)
        } catch (e) {}
    }

    _onNotification(notification, source) {
        try {
            // Avoid duplicates and resident notifications
            if (!notification) return;
            if (notification.urgency === 0 && notification.title && notification.title.includes('Volume')) return;

            const appName = source ? (source.title || source.appName || 'Notification') : (notification.title || 'Notification');
            const title = notification.title || appName;
            const banner = notification.bannerBodyText || notification.body || '';

            // Filter low urgency transient spam? Show only normal/critical
            // urgency: 0 low, 1 normal, 2 critical (GNOME)
            // We'll show all but with filtering for noisy apps if needed

            // Debounce rapid bursts
            const summary = title.length > 80 ? title.slice(0, 77) + '…' : title;
            const body = banner.length > 120 ? banner.slice(0, 117) + '…' : banner;

            // Don't show if pill already showing same notification within 2s
            log(`[DynamicPill] Notification: ${appName} — ${summary}`);

            this._stateManager.push({
                id: `notification-${Date.now()}`,
                priority: Priority.NOTIFICATION,
                view: 'notification',
                data: {
                    app: appName,
                    summary,
                    body,
                    icon: notification.gicon ? null : null,
                    urgency: notification.urgency ?? 1,
                },
                duration: this._timeout,
            });
        } catch (e) { log(`[DynamicPill] notification handler error: ${e}`); }
    }

    disable() {
        for (const [obj, id] of this._signalIds) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._signalIds = [];
        if (this._settingsChangedId && this._settings) {
            try { this._settings.disconnect(this._settingsChangedId); } catch (e) {}
        }
        if (this._dbusSubId) {
            try { Gio.DBus.session.signal_unsubscribe(this._dbusSubId); } catch (e) {}
            this._dbusSubId = null;
        }
    }
}
