import * as VolumeModule from './modules/volume.js';
import * as BrightnessModule from './modules/brightness.js';
import * as MediaModule from './modules/media.js';
import * as WorkspaceModule from './modules/workspace.js';
import * as BatteryModule from './modules/battery.js';
import * as NotificationsModule from './modules/notifications.js';
import * as NetworkModule from './modules/network.js';
import * as BluetoothModule from './modules/bluetooth.js';
import * as PrivacyModule from './modules/privacy.js';

export class EventManager {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._modules = [];
    }

    enable() {
        log('[DynamicPill] Enabling event modules');
        try {
            if (this._settings.get_boolean('enable-volume')) {
                const m = new VolumeModule.VolumeModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Volume module enabled');
            }
        } catch (e) { log(`[DynamicPill] Volume unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-brightness')) {
                const m = new BrightnessModule.BrightnessModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Brightness module enabled');
            }
        } catch (e) { log(`[DynamicPill] Brightness unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-media')) {
                const m = new MediaModule.MediaModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Media module enabled');
            }
        } catch (e) { log(`[DynamicPill] Media unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-workspace')) {
                const m = new WorkspaceModule.WorkspaceModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Workspace module enabled');
            }
        } catch (e) { log(`[DynamicPill] Workspace unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-battery')) {
                const m = new BatteryModule.BatteryModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Battery module enabled');
            }
        } catch (e) { log(`[DynamicPill] Battery unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-notifications')) {
                const m = new NotificationsModule.NotificationsModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Notifications module enabled');
            }
        } catch (e) { log(`[DynamicPill] Notifications unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-network')) {
                const m = new NetworkModule.NetworkModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Network module enabled');
            }
        } catch (e) { log(`[DynamicPill] Network unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-bluetooth')) {
                const m = new BluetoothModule.BluetoothModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Bluetooth module enabled');
            }
        } catch (e) { log(`[DynamicPill] Bluetooth unavailable: ${e}`); }

        try {
            if (this._settings.get_boolean('enable-privacy')) {
                const m = new PrivacyModule.PrivacyModule(this._stateManager, this._settings);
                m.enable(); this._modules.push(m);
                log('[DynamicPill] Privacy module enabled');
            }
        } catch (e) { log(`[DynamicPill] Privacy unavailable: ${e}`); }
    }

    disable() {
        for (const m of this._modules) {
            try { m.disable(); } catch (e) { log(`[DynamicPill] Error disabling module: ${e}`); }
        }
        this._modules = [];
        log('[DynamicPill] All modules disabled');
    }
}
