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
        look.add(spinRow(settings, 'icon-size', 'Icon size', 'App icon size in pixels', 24, 96, 2));
        look.add(spinRow(settings, 'bottom-margin', 'Bottom gap', 'Space between the dock and the screen edge', 0, 48));
        look.add(spinRow(settings, 'background-opacity', 'Background opacity', '0 is fully transparent, 1 is solid (applies to dock and folder popups)', 0, 1, 0.05, 2));
        page.add(look);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(choiceRow(settings, 'launch-animation', 'Launch animation', 'Animation played when launching or focusing an app', [
            ['bounce', 'Bounce (Dash-to-Dock)'],
            ['zoom', 'Zoom Pop'],
            ['pulse', 'Pulse / Glow'],
            ['none', 'None (Disabled)'],
        ]));
        behaviour.add(choiceRow(settings, 'autohide-mode', 'Auto-hide', 'When the dock slides out of the way', [
            ['never', 'Never — always visible'],
            ['intellihide', 'When a window overlaps it'],
            ['always', 'Always'],
        ]));
        behaviour.add(spinRow(settings, 'pressure-threshold', 'Reveal pressure', 'How hard to push the pointer against the bottom edge (0 = instant)', 0, 300, 10));
        page.add(behaviour);

        const content = new Adw.PreferencesGroup({title: 'Content'});
        content.add(switchRow(settings, 'show-running', 'Show running apps', 'Open apps that aren’t pinned appear after a divider'));
        content.add(switchRow(settings, 'show-apps-button', 'Show Apps button', 'Button that opens the app grid'));
        content.add(choiceRow(settings, 'show-apps-position', 'Show Apps button position', '', [
            ['start', 'Left end'],
            ['end', 'Right end'],
        ]));
        page.add(content);

        window.add(page);
    }
}
