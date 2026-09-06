import GLib from 'gi://GLib';

export const Priority = {
    CRITICAL: 10,
    DASHBOARD: 15,
    NOTIFICATION: 20,
    PRIVACY: 25,
    MEDIA: 30,
    VOLUME: 40,
    BRIGHTNESS: 50,
    WORKSPACE: 60,
    BATTERY: 70,
    NETWORK: 80,
    BLUETOOTH: 80,
    IDLE: 100,
};

export const State = {
    IDLE: 'idle',
    EXPANDED: 'expanded',
};

export class StateManager {
    constructor(settings) {
        this._settings = settings;
        this._current = null;
        this._queue = [];
        this._idleTimeoutId = null;
        this._state = State.IDLE;
        this._listeners = new Set();
        this._collapseTimeout = settings ? settings.get_int('collapse-timeout') : 3000;
        this._autoCollapse = settings ? settings.get_boolean('auto-collapse') : true;

        if (settings) {
            this._settingsChangedId = settings.connect('changed::collapse-timeout', () => {
                this._collapseTimeout = settings.get_int('collapse-timeout');
            });
            this._autoCollapseChangedId = settings.connect('changed::auto-collapse', () => {
                this._autoCollapse = settings.get_boolean('auto-collapse');
            });
        }
    }

    destroy() {
        if (this._idleTimeoutId) {
            GLib.source_remove(this._idleTimeoutId);
            this._idleTimeoutId = null;
        }
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
        }
        if (this._settings && this._autoCollapseChangedId) {
            this._settings.disconnect(this._autoCollapseChangedId);
        }
        this._listeners.clear();
        this._queue = [];
        this._current = null;
    }

    addListener(fn) {
        this._listeners.add(fn);
    }

    removeListener(fn) {
        this._listeners.delete(fn);
    }

    _emit(event, state) {
        for (const fn of this._listeners) {
            try {
                fn(event, state);
            } catch (e) {
                log(`[DynamicPill] State listener error: ${e}`);
            }
        }
    }

    get current() {
        return this._current;
    }

    get state() {
        return this._state;
    }

    push(event) {
        // event: { id, priority, view, duration, onClick, source }
        if (!event || !event.id) return;
        event.timestamp = Date.now();
        event.priority = event.priority ?? Priority.BATTERY;
        event.duration = event.duration ?? this._collapseTimeout;

        // Replace existing event with same id
        const existingIdx = this._queue.findIndex(e => e.id === event.id);
        if (existingIdx !== -1) {
            this._queue.splice(existingIdx, 1);
        }
        // If current is same id, replace current
        if (this._current && this._current.id === event.id) {
            this._setCurrent(event);
            return;
        }

        // Priority check: if no current or event has higher priority (lower number), preempt
        if (!this._current || event.priority < this._current.priority) {
            // Push current back to queue if it exists and not idle
            if (this._current && this._current.id !== 'idle') {
                // Insert sorted by priority
                this._insertSorted(this._current);
            }
            this._setCurrent(event);
        } else {
            // Queue it sorted
            this._insertSorted(event);
        }
    }

    _insertSorted(event) {
        let inserted = false;
        for (let i = 0; i < this._queue.length; i++) {
            if (event.priority < this._queue[i].priority ||
                (event.priority === this._queue[i].priority && event.timestamp < this._queue[i].timestamp)) {
                this._queue.splice(i, 0, event);
                inserted = true;
                break;
            }
        }
        if (!inserted) this._queue.push(event);
    }

    _setCurrent(event) {
        if (this._idleTimeoutId) {
            GLib.source_remove(this._idleTimeoutId);
            this._idleTimeoutId = null;
        }

        this._current = event;
        this._state = event.id === 'idle' ? State.IDLE : State.EXPANDED;
        this._emit(event, this._state);

        if (event.id !== 'idle' && this._autoCollapse) {
            const duration = event.duration || this._collapseTimeout;
            this._idleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._idleTimeoutId = null;
                this._nextOrIdle();
                return GLib.SOURCE_REMOVE;
            });
        } else if (event.id === 'idle') {
            this._state = State.IDLE;
        }
    }

    _nextOrIdle() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            this._setCurrent(next);
        } else {
            this._setCurrent({ id: 'idle', priority: Priority.IDLE, view: 'idle' });
        }
    }

    showIdle() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            this._setCurrent(next);
        } else {
            this._setCurrent({ id: 'idle', priority: Priority.IDLE, view: 'idle' });
        }
    }

    forceIdle() {
        if (this._idleTimeoutId) {
            GLib.source_remove(this._idleTimeoutId);
            this._idleTimeoutId = null;
        }
        this._queue = [];
        this._setCurrent({ id: 'idle', priority: Priority.IDLE, view: 'idle' });
    }

    dismiss(id) {
        if (this._current && this._current.id === id) {
            if (this._idleTimeoutId) {
                GLib.source_remove(this._idleTimeoutId);
                this._idleTimeoutId = null;
            }
            this._nextOrIdle();
        } else {
            this._queue = this._queue.filter(e => e.id !== id);
        }
    }

    // Debug helper
    test(eventName) {
        const now = Date.now();
        switch (eventName) {
            case 'volume':
                this.push({ id: 'volume', priority: Priority.VOLUME, view: 'volume', data: { level: 0.72, muted: false }, duration: 2500 });
                break;
            case 'brightness':
                this.push({ id: 'brightness', priority: Priority.BRIGHTNESS, view: 'brightness', data: { level: 0.58 }, duration: 2500 });
                break;
            case 'media':
                this.push({ id: 'media', priority: Priority.MEDIA, view: 'media', data: { title: 'Blinding Lights', artist: 'The Weeknd', status: 'Playing', canPlay: true }, duration: 6000 });
                break;
            case 'battery':
                this.push({ id: 'battery', priority: Priority.BATTERY, view: 'battery', data: { level: 15, state: 'discharging', warning: true }, duration: 3000 });
                break;
            case 'workspace':
                this.push({ id: 'workspace', priority: Priority.WORKSPACE, view: 'workspace', data: { index: 3, total: 4 }, duration: 1800 });
                break;
            case 'notification':
                this.push({ id: `notification-${now}`, priority: Priority.NOTIFICATION, view: 'notification', data: { app: 'Telegram', summary: 'New message from Alex', body: 'Hey, are we still on for tonight?' }, duration: 3500 });
                break;
            case 'network':
                this.push({ id: 'network', priority: Priority.NETWORK, view: 'generic', data: { icon: 'network-wireless-symbolic', title: 'Wi-Fi Connected', subtitle: 'FedoraNet 5G' }, duration: 2500 });
                break;
            case 'bluetooth':
                this.push({ id: 'bluetooth', priority: Priority.BLUETOOTH, view: 'generic', data: { icon: 'bluetooth-active-symbolic', title: 'Bluetooth Connected', subtitle: 'WH-1000XM5' }, duration: 2500 });
                break;
            case 'privacy':
                this.push({ id: 'privacy', priority: Priority.PRIVACY, view: 'generic', data: { icon: 'audio-input-microphone-symbolic', title: 'Microphone Active', subtitle: '' }, duration: 4000 });
                break;
            case 'dashboard':
                this.push({ id: 'dashboard', priority: Priority.DASHBOARD, view: 'dashboard', data: {}, duration: 8000 });
                break;
            case 'idle':
                this.forceIdle();
                break;
        }
    }
}
