import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { StateManager } from './src/state.js';
import { DynamicPill } from './src/pill.js';
import { EventManager } from './src/eventManager.js';

export default class DynamicPillExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._stateManager = null;
        this._pill = null;
        this._eventManager = null;
        this._settings = null;
        this._idleEnabledId = null;
    }

    enable() {
        console.log(`[DynamicPill] Enabling ${this.uuid}`);
        this._settings = this.getSettings();

        // State manager — central
        this._stateManager = new StateManager(this._settings);

        // If idle disabled, we still create pill but start collapsed
        const idleEnabled = this._settings.get_boolean('idle-enabled');

        // Pill actor
        try {
            this._pill = new DynamicPill(this._stateManager, this._settings, this.path);
            log('[DynamicPill] Pill actor created');
            if (!idleEnabled) {
                // Hide idle after creation
                this._pill._container.hide();
            }
        } catch (e) {
            logError(e, '[DynamicPill] Failed to create pill');
            return;
        }

        // Event modules
        this._eventManager = new EventManager(this._stateManager, this._settings);
        try {
            this._eventManager.enable();
        } catch (e) {
            logError(e, '[DynamicPill] EventManager failed');
        }

        // Watch idle-enabled toggling
        this._idleEnabledId = this._settings.connect('changed::idle-enabled', () => {
            const enabled = this._settings.get_boolean('idle-enabled');
            if (enabled) {
                if (this._pill && this._pill._container) this._pill._container.show();
                this._stateManager.showIdle();
            } else {
                if (this._stateManager.current?.id === 'idle') {
                    this._pill._container.hide();
                }
            }
        });

        // Debug hook: allow looking glass `Main.extensionManager.lookup(...).stateObj.test('volume')`
        // Expose for Looking Glass
        try {
            global.dynamicPillState = this._stateManager;
            log('[DynamicPill] Exposed global.dynamicPillState for debugging (lg)');
        } catch (e) {}

        log('[DynamicPill] Enabled successfully');
    }

    disable() {
        console.log('[DynamicPill] Disabling');

        if (global.dynamicPillState === this._stateManager) {
            try { delete global.dynamicPillState; } catch (e) { global.dynamicPillState = null; }
        }

        if (this._idleEnabledId && this._settings) {
            try { this._settings.disconnect(this._idleEnabledId); } catch (e) {}
            this._idleEnabledId = null;
        }

        if (this._eventManager) {
            try { this._eventManager.disable(); } catch (e) { logError(e); }
            this._eventManager = null;
        }

        if (this._pill) {
            try { this._pill.destroy(); } catch (e) { logError(e); }
            this._pill = null;
        }

        if (this._stateManager) {
            try { this._stateManager.destroy(); } catch (e) {}
            this._stateManager = null;
        }

        this._settings = null;
        log('[DynamicPill] Disabled');
    }
}
