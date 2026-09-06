import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DynamicPillPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 520);
        window.set_search_enabled(true);

        // General Page
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        const generalGroup = new Adw.PreferencesGroup({ title: _('General') });
        generalPage.add(generalGroup);

        generalGroup.add(this._createSwitchRow(settings, 'enable-pill', _('Enable Dynamic Pill'), _('Master toggle')));
        generalGroup.add(this._createSwitchRow(settings, 'idle-enabled', _('Show Idle Clock'), _('Display minimal time pill when idle')));
        generalGroup.add(this._createComboRow(settings, 'position', _('Position'), { 'top-center': _('Top Center'), 'below-panel': _('Below Panel'), 'panel-integrated': _('Panel Integrated') }));
        generalGroup.add(this._createSpinRow(settings, 'vertical-offset', _('Vertical Offset (px)'), 0, 80, 1));
        generalGroup.add(this._createComboRow(settings, 'monitor-mode', _('Show On'), { 'primary': _('Primary Monitor'), 'active': _('Active Monitor'), 'all': _('All Monitors (primary only v1)') }));
        generalGroup.add(this._createEntryRow(settings, 'idle-time-format', _('Time Format'), _('Strftime, e.g. %H:%M or %I:%M %p')));

        const appearanceGroup = new Adw.PreferencesGroup({ title: _('Appearance') });
        generalPage.add(appearanceGroup);
        appearanceGroup.add(this._createSpinDoubleRow(settings, 'pill-opacity', _('Pill Opacity'), 0.5, 1.0, 0.05));
        appearanceGroup.add(this._createSpinRow(settings, 'animation-speed', _('Animation Speed (ms)'), 80, 600, 10));
        appearanceGroup.add(this._createSwitchRow(settings, 'compact-mode', _('Compact Mode'), _('Smaller padding')));
        appearanceGroup.add(this._createSwitchRow(settings, 'show-shadow', _('Show Shadow'), _('Soft shadow under pill')));

        // Events Page
        const eventsPage = new Adw.PreferencesPage({
            title: _('Events'),
            icon_name: 'view-list-symbolic',
        });
        const eventsGroup = new Adw.PreferencesGroup({
            title: _('Enabled Events'),
            description: _('Choose which system events expand the pill'),
        });
        eventsPage.add(eventsGroup);
        eventsGroup.add(this._createSwitchRow(settings, 'enable-media', _('Media (MPRIS)'), _('Spotify, Firefox, VLC…')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-volume', _('Volume'), _('System volume & mute')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-brightness', _('Brightness'), _('Screen brightness OSD')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-battery', _('Battery'), _('Charging / low battery')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-workspace', _('Workspace'), _('Workspace switch indicator')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-notifications', _('Notifications'), _('Transient notification pill')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-network', _('Network'), _('Wi-Fi connect/disconnect')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-bluetooth', _('Bluetooth'), _('Bluetooth connect/disconnect')));
        eventsGroup.add(this._createSwitchRow(settings, 'enable-privacy', _('Privacy'), _('Mic / Camera / Screen share')));

        // Behavior Page
        const behaviorPage = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-other-symbolic',
        });
        const behaviorGroup = new Adw.PreferencesGroup({ title: _('Behavior') });
        behaviorPage.add(behaviorGroup);
        behaviorGroup.add(this._createSwitchRow(settings, 'hover-expand', _('Expand on Hover'), _('Gentle expand when hovering idle pill')));
        behaviorGroup.add(this._createSwitchRow(settings, 'auto-collapse', _('Auto Collapse'), _('Return to idle after timeout')));
        behaviorGroup.add(this._createSpinRow(settings, 'collapse-timeout', _('Collapse Timeout (ms)'), 800, 10000, 100));
        behaviorGroup.add(this._createSpinRow(settings, 'notification-timeout', _('Notification Timeout (ms)'), 1000, 8000, 100));

        const debugGroup = new Adw.PreferencesGroup({ title: _('Debug / Testing') });
        behaviorPage.add(debugGroup);
        debugGroup.add(this._createSwitchRow(settings, 'debug-mode', _('Debug Logging'), _('Verbose logs in Looking Glass')));

        const testGroup = new Adw.PreferencesGroup({
            title: _('Test Triggers'),
            description: _('Use Looking Glass (Alt+F2 → lg) then run: global.dynamicPillState.test("volume") — triggers: volume, brightness, media, battery, workspace, notification, network, bluetooth, privacy, idle'),
        });
        behaviorPage.add(testGroup);
        const testRow = new Adw.ActionRow({ title: _('Manual Test'), subtitle: _('Open Looking Glass to trigger events') });
        const testButton = new Gtk.Button({ label: _('Open Looking Glass Hint'), valign: Gtk.Align.CENTER });
        testButton.connect('clicked', () => {
            const dialog = new Gtk.MessageDialog({
                transient_for: window,
                modal: true,
                message_type: Gtk.MessageType.INFO,
                buttons: Gtk.ButtonsType.OK,
                text: 'Debug Test',
                secondary_text: 'Press Alt+F2, type "lg", press Enter. In the evaluator run:\n\nglobal.dynamicPillState.test("volume")\n\nother: brightness, media, battery, workspace, notification, privacy, idle',
            });
            dialog.connect('response', () => dialog.destroy());
            dialog.present();
        });
        testRow.add_suffix(testButton);
        testGroup.add(testRow);

        window.add(generalPage);
        window.add(eventsPage);
        window.add(behaviorPage);
    }

    _createSwitchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({ title, subtitle });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _createComboRow(settings, key, title, options) {
        const row = new Adw.ComboRow({ title });
        const strings = Object.values(options);
        const keys = Object.keys(options);
        const model = new Gtk.StringList();
        for (const s of strings) model.append(s);
        row.set_model(model);
        const current = settings.get_string(key);
        let idx = keys.indexOf(current);
        if (idx < 0) idx = 0;
        row.set_selected(idx);
        row.connect('notify::selected', () => {
            const sel = row.get_selected();
            settings.set_string(key, keys[sel]);
        });
        settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            const i = keys.indexOf(v);
            if (i !== row.get_selected()) row.set_selected(i);
        });
        return row;
    }

    _createSpinRow(settings, key, title, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, value: settings.get_int(key) }),
        });
        settings.bind(key, row.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        // digits 0
        row.set_digits(0);
        return row;
    }

    _createSpinDoubleRow(settings, key, title, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, value: settings.get_double(key) }),
        });
        settings.bind(key, row.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        row.set_digits(2);
        return row;
    }

    _createEntryRow(settings, key, title, subtitle) {
        const row = new Adw.EntryRow({ title, text: settings.get_string(key) });
        if (subtitle) {
            // Adw.EntryRow on some libadwaita versions lacks set_subtitle
            try {
                if (typeof row.set_subtitle === 'function') row.set_subtitle(subtitle);
                else if ('subtitle' in row) row.subtitle = subtitle;
                else row.set_tooltip_text(subtitle);
            } catch (e) {
                try { row.set_tooltip_text(subtitle); } catch (_) {}
            }
        }
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
