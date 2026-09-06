import Gio from 'gi://Gio';
import { Priority } from '../state.js';

export class BluetoothModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._proxy = null;
        this._subId = null;
    }

    enable() {
        // Listen to BlueZ Device Connected changes via ObjectManager
        try {
            this._subId = Gio.DBus.system.signal_subscribe(
                'org.bluez',
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                null, null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => this._onPropsChanged(path, params)
            );
            log('[DynamicPill] Bluetooth: listening BlueZ');
        } catch (e) { log(`[DynamicPill] Bluetooth failed: ${e}`); }
    }

    _onPropsChanged(path, params) {
        try {
            const [iface, changed] = params.recursiveUnpack();
            if (iface !== 'org.bluez.Device1') return;
            if ('Connected' in changed) {
                const connected = changed['Connected'].unpack();
                const name = path.split('/').pop();
                this._stateManager.push({
                    id: 'bluetooth',
                    priority: Priority.BLUETOOTH,
                    view: 'generic',
                    data: {
                        icon: connected ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
                        title: connected ? 'Bluetooth Connected' : 'Bluetooth Disconnected',
                        subtitle: '',
                    },
                    duration: 2500,
                });
            }
        } catch (e) {}
    }

    disable() {
        if (this._subId) {
            try { Gio.DBus.system.signal_unsubscribe(this._subId); } catch (e) {}
            this._subId = null;
        }
    }
}
