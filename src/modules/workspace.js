import { Priority } from '../state.js';

export class WorkspaceModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._sigId = null;
    }

    enable() {
        try {
            const wm = global.workspace_manager;
            if (!wm) {
                log('[DynamicPill] Workspace: global.workspace_manager not available');
                return;
            }
            this._sigId = wm.connect('workspace-switched', (wm, from, to) => this._onSwitched(from, to));
            log('[DynamicPill] Workspace: connected to workspace-switched');
        } catch (e) { log(`[DynamicPill] Workspace enable failed: ${e}`); }
    }

    _onSwitched(from, to) {
        try {
            const wm = global.workspace_manager;
            const total = wm.n_workspaces;
            this._stateManager.push({
                id: 'workspace',
                priority: Priority.WORKSPACE,
                view: 'workspace',
                data: { index: to, total },
                duration: 1600,
            });
        } catch (e) {}
    }

    disable() {
        if (this._sigId) {
            try {
                const wm = global.workspace_manager;
                if (wm) wm.disconnect(this._sigId);
            } catch (e) {}
            this._sigId = null;
        }
    }
}
