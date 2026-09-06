import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Priority } from '../state.js';

export class MediaModule {
    constructor(stateManager, settings) {
        this._stateManager = stateManager;
        this._settings = settings;
        this._players = new Map(); // name -> proxy/info
        this._nameWatchIds = [];
        this._ownerChangedId = null;
        this._lastTrackKey = '';
    }

    enable() {
        // Watch for MPRIS players via NameOwnerChanged
        try {
            this._ownerChangedId = Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus',
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                '/org/freedesktop/DBus',
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => this._onNameOwnerChanged(params)
            );
        } catch (e) { log(`[DynamicPill] Media NameOwnerChanged subscribe failed: ${e}`); }

        // Initial scan
        this._scanPlayers();
    }

    _scanPlayers() {
        try {
            Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    try {
                        const [names] = conn.call_finish(res).recursiveUnpack();
                        for (const name of names) {
                            if (name.startsWith('org.mpris.MediaPlayer2.')) {
                                const player = name.substring('org.mpris.MediaPlayer2.'.length);
                                this._addPlayer(player);
                            }
                        }
                    } catch (e) { }
                }
            );
        } catch (e) { }
    }

    _onNameOwnerChanged(params) {
        try {
            const [name, oldOwner, newOwner] = params.recursiveUnpack();
            if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
            const player = name.substring('org.mpris.MediaPlayer2.'.length);
            if (newOwner && newOwner !== '') {
                this._addPlayer(player);
            } else {
                this._removePlayer(player);
            }
        } catch (e) {}
    }

    _addPlayer(player) {
        if (this._players.has(player)) return;
        log(`[DynamicPill] Media: player added ${player}`);
        const entry = { player, proxy: null, sigId: null };
        this._players.set(player, entry);

        // Create proxy for PropertiesChanged
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                `org.mpris.MediaPlayer2.${player}`,
                '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties',
                null,
                (p, res) => {
                    try {
                        const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        if (proxy) {
                            entry.proxy = proxy;
                            entry.sigId = proxy.connect('g-signal', (pr, sender, sig, params) => {
                                if (sig === 'PropertiesChanged') this._onPropertiesChanged(player, params);
                            });
                            // Initial fetch
                            this._fetchMetadata(player);
                        }
                    } catch (e) {}
                }
            );
        } catch (e) {}
    }

    _removePlayer(player) {
        const entry = this._players.get(player);
        if (!entry) return;
        if (entry.proxy && entry.sigId) {
            try { entry.proxy.disconnect(entry.sigId); } catch (e) {}
        }
        this._players.delete(player);
        log(`[DynamicPill] Media: player removed ${player}`);
    }

    _onPropertiesChanged(player, params) {
        try {
            const [iface, changed, invalidated] = params.recursiveUnpack();
            if (iface !== 'org.mpris.MediaPlayer2.Player') return;
            this._fetchMetadata(player, changed);
        } catch (e) {}
    }

    _fetchMetadata(player, preChanged) {
        const busName = `org.mpris.MediaPlayer2.${player}`;
        // If we have changed dict, use it to avoid extra call if it contains Metadata
        if (preChanged && 'Metadata' in preChanged) {
            this._handleMetadata(player, preChanged['Metadata'].recursiveUnpack(), preChanged['PlaybackStatus'] ? preChanged['PlaybackStatus'].unpack() : null);
            return;
        }

        Gio.DBus.session.call(
            busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'GetAll',
            new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    const [props] = conn.call_finish(res).recursiveUnpack();
                    const metaRaw = props['Metadata'];
                    const statusRaw = props['PlaybackStatus'];
                    const meta = metaRaw ? metaRaw.recursiveUnpack() : {};
                    const status = statusRaw ? statusRaw.unpack() : 'Stopped';
                    this._handleMetadata(player, meta, status);
                } catch (e) {}
            }
        );
    }

    _handleMetadata(player, meta, status) {
        // meta keys: xesam:title, xesam:artist, xesam:album, mpris:artUrl
        try {
            const title = this._getMetaString(meta, 'xesam:title') || 'Unknown';
            const artistArr = this._getMetaArray(meta, 'xesam:artist');
            const artist = artistArr.length ? artistArr[0] : (this._getMetaString(meta, 'xesam:artist') || '');
            const album = this._getMetaString(meta, 'xesam:album') || '';
            const artUrl = this._getMetaString(meta, 'mpris:artUrl') || '';

            const trackKey = `${player}:${title}:${artist}`;
            if (trackKey === this._lastTrackKey && status === 'Paused') {
                // Update play/pause without re-showing pill aggressively?
            }
            this._lastTrackKey = trackKey;

            // Only show for Playing / Paused with meaningful title
            if (!title || title === 'Unknown') return;
            // Push to pill — media stays longer
            this._stateManager.push({
                id: 'media',
                priority: Priority.MEDIA,
                view: 'media',
                data: {
                    title,
                    artist,
                    album,
                    artUrl,
                    status,
                    _playerName: player,
                    canPlay: true,
                },
                duration: status === 'Playing' ? 6000 : 4000,
            });
        } catch (e) { log(`[DynamicPill] media handle error ${e}`); }
    }

    _getMetaString(meta, key) {
        if (!(key in meta)) return null;
        try {
            const v = meta[key];
            if (v instanceof GLib.Variant) return v.unpack();
            return v;
        } catch (e) { return null; }
    }

    _getMetaArray(meta, key) {
        if (!(key in meta)) return [];
        try {
            const v = meta[key];
            const unpacked = v instanceof GLib.Variant ? v.unpack() : v;
            if (Array.isArray(unpacked)) return unpacked;
            return [];
        } catch (e) { return []; }
    }

    disable() {
        if (this._ownerChangedId) {
            try { Gio.DBus.session.signal_unsubscribe(this._ownerChangedId); } catch (e) {}
            this._ownerChangedId = null;
        }
        for (const [player, entry] of this._players) {
            if (entry.proxy && entry.sigId) {
                try { entry.proxy.disconnect(entry.sigId); } catch (e) {}
            }
        }
        this._players.clear();
    }
}
