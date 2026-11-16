import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const POPUP_COLUMNS = 4, MAX_DOTS = 4, SHADOW_PAD = 20, HIDE_DELAY_MS = 400, ANIM_MS = 200, TOOLTIP_GAP = 8, PRESSURE_TIMEOUT = 1000;
const vbox = (p = {}) => { const b = new St.BoxLayout(p); 'orientation' in b ? b.orientation = Clutter.Orientation.VERTICAL : b.vertical = true; return b; };
const lookupApp = id => Shell.AppSystem.get_default().lookup_app(id);
const isRunning = id => lookupApp(id)?.get_state() === Shell.AppState.RUNNING;
const appWindows = app => app.get_windows().filter(w => !w.skip_taskbar);
const findStockDash = () => {
    const direct = Main.overview?._overview?._controls?.dash;
    if (direct instanceof Dash.Dash) return direct;
    for (const root of [Main.overview?._overview, Main.layoutManager.overviewGroup].filter(Boolean)) {
        for (const stack = [root]; stack.length;) {
            const a = stack.pop();
            if (a instanceof Dash.Dash) return a;
            stack.push(...a.get_children());
        }
    }
    return null;
};

class LayoutStore {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'folder-dock']);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'layout.json']));
        this.items = [];
    }
    load() {
        if (this._file.query_exists(null)) {
            try { this.items = JSON.parse(new TextDecoder().decode(this._file.load_contents(null)[1])); return; }
            catch (e) { logError(e, 'folder-dock: layout.json unreadable, reseeding from favorites'); }
        }
        this.items = global.settings.get_strv('favorite-apps').map(id => ({type: 'app', id}));
        this.save();
    }
    save() {
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._file.replace_contents(new TextEncoder().encode(JSON.stringify(this.items, null, 2)), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
    flatIds() { return this.items.flatMap(i => i.type === 'folder' ? i.apps : i.id); }
    reconcile(favorites) {
        const wanted = new Set(favorites), before = JSON.stringify(this.items), seen = new Set();
        const keep = id => wanted.has(id) && !seen.has(id) && (seen.add(id), true);
        this.items = this.items.filter(i => i.type === 'folder' ? (i.apps = i.apps.filter(keep)).length > 0 : keep(i.id));
        favorites.forEach(id => !seen.has(id) && (seen.add(id), this.items.push({type: 'app', id})));
        return JSON.stringify(this.items) !== before;
    }
}

const FolderDock = GObject.registerClass(
class FolderDock extends St.BoxLayout {
    _init(store, settings, callbacks) {
        super._init({style_class: 'folder-dock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END, reactive: true, track_hover: true});
        this._delegate = this;
        this._store = store;
        this._settings = settings;
        this._cb = callbacks;
        this.menuOpen = this.dragging = false;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menus = []; this._dotUpdaters = []; this._appSignals = []; this._entries = []; this._runningOrder = []; this._renderedRunning = [];
        this._label = this._highlighted = null;
        const appSys = Shell.AppSystem.get_default(), tracker = Shell.WindowTracker.get_default();
        this._globalSignals = [
            [appSys, appSys.connect('app-state-changed', () => this._onAppStateChanged())],
            [appSys, appSys.connect('installed-changed', () => this.rebuild())],
            [tracker, tracker.connect('notify::focus-app', () => this._updateDots())],
        ];
        this._dragMonitor = {dragMotion: e => (!e.targetActor || !this.contains(e.targetActor)) && this._clearHighlight() || DND.DragMotionResult.CONTINUE};
        this.connect('destroy', () => {
            this._globalSignals.forEach(([o, id]) => o.disconnect(id));
            this._globalSignals = [];
            this._disconnectAppSignals();
            DND.removeDragMonitor(this._dragMonitor);
            [...this._menus].forEach(m => m.destroy());
            this._menus = [];
            this._label?.destroy();
            this._label = null;
        });
    }
    get _iconSize() { return this._settings.get_int('icon-size'); }
    get _previewSize() { return Math.max(8, Math.round(this._iconSize / 3)); }
    get _popupIconSize() { return Math.max(40, this._iconSize); }
    _computeRunning() {
        if (!this._settings.get_boolean('show-running')) return [];
        const pinned = new Set(this._store.flatIds()), running = Shell.AppSystem.get_default().get_running().map(a => a.get_id()).filter(id => !pinned.has(id));
        this._runningOrder = this._runningOrder.filter(id => running.includes(id)).concat(running.filter(id => !this._runningOrder.includes(id)));
        return [...this._runningOrder];
    }
    rebuild() {
        this.hideLabel();
        this._clearHighlight();
        this._dotUpdaters = [];
        this._disconnectAppSignals();
        this._entries = [];
        this.destroy_all_children();
        const showApps = this._settings.get_boolean('show-apps-button'), atStart = this._settings.get_string('show-apps-position') === 'start';
        if (showApps && atStart) this._addShowAppsButton(true);
        for (const item of this._store.items) {
            const actor = item.type === 'folder' ? this._buildFolder(item) : this._buildApp(item.id, true);
            if (actor) { this.add_child(actor); this._entries.push({actor, item}); }
        }
        const running = this._renderedRunning = this._computeRunning(), actors = running.map(id => [id, this._buildApp(id, false)]).filter(([, a]) => a);
        if (actors.length) {
            const sep = new St.Widget({style_class: 'dock-separator'});
            this.add_child(sep);
            this._entries.push({actor: sep, separator: true});
            for (const [id, actor] of actors) { this.add_child(actor); this._entries.push({actor, runningId: id}); }
        }
        if (showApps && !atStart) this._addShowAppsButton(false);
    }
    _addShowAppsButton(atStart) {
        let item, button;
        try {
            item = new Dash.ShowAppsIcon();
            item.icon.setIconSize(this._iconSize);
            item.show(false);
            item.x_expand = item.y_expand = false;
            item.y_align = Clutter.ActorAlign.CENTER;
            (button = item.toggleButton).y_expand = false;
            button.add_style_class_name('dock-show-apps');
        } catch {
            button = item = new St.Button({
                style_class: 'show-apps dock-show-apps', toggle_mode: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: this._iconSize, style_class: 'show-apps-icon'}),
            });
        }
        button.connect('clicked', () => this._toggleAppGrid(button));
        this._appSignals.push([Main.overview, Main.overview.connect('hidden', () => { button.checked = this._fromDesktop = false; })]);
        const stock = findStockDash()?.showAppsButton;
        if (stock) this._appSignals.push([stock, stock.connect('notify::checked', () => { button.checked = stock.checked; })]);
        this._attachTooltip(button, () => 'Show Apps');
        if (!atStart && this.get_n_children() > 0 && !this._entries.at(-1)?.separator) this.add_child(new St.Widget({style_class: 'dock-separator'}));
        this.add_child(item);
        if (atStart && this._store.items.length > 0) this.add_child(new St.Widget({style_class: 'dock-separator'}));
        this._entries.push({actor: item, showApps: true});
    }
    _inAppGrid() {
        const v = Main.overview?._overview?._controls?._stateAdjustment?.value;
        return Main.overview.visible && v !== undefined && Math.round(v) === OverviewControls.ControlsState.APP_GRID;
    }
    _toggleAppGrid(button) {
        const stock = findStockDash()?.showAppsButton, inGrid = this._inAppGrid();
        if (!Main.overview.visible) {
            this._fromDesktop = true;
            Main.overview.show(OverviewControls.ControlsState.APP_GRID);
        } else if (inGrid && this._fromDesktop) {
            this._fromDesktop = false;
            Main.overview.hide();
        } else if (stock) {
            stock.checked = !inGrid;
        } else {
            Main.overview._overview?._controls?._stateAdjustment?.ease?.(
                inGrid ? OverviewControls.ControlsState.WINDOW_PICKER : OverviewControls.ControlsState.APP_GRID,
                {duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        button.checked = !inGrid;
    }
    refreshRunning() { this._onAppStateChanged(); }
    _onAppStateChanged() {
        if (this._computeRunning().join('\n') !== this._renderedRunning.join('\n')) this.rebuild();
        else this._updateDots();
    }
    _disconnectAppSignals() { this._appSignals.forEach(([o, id]) => o.disconnect(id)); this._appSignals = []; }
    _updateDots() { this._dotUpdaters.forEach(u => u()); }
    _withDots(child, ids, button) {
        const box = vbox({style_class: 'dock-item-box'}), dots = new St.BoxLayout({style_class: 'dock-dots', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(child);
        box.add_child(dots);
        for (const id of ids) {
            const app = lookupApp(id);
            if (app) this._appSignals.push([app, app.connect('windows-changed', () => this._updateDots())]);
        }
        const update = () => {
            const app = ids.length === 1 ? lookupApp(ids[0]) : null;
            let n = (app && isRunning(ids[0])) ? Math.max(1, appWindows(app).length) : (ids.some(isRunning) ? 1 : 0);
            n = Math.min(n, MAX_DOTS);
            dots.destroy_all_children();
            if (!n) dots.add_child(new St.Widget({style_class: 'dock-running-dot', opacity: 0}));
            for (let i = 0; i < n; i++) dots.add_child(new St.Widget({style_class: 'dock-running-dot'}));
            const focusId = Shell.WindowTracker.get_default().focus_app?.get_id();
            button[focusId && ids.includes(focusId) ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('focused');
        };
        this._dotUpdaters.push(update);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (this._dotUpdaters.includes(update) && update(), GLib.SOURCE_REMOVE));
        return box;
    }
    _makeDraggable(btn, delegate) {
        btn._delegate = delegate;
        const d = DND.makeDraggable(btn);
        d.connect('drag-begin', () => this._dragBegin());
        d.connect('drag-cancelled', () => this._dragEnd());
        d.connect('drag-end', () => this._dragEnd());
    }
    _buildApp(id, pinned) {
        const app = lookupApp(id);
        if (!app) return null;
        const btn = new St.Button({style_class: 'dock-item', button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO, track_hover: true});
        btn.set_child(this._withDots(app.create_icon_texture(this._iconSize), [id], btn));
        btn.connect('clicked', (_b, c) => c === Clutter.BUTTON_MIDDLE && app.can_open_new_window() ? app.open_new_window(-1) : this._activateApp(app));
        btn.connect('button-press-event', (_a, e) => e.get_button() === Clutter.BUTTON_SECONDARY ? (this._openAppMenu(btn, app, pinned), Clutter.EVENT_STOP) : Clutter.EVENT_PROPAGATE);
        this._attachTooltip(btn, () => app.get_name());
        this._makeDraggable(btn, {app, dockSource: true, getDragActor: () => app.create_icon_texture(this._iconSize), getDragActorSource: () => btn});
        return btn;
    }
    _buildPreview(folder) {
        const preview = vbox({style_class: 'folder-preview'}), apps = folder.apps.map(lookupApp).filter(Boolean).slice(0, 4);
        for (let r = 0; r < 2; r++) {
            const row = new St.BoxLayout({style_class: 'folder-row'});
            for (let c = 0; c < 2; c++) {
                const app = apps[r * 2 + c];
                row.add_child(app ? app.create_icon_texture(this._previewSize) : new St.Widget({width: this._previewSize, height: this._previewSize}));
            }
            preview.add_child(row);
        }
        return preview;
    }
    _buildFolder(folder) {
        const btn = new St.Button({style_class: 'dock-item', button_mask: St.ButtonMask.ONE, track_hover: true});
        btn.set_child(this._withDots(this._buildPreview(folder), folder.apps, btn));
        btn.connect('clicked', () => this._openFolderMenu(btn, folder));
        btn.connect('button-press-event', (_a, e) => e.get_button() === Clutter.BUTTON_SECONDARY ? (this._openFolderContextMenu(btn, folder), Clutter.EVENT_STOP) : Clutter.EVENT_PROPAGATE);
        this._attachTooltip(btn, () => folder.name);
        this._makeDraggable(btn, {dockFolder: folder, dockSource: true, getDragActor: () => this._buildPreview(folder), getDragActorSource: () => btn});
        return btn;
    }
    _activateApp(app) {
        const ws = global.workspace_manager.get_active_workspace(), wins = appWindows(app).filter(w => w.located_on_workspace(ws));
        if (app.get_state() !== Shell.AppState.RUNNING || !wins.length || Shell.WindowTracker.get_default().focus_app !== app) app.activate();
        else if (wins.length === 1) wins[0].minimize();
        else Main.activateWindow(wins.at(-1));
    }
    _attachTooltip(btn, getText) {
        btn.connect('notify::hover', () => (btn.hover && !this.menuOpen && !this.dragging) ? this._showLabel(btn, getText()) : this.hideLabel());
        btn.connect('clicked', () => this.hideLabel());
    }
    _showLabel(actor, text) {
        if (!this._label) Main.uiGroup.add_child(this._label = new St.Label({style_class: 'folder-dock-label'}));
        this._label.text = text;
        this._label.remove_all_transitions();
        this._label.opacity = 0;
        this._label.show();
        this._labelActor = actor;
        this._repositionLabel();
        this._label.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    _repositionLabel() {
        const l = this._label, a = this._labelActor;
        if (!l?.visible || !a?.get_stage()) return;
        const ext = a.get_transformed_extents(), [, lw] = l.get_preferred_width(-1), [, lh] = l.get_preferred_height(lw), m = Main.layoutManager.primaryMonitor;
        let lx = Math.floor(ext.origin.x + (ext.size.width - lw) / 2);
        if (m) lx = Math.max(m.x, Math.min(lx, m.x + m.width - lw));
        l.set_position(lx, Math.floor(ext.origin.y - lh - TOOLTIP_GAP));
    }
    hideLabel() {
        this._labelActor = null;
        if (this._label) { this._label.remove_all_transitions(); this._label.hide(); }
    }
    _dragBegin() { this.dragging = true; this.hideLabel(); DND.addDragMonitor(this._dragMonitor); this._cb.onStateChanged(); }
    _dragEnd() { if (this.dragging) { this.dragging = false; DND.removeDragMonitor(this._dragMonitor); this._clearHighlight(); this._cb.onStateChanged(); } }
    externalDrag(active) { active ? this._dragBegin() : this._dragEnd(); }
    _clearHighlight() {
        if (this._highlighted) ['drop-into', 'drop-before', 'drop-after'].forEach(c => this._highlighted.remove_style_pseudo_class(c));
        this._highlighted = null;
    }
    _sourceInfo(s) { return s?.dockFolder ? {folder: s.dockFolder} : (s?.app instanceof Shell.App ? {id: s.app.get_id()} : null); }
    _dropTarget(info, x) {
        for (const entry of this._entries.filter(e => e.item)) {
            const b = entry.actor.get_allocation_box();
            if (x < b.x1) return {entry, mode: 'before'};
            if (x <= b.x2) {
                const f = (x - b.x1) / Math.max(1, b.x2 - b.x1), it = entry.item;
                return {entry, mode: (info.id && (it.type === 'folder' || it.id !== info.id) && f > 0.25 && f < 0.75) ? 'into' : (f < 0.5 ? 'before' : 'after')};
            }
        }
        return {entry: null, mode: 'end'};
    }
    handleDragOver(source, _actor, x) {
        const info = this._sourceInfo(source);
        if (!info) return DND.DragMotionResult.NO_DROP;
        const target = this._dropTarget(info, x);
        this._clearHighlight();
        if (target.entry) (this._highlighted = target.entry.actor).add_style_pseudo_class(`drop-${target.mode}`);
        return source.dockSource ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }
    acceptDrop(source, _actor, x) {
        const info = this._sourceInfo(source);
        if (!info) return false;
        const target = this._dropTarget(info, x);
        this._clearHighlight();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (this._applyDrop(info, target), GLib.SOURCE_REMOVE));
        return true;
    }
    _applyDrop(info, target) {
        const ref = target.entry?.item ?? null;
        if (ref && ((info.folder && ref === info.folder) || (info.id && ref.type === 'app' && ref.id === info.id && target.mode !== 'into'))) return;
        let rename = null;
        this._commit(() => {
            if (target.mode === 'into') {
                this._detachApp(info.id);
                if (ref.type === 'folder') {
                    if (!ref.apps.includes(info.id)) ref.apps.push(info.id);
                    if (!this._store.items.includes(ref)) this._store.items.push(ref);
                } else {
                    const folder = {type: 'folder', name: 'Folder', apps: [ref.id, info.id]}, idx = this._store.items.indexOf(ref);
                    idx >= 0 ? this._store.items.splice(idx, 1, folder) : this._store.items.push(folder);
                    rename = folder;
                }
            } else {
                let moving = info.folder ? (this._store.items = this._store.items.filter(i => i !== info.folder), info.folder) : (this._detachApp(info.id), {type: 'app', id: info.id});
                const idx = ref ? this._store.items.indexOf(ref) : -1;
                idx < 0 ? this._store.items.push(moving) : this._store.items.splice(target.mode === 'after' ? idx + 1 : idx, 0, moving);
            }
        });
        if (rename) this._promptRename(rename);
    }
    _registerMenu(menu) {
        this.hideLabel();
        if (!menu.actor.get_parent()) Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        this._menus.push(menu);
        menu.connect('destroy', () => { this._menus = this._menus.filter(m => m !== menu); this._setMenuOpen(false); });
        menu.connect('open-state-changed', (_m, open) => {
            this._setMenuOpen(open);
            if (!open) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (this._menus.includes(menu) && menu.destroy(), GLib.SOURCE_REMOVE));
        });
        return menu;
    }
    _makeMenu(source) { return this._registerMenu(new PopupMenu.PopupMenu(source, 0.5, St.Side.BOTTOM)); }
    _setMenuOpen(open) { if (this.menuOpen !== open) { this.menuOpen = open; this._cb.onStateChanged(); } }
    _openAppMenu(source, app, pinned) {
        const id = app.get_id();
        let menu;
        try {
            (menu = new AppMenu(source, St.Side.BOTTOM, {favoritesSection: true, showSingleWindows: true})).setApp(app);
            this._registerMenu(menu);
        } catch {
            menu = this._makeMenu(source);
            if (app.can_open_new_window()) menu.addAction('New Window', () => app.open_new_window(-1));
            pinned ? menu.addAction('Unpin', () => this._commit(() => this._detachApp(id))) : menu.addAction('Pin to Dock', () => this._commit(() => this._store.items.push({type: 'app', id})));
            if (app.get_state() === Shell.AppState.RUNNING) menu.addAction('Quit', () => app.request_quit());
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._store.items.filter(i => i.type === 'folder').forEach(f => menu.addAction(`Move to folder "${f.name}"`, () => this._moveAppTo(id, f)));
        menu.addAction('New folder with this app…', () => this._promptNewFolder(id));
        menu.open();
    }
    _openFolderMenu(source, folder) {
        const menu = this._makeMenu(source), grid = vbox({style_class: 'folder-grid'});
        let row = null;
        folder.apps.filter(lookupApp).forEach((id, i) => {
            if (i % POPUP_COLUMNS === 0) grid.add_child(row = new St.BoxLayout({style_class: 'folder-row'}));
            row.add_child(this._popupAppButton(id, menu));
        });
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.add_child(grid);
        menu.addMenuItem(item);
        menu.open();
    }
    _openFolderContextMenu(source, folder) {
        const menu = this._makeMenu(source), takeOut = new PopupMenu.PopupSubMenuMenuItem('Move app out of folder');
        menu.addAction('Rename folder…', () => this._promptRename(folder));
        folder.apps.forEach(id => {
            const app = lookupApp(id);
            takeOut.menu.addAction(app ? app.get_name() : id, () => this._commit(() => this._takeOutOfFolder(folder, id)));
        });
        menu.addMenuItem(takeOut);
        menu.addAction('Delete folder (keep apps)', () => this._commit(() => this._dissolveFolder(folder)));
        menu.addAction('Unpin folder and its apps', () => this._commit(() => { this._store.items = this._store.items.filter(i => i !== folder); }));
        menu.open();
    }
    _popupAppButton(id, menu) {
        const app = lookupApp(id), box = vbox();
        box.add_child(app.create_icon_texture(this._popupIconSize));
        box.add_child(new St.Widget({style_class: 'dock-running-dot', x_align: Clutter.ActorAlign.CENTER, opacity: isRunning(id) ? 255 : 0}));
        box.add_child(new St.Label({text: app.get_name(), style_class: 'folder-app-label'}));
        const btn = new St.Button({style_class: 'folder-app', child: box, button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO});
        btn.connect('clicked', (_b, c) => { menu.close(); c === Clutter.BUTTON_MIDDLE && app.can_open_new_window() ? app.open_new_window(-1) : this._activateApp(app); });
        return btn;
    }
    _commit(fn) { fn(); this._store.save(); this.rebuild(); this._cb.onChanged(); }
    _detachApp(id) {
        this._store.items = this._store.items.filter(i => !(i.type === 'app' && i.id === id)).filter(i => i.type !== 'folder' || (i.apps = i.apps.filter(a => a !== id)).length > 0);
    }
    _moveAppTo(id, folder) { this._commit(() => { this._detachApp(id); folder.apps.push(id); if (!this._store.items.includes(folder)) this._store.items.push(folder); }); }
    _takeOutOfFolder(folder, id) {
        const items = this._store.items, idx = items.indexOf(folder);
        folder.apps = folder.apps.filter(a => a !== id);
        const app = {type: 'app', id};
        idx < 0 ? items.push(app) : (!folder.apps.length ? items.splice(idx, 1, app) : items.splice(idx + 1, 0, app));
    }
    _promptNewFolder(id) { this._prompt('New folder', '', name => this._commit(() => { this._detachApp(id); this._store.items.push({type: 'folder', name, apps: [id]}); })); }
    _promptRename(folder) { this._prompt('Rename folder', folder.name, name => this._commit(() => { folder.name = name; })); }
    _dissolveFolder(folder) {
        const items = this._store.items, idx = items.indexOf(folder);
        if (idx >= 0) items.splice(idx, 1, ...folder.apps.map(id => ({type: 'app', id})));
    }
    _prompt(title, initial, onOk) {
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true}), entry = new St.Entry({text: initial, hint_text: 'Folder name', can_focus: true, style_class: 'folder-entry'});
        dialog.contentLayout.add_child(new St.Label({text: title}));
        dialog.contentLayout.add_child(entry);
        const submit = () => { const name = entry.get_text().trim(); dialog.close(); if (name) onOk(name); };
        dialog.setButtons([{label: 'Cancel', action: () => dialog.close()}, {label: 'OK', default: true, action: submit}]);
        entry.clutter_text.connect('activate', submit);
        dialog.open();
        global.stage.set_key_focus(entry);
        entry.clutter_text.set_selection(0, -1);
    }
});

export default class FolderDockExtension extends Extension {
    enable() {
        try { this._enable(); }
        catch (e) { logError(e, 'folder-dock: enable failed, restoring stock dash'); this.disable(); throw e; }
    }
    _enable() {
        this._signals = [];
        this._windowSignals = new Map();
        this._shown = true;
        this._pressureReveal = false;
        this._store = new LayoutStore();
        this._store.load();
        this._store.reconcile(global.settings.get_strv('favorite-apps'));
        this._store.save();
        this._settings = this.getSettings('org.gnome.shell.extensions.folder-dock');
        this._dock = new FolderDock(this._store, this._settings, {
            onChanged: () => { this._writeFavorites(); this._updateGeometry(); },
            onStateChanged: () => this._queueSync((this._dock?.menuOpen || this._dock?.dragging) ? 0 : HIDE_DELAY_MS),
        });
        this._edge = new St.Widget({reactive: true, track_hover: true, height: 1, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END, visible: false});
        this._container = new St.Widget({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true});
        this._dock.margin_bottom = this._margin;
        this._applyOpacity();
        this._container.add_child(this._edge);
        this._container.add_child(this._dock);
        Main.layoutManager.addChrome(this._container, {affectsInputRegion: false, affectsStruts: false, trackFullscreen: true});
        Main.layoutManager.trackChrome(this._dock, {affectsInputRegion: true});
        Main.layoutManager.trackChrome(this._edge, {affectsInputRegion: true});
        [
            [this._settings, 'changed', (_s, k) => this._onSettingsChanged(k)],
            [Main.layoutManager, 'monitors-changed', () => { this._updateGeometry(); this._setupBarrier(); }],
            [this._dock, 'notify::allocation', () => this._onDockAllocated()],
            [this._dock, 'notify::hover', () => this._onHoverChanged()],
            [this._edge, 'notify::hover', () => this._onHoverChanged()],
            [Main.overview, 'showing', () => { this._hideOverviewDash(); this._queueSync(0); }],
            [Main.overview, 'hidden', () => this._queueSync(0)],
            [Main.overview, 'item-drag-begin', () => this._dock.externalDrag(true)],
            [Main.overview, 'item-drag-end', () => this._dock.externalDrag(false)],
            [Main.overview, 'item-drag-cancelled', () => this._dock.externalDrag(false)],
            [global.settings, 'changed::favorite-apps', () => this._onFavoritesChanged()],
            [global.display, 'window-created', (_d, win) => { this._trackWindow(win); this._queueSync(150); }],
            [global.display, 'restacked', () => this._queueSync(150)],
            [global.display, 'notify::focus-window', () => this._queueSync(150)],
            [global.workspace_manager, 'active-workspace-changed', () => this._queueSync(150)],
        ].forEach(([obj, sig, fn]) => this._connect(obj, sig, fn));
        if (Main.layoutManager._startingUp) {
            this._connect(Main.layoutManager, 'startup-complete', () => {
                this._updateGeometry(); this._setupBarrier(); this._hideOverviewDash(); this._queueSync(0);
            });
        }
        for (const actor of global.get_window_actors()) this._trackWindow(actor.meta_window);
        this._dock.rebuild();
        this._writeFavorites();
        this._updateGeometry();
        this._setupBarrier();
        log(`folder-dock: enabled with ${this._store.items.length} items`);
        this._hideOverviewDash();
        this._queueSync(0);
    }
    disable() {
        ['_syncId', '_revealPollId'].forEach(p => this[p] && (GLib.source_remove(this[p]), this[p] = 0));
        (this._signals ?? []).forEach(([o, id]) => o.disconnect(id));
        this._signals = [];
        (this._windowSignals ?? new Map()).forEach((ids, win) => ids.forEach(id => win.disconnect(id)));
        this._windowSignals?.clear();
        this._removeBarrier();
        this._pressure?.destroy();
        this._pressure = null;
        this._restoreOverviewDash();
        if (this._container) {
            if (this._dock) Main.layoutManager.untrackChrome(this._dock);
            if (this._edge) Main.layoutManager.untrackChrome(this._edge);
            Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
        } else { this._dock?.destroy(); }
        this._container = this._dock = this._edge = this._store = this._settings = null;
    }
    _containerHeight() { return Math.ceil(this._dock.get_preferred_height(-1)[1]) + this._margin + SHADOW_PAD; }
    get _margin() { return this._settings.get_int('bottom-margin'); }
    _applyOpacity() { this._dock.set_style(`background-color: rgba(30, 30, 34, ${this._settings.get_double('background-opacity').toFixed(2)});`); }
    _onSettingsChanged(key) {
        if (['icon-size', 'show-running', 'show-apps-button', 'show-apps-position'].includes(key)) { this._dock.rebuild(); this._updateGeometry(); }
        else if (key === 'bottom-margin') { this._dock.margin_bottom = this._margin; this._updateGeometry(); }
        else if (key === 'background-opacity') this._applyOpacity();
        else if (key === 'pressure-threshold') { this._removeBarrier(); this._pressure?.destroy(); this._pressure = null; this._setupBarrier(); }
        else if (key === 'autohide-mode') this._queueSync(0);
    }
    _connect(obj, sig, fn) { this._signals.push([obj, obj.connect(sig, fn)]); }
    _onFavoritesChanged() {
        if (!this._store) return;
        if (this._store.reconcile(global.settings.get_strv('favorite-apps'))) { this._store.save(); this._dock.rebuild(); this._updateGeometry(); }
        else this._dock.refreshRunning();
        this._writeFavorites();
    }
    _writeFavorites() {
        if (!global.settings.is_writable('favorite-apps')) return;
        const ids = this._store.flatIds();
        if (ids.join('\n') !== global.settings.get_strv('favorite-apps').join('\n')) global.settings.set_strv('favorite-apps', ids);
    }
    _updateGeometry() {
        const m = Main.layoutManager.primaryMonitor;
        if (!this._container || !m) return;
        const h = this._containerHeight(), y = m.y + m.height - h;
        if (this._container.x !== m.x || this._container.y !== y) this._container.set_position(m.x, y);
        if (this._container.width !== m.width || this._container.height !== h) this._container.set_size(m.width, h);
    }
    _onDockAllocated() {
        const w = Math.max(1, Math.round(this._dock.width));
        if (this._edge.width !== w) this._edge.width = w;
        if (this._containerHeight() !== this._container.height) this._updateGeometry();
    }
    _setupBarrier() {
        this._removeBarrier();
        const m = Main.layoutManager.primaryMonitor;
        if (!m) return;
        try {
            if (!this._pressure) {
                this._pressure = new Layout.PressureBarrier(this._settings.get_int('pressure-threshold'), PRESSURE_TIMEOUT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
                this._pressure.connect('trigger', () => this._onPressure());
            }
            const p = {x1: m.x, x2: m.x + m.width, y1: m.y + m.height, y2: m.y + m.height, directions: Meta.BarrierDirection.NEGATIVE_Y};
            try { this._barrier = new Meta.Barrier({backend: global.backend, ...p}); } catch { this._barrier = new Meta.Barrier({display: global.display, ...p}); }
            this._pressure.addBarrier(this._barrier);
            this._edge.hide();
        } catch (e) {
            logError(e, 'folder-dock: pointer barrier unavailable, using hot edge');
            this._barrier = null;
            this._edge.show();
        }
    }
    _removeBarrier() {
        if (this._barrier) { this._pressure?.removeBarrier(this._barrier); this._barrier.destroy?.(); this._barrier = null; }
    }
    _onPressure() {
        this._pressureReveal = true;
        this._queueSync(0);
        if (!this._revealPollId) {
            this._revealPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                const [, py] = global.get_pointer();
                if (this._container && py >= this._container.y) return GLib.SOURCE_CONTINUE;
                this._pressureReveal = false;
                this._revealPollId = 0;
                this._queueSync(HIDE_DELAY_MS);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
    _trackWindow(win) {
        if (!win || this._windowSignals.has(win)) return;
        const ids = ['position-changed', 'size-changed', 'notify::minimized', 'workspace-changed'].map(s => win.connect(s, () => this._queueSync(150)));
        ids.push(win.connect('unmanaged', () => { ids.forEach(id => win.disconnect(id)); this._windowSignals.delete(win); this._queueSync(150); }));
        this._windowSignals.set(win, ids);
    }
    _onHoverChanged() { this._queueSync((this._dock.hover || this._edge.hover) ? 0 : HIDE_DELAY_MS); }
    _queueSync(delay) {
        if (this._syncId) GLib.source_remove(this._syncId);
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => (this._syncId = 0, this._sync(), GLib.SOURCE_REMOVE));
    }
    _sync() { if (this._dock) this._setShown(this._shouldShow()); }
    _shouldShow() {
        if (Main.overview.visible || this._pressureReveal || this._dock.hover || this._edge.hover || this._dock.menuOpen || this._dock.dragging) return true;
        const mode = this._settings.get_string('autohide-mode');
        return mode === 'never' ? true : (mode === 'always' ? false : !this._windowOverlapsDock());
    }
    _windowOverlapsDock() {
        const box = this._dock.get_allocation_box(), [dw, dh] = [box.get_width(), box.get_height()];
        if (dw <= 0 || dh <= 0) return false;
        const dx = this._container.x + box.x1, dy = this._container.y + box.y1, ws = global.workspace_manager.get_active_workspace(), mon = Main.layoutManager.primaryIndex;
        return global.get_window_actors().some(a => {
            const w = a.meta_window;
            if (!w || w.minimized || w.is_override_redirect() || [Meta.WindowType.DESKTOP, Meta.WindowType.DOCK].includes(w.get_window_type()) || !w.showing_on_its_workspace() || !w.located_on_workspace(ws) || w.get_monitor() !== mon) return false;
            const r = w.get_frame_rect();
            return r.x < dx + dw && r.x + r.width > dx && r.y < dy + dh && r.y + r.height > dy;
        });
    }
    _setShown(show) {
        if (this._shown === show) return;
        this._shown = show;
        this._dock.remove_all_transitions();
        if (show) {
            this._dock.show();
            this._dock.ease({translation_y: 0, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => Main.layoutManager._queueUpdateRegions?.()});
        } else {
            this._dock.hideLabel();
            this._dock.ease({translation_y: this._container.height, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => { if (!this._shown) this._dock.hide(); Main.layoutManager._queueUpdateRegions?.(); }});
        }
    }
    _hideOverviewDash() {
        if (this._dashActor) return;
        const dash = findStockDash();
        if (!dash) return log('folder-dock: stock dash not found, leaving it alone');
        this._dashActor = dash;
        this._dashWasVisible = dash.visible;
        dash.hide();
        this._dashVisibleId = dash.connect('notify::visible', () => dash.visible && dash.hide());
    }
    _restoreOverviewDash() {
        if (this._dashActor && this._dashVisibleId) { this._dashActor.disconnect(this._dashVisibleId); this._dashVisibleId = 0; }
        if (this._dashActor) this._dashActor.visible = this._dashWasVisible;
        this._dashActor = null;
    }
}
