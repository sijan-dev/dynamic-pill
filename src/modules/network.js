import Gio from 'gi://Gio';
import { Priority } from '../state.js';

export class NetworkModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._proxy = null;
        this._sigId = null;
    }

    enable() {
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.NetworkManager',
                '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager',
                null,
                (proxy, res) => {
                    try {
                        this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (this._proxy) {
                            this._sigId = this._proxy.connect('g-properties-changed', (p, props) => this._onPropsChanged(props));
                            this._proxy.connect('g-signal', (p, sender, sig, params) => {
                                if (sig === 'StateChanged') this._onStateChanged(params);
                            });
                            log('[DynamicPill] Network: proxy connected');
                        }
                    } catch (e) { log(`[DynamicPill] Network proxy fail: ${e}`); }
                }
            );
        } catch (e) { log(`[DynamicPill] Network enable failed: ${e}`); }
    }

    _onPropsChanged(props) {
        try {
            const dict = props.recursiveUnpack();
            if ('Connectivity' in dict || 'State' in dict || 'PrimaryConnection' in dict) {
                // Simplified: just check state
                // State 70 = connected
            }
        } catch (e) {}
    }

    _onStateChanged(params) {
        try {
            const [state] = params.recursiveUnpack();
            // NM states: 70 connected, 20 disconnected etc.
            // We keep it very quiet — only show on transitions
            if (state === 70) {
                this._stateManager.push({
                    id: 'network',
                    priority: Priority.NETWORK,
                    view: 'generic',
                    data: { icon: 'network-wireless-symbolic', title: 'Connected', subtitle: '' },
                    duration: 2500,
                });
            } else if (state === 20 || state === 30) {
                this._stateManager.push({
                    id: 'network',
                    priority: Priority.NETWORK,
                    view: 'generic',
                    data: { icon: 'network-wireless-offline-symbolic', title: 'Offline', subtitle: '' },
                    duration: 2500,
                });
            }
        } catch (e) {}
    }

    disable() {
        if (this._proxy && this._sigId) {
            try { this._proxy.disconnect(this._sigId); } catch (e) {}
        }
        this._proxy = null;
        this._sigId = null;
    }
}
