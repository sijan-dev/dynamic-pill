import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Priority } from '../state.js';

export class BrightnessModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._subId = null;
        this._proxy = null;
        this._osdSubId = null;
        this._debounceId = null;
        this._lastLevel = -1;
    }

    enable() {
        // Primary: OSD ShowOSD includes brightness
        try {
            this._osdSubId = Gio.DBus.session.signal_subscribe(
                null, 'org.gnome.Shell', 'ShowOSD', '/org/gnome/Shell',
                null, Gio.DBusSignalFlags.NONE,
                (c,s,p,i,sig,params) => this._onShowOSD(params)
            );
            log('[DynamicPill] Brightness: listening to ShowOSD');
        } catch (e) { log(`[DynamicPill] Brightness OSD subscribe failed: ${e}`); }

        // Secondary: SettingsDaemon Power Screen proxy
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
                        this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (this._proxy) {
                            this._subId = this._proxy.connect('g-properties-changed', (p, props) => this._onPropertiesChanged(props));
                            log('[DynamicPill] Brightness: SettingsDaemon proxy connected');
                        }
                    } catch (e) { }
                }
            );
        } catch (e) { }

        // Tertiary: DDC? ignore
    }

    _onShowOSD(params) {
        try {
            const unpacked = params.recursiveUnpack();
            let dict, level, icon;
            if (Array.isArray(unpacked)) dict = unpacked[0];
            else dict = unpacked;
            if (dict && typeof dict === 'object') {
                level = dict['level'] !== undefined ? dict['level'].unpack() : undefined;
                icon = dict['icon'] !== undefined ? dict['icon'].unpack() : undefined;
            }
            if (icon && (icon.includes('brightness') || icon.includes('display-brightness'))) {
                const lvl = level ?? this._lastLevel;
                if (lvl !== undefined && Math.abs(lvl - this._lastLevel) < 0.01) return;
                this._lastLevel = lvl ?? 0.5;
                this._debounce(() => {
                    this._stateManager.push({
                        id: 'brightness',
                        priority: Priority.BRIGHTNESS,
                        view: 'brightness',
                        data: { level: this._lastLevel },
                        duration: 2000,
                    });
                });
            }
        } catch (e) {}
    }

    _onPropertiesChanged(props) {
        try {
            const dict = props.recursiveUnpack();
            if ('Brightness' in dict) {
                const lvl = dict['Brightness'].unpack() / 100.0;
                if (Math.abs(lvl - this._lastLevel) < 0.01) return;
                this._lastLevel = lvl;
                this._debounce(() => {
                    this._stateManager.push({
                        id: 'brightness',
                        priority: Priority.BRIGHTNESS,
                        view: 'brightness',
                        data: { level: lvl },
                        duration: 2000,
                    });
                });
            }
        } catch (e) {}
    }

    _debounce(fn) {
        if (this._debounceId) GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._debounceId = null;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._debounceId) { GLib.source_remove(this._debounceId); this._debounceId = null; }
        if (this._subId && this._proxy) { try { this._proxy.disconnect(this._subId); } catch (e) {} }
        if (this._osdSubId) { try { Gio.DBus.session.signal_unsubscribe(this._osdSubId); } catch (e) {} }
        this._proxy = null;
        this._osdSubId = null;
        this._subId = null;
    }
}
