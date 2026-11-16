import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow(settings, key, title, subtitle, lower, upper, step = 1, digits = 0) {
    const adjustment = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10});
    const row = new Adw.SpinRow({title, subtitle, adjustment, digits});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const i = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

export default class FolderDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.folder-dock');
        window._settings = settings;
        window.set_default_size(560, 680);

        const page = new Adw.PreferencesPage({
            title: 'Folder Dock',
            icon_name: 'view-app-grid-symbolic',
        });

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(choiceRow(settings, 'dock-position', 'Position on screen', 'Which edge of your screen the dock sits on', [
            ['bottom', 'Bottom edge'],
            ['left', 'Left edge'],
            ['right', 'Right edge'],
        ]));
        look.add(spinRow(settings, 'icon-size', 'Icon size', 'Make app icons larger or smaller', 24, 96, 2));
        look.add(spinRow(settings, 'bottom-margin', 'Screen edge gap', 'Space between the dock and your screen border', 0, 48));
        look.add(spinRow(settings, 'background-opacity', 'Dock transparency', '0 is completely clear glass, 1 is solid dark', 0, 1, 0.05, 2));
        page.add(look);

        const behaviour = new Adw.PreferencesGroup({title: 'Behavior'});
        behaviour.add(choiceRow(settings, 'launch-animation', 'App click animation', 'What happens when you click an app to open it', [
            ['bounce', 'Bounce (Dash-to-Dock style)'],
            ['zoom', 'Pop zoom'],
            ['pulse', 'Gentle pulse'],
            ['none', 'None (instant launch)'],
        ]));
        behaviour.add(choiceRow(settings, 'autohide-mode', 'Hide the dock', 'Choose when the dock tucks out of view', [
            ['never', 'Never — always visible'],
            ['intellihide', 'Smart — hide only when a window is in the way'],
            ['always', 'Always — hide until your mouse touches the edge'],
        ]));
        behaviour.add(spinRow(settings, 'pressure-threshold', 'Edge push to reveal', 'How firmly to push your mouse against the edge to bring the dock back (0 = instant)', 0, 300, 10));
        page.add(behaviour);

        const content = new Adw.PreferencesGroup({title: 'Dock Items'});
        content.add(switchRow(settings, 'show-running', 'Show unpinned active apps', 'Keep open apps visible on the dock even if you have not pinned them'));
        content.add(switchRow(settings, 'show-apps-button', 'Show all apps button', 'Show the 9-dot icon that opens your full application list'));
        content.add(choiceRow(settings, 'show-apps-position', 'All apps button placement', 'Put the 9-dot icon at the start or end of the dock', [
            ['start', 'Start of dock'],
            ['end', 'End of dock'],
        ]));
        page.add(content);

        window.add(page);
    }
}
