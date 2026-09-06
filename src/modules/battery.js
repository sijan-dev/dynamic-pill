import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Priority } from '../state.js';

export class BatteryModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._proxy = null;
        this._subId = null;
        this._deviceProxy = null;
        this._deviceSigId = null;
        this._lastPct = -1;
        this._lastState = -1;
    }

    enable() {
        // UPower display device
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.UPower.Device',
                null,
                (proxy, res) => {
                    try {
                        this._deviceProxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (this._deviceProxy) {
                            this._deviceSigId = this._deviceProxy.connect('g-properties-changed', (p, props) => this._onDeviceChanged(props));
                            log('[DynamicPill] Battery: DisplayDevice proxy connected');
                            this._checkInitial();
                        }
                    } catch (e) { log(`[DynamicPill] Battery proxy finish failed: ${e}`); }
                }
            );
        } catch (e) { log(`[DynamicPill] Battery enable failed: ${e}`); }
    }

    _checkInitial() {
        try {
            const pct = this._deviceProxy.get_cached_property('Percentage')?.unpack() ?? -1;
            const state = this._deviceProxy.get_cached_property('State')?.unpack() ?? -1;
            this._lastPct = Math.round(pct);
            this._lastState = state;
        } catch (e) {}
    }

    _onDeviceChanged(props) {
        try {
            const dict = props.recursiveUnpack();
            const pct = dict['Percentage'] !== undefined ? Math.round(dict['Percentage'].unpack()) : this._lastPct;
            const state = dict['State'] !== undefined ? dict['State'].unpack() : this._lastState;
            // UPower states: 1 charging, 2 discharging, 4 fully charged, 5 pending charge
            const changed = pct !== this._lastPct || state !== this._lastState;
            if (!changed) return;
            this._lastPct = pct;
            this._lastState = state;

            // Only show significant battery events
            let shouldShow = false;
            let viewData = { level: pct, state: this._stateToString(state), warning: false };

            if (state === 1) { // charging
                // Show when charging started or big jump
                shouldShow = true;
                viewData.state = 'charging';
            } else if (pct <= 20 && state === 2) { // low
                shouldShow = true;
                viewData.warning = true;
                viewData.state = 'discharging';
            } else if (pct <= 10) {
                shouldShow = true;
                viewData.warning = true;
            } else if (state === 4) { // fully charged
                shouldShow = true;
                viewData.state = 'fully-charged';
                viewData.title = 'Battery Full';
            }

            // Also show if percentage dropped by >=5% quickly? Not needed — keep minimal

            if (shouldShow) {
                log(`[DynamicPill] Battery event: ${pct}% state ${state}`);
                this._stateManager.push({
                    id: 'battery',
                    priority: Priority.BATTERY,
                    view: 'battery',
                    data: viewData,
                    duration: 3500,
                });
            }
        } catch (e) { log(`[DynamicPill] Battery onChanged error: ${e}`); }
    }

    _stateToString(state) {
        switch (state) {
            case 1: return 'charging';
            case 2: return 'discharging';
            case 3: return 'empty';
            case 4: return 'fully-charged';
            case 5: return 'pending-charge';
            case 6: return 'pending-discharge';
            default: return 'unknown';
        }
    }

    disable() {
        if (this._deviceSigId && this._deviceProxy) { try { this._deviceProxy.disconnect(this._deviceSigId); } catch (e) {} }
        this._deviceSigId = null;
        this._deviceProxy = null;
    }
}
