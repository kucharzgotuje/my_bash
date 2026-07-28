import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// -- Constants -----------------------------------------------------------------
const IDLE_THRESHOLD_SECONDS = 180;
const TICK_INTERVAL_SECONDS = 1;
const SAVE_INTERVAL_SECONDS = 30;   // persist to disk every 30 s, not every tick
const DAY_ROLLOVER_HOUR = 4;        // logical day/week starts at 04:00
const HISTORY_MONTHS = 4;           // how far back the weekly table goes
const TOP_APPS_TRACKING = true;     // record per-app seconds in the JSON file
const DATA_DIR = GLib.get_user_data_dir() + '/screentime-tracker';
const DATA_FILE = DATA_DIR + '/data.json';

// -- Helpers: dates ------------------------------------------------------------

// "Logical now": wall clock shifted back by DAY_ROLLOVER_HOUR hours, so that
// 00:00-04:00 on Monday still counts as Sunday (previous week) and a new
// week starts Monday 04:00.
function logicalNow() {
    return new Date(Date.now() - DAY_ROLLOVER_HOUR * 3600 * 1000);
}

function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey() {
    return dateKey(logicalNow());
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
}

// Monday of the current logical week (00:00:00 logical time)
function currentWeekMonday() {
    const d = logicalNow();
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0 = Sunday
    const diff = (day === 0) ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
}

// Sum of seconds from a start date (inclusive) up to the logical today
function secondsFrom(data, fromDate) {
    const today = logicalNow();
    today.setHours(0, 0, 0, 0);
    let total = 0;
    const d = new Date(fromDate);
    while (d <= today) {
        total += data.days?.[dateKey(d)]?.total ?? 0;
        d.setDate(d.getDate() + 1);
    }
    return total;
}

function currentWeekSeconds(data) {
    return secondsFrom(data, currentWeekMonday());
}

function currentMonthSeconds(data) {
    const now = logicalNow();
    return secondsFrom(data, new Date(now.getFullYear(), now.getMonth(), 1));
}

function getActiveAppName() {
    try {
        const win = global.display.focus_window;
        if (!win) return null;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        return app ? app.get_name() : null;
    } catch (_e) {
        return null;
    }
}

// Locale-aware short weekday names, Monday first (2024-01-01 was a Monday).
function localizedDayNames() {
    const names = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(2024, 0, 1 + i);
        let n = d.toLocaleDateString(undefined, { weekday: 'short' });
        n = n.replace(/\.$/, ''); // some locales append a dot ("pon.")
        names.push(n.charAt(0).toUpperCase() + n.slice(1));
    }
    return names;
}

// -- Helpers: weekly table -----------------------------------------------------

// Builds the list of weeks covering the last `monthsBack` months.
// Each week: { monday: Date, days: [seconds|null ×7] } — null = future day.
// Newest week first.
function buildWeeks(data, monthsBack) {
    const today = logicalNow();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setMonth(start.getMonth() - monthsBack);
    const sd = start.getDay();
    start.setDate(start.getDate() + (sd === 0 ? -6 : 1 - sd)); // align to Monday

    const weeks = [];
    const cur = new Date(start);
    while (cur <= today) {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(cur);
            d.setDate(cur.getDate() + i);
            days.push(d > today ? null : (data.days?.[dateKey(d)]?.total ?? 0));
        }
        weeks.push({ monday: new Date(cur), days });
        cur.setDate(cur.getDate() + 7);
    }
    return weeks.reverse();
}

// Table cell: "h:mm", "–" for zero, "·" for future
function fmtCell(sec) {
    if (sec === null) return '·';
    if (!sec) return '–';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

// Week range: "29.06–05.07"
function fmtWeekRange(monday) {
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const dm = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${dm(monday)}–${dm(sunday)}`;
}

// -- Indicator -----------------------------------------------------------------

const ScreenTimeIndicator = GObject.registerClass(
    class ScreenTimeIndicator extends PanelMenu.Button {

        _init() {
            super._init(0.0, _('Screen Time Tracker'));

            const box = new St.BoxLayout({ style_class: 'stt-panel-box' });
            this._stateIcon = new St.Icon({
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._label = new St.Label({
                text: '0m',
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(this._stateIcon);
            box.add_child(this._label);
            this.add_child(box);

            this._paused = false;
            this._ticksSinceSave = 0;
            this._saving = false;
            this._savePending = false;
            this._data = this._loadData();

            // Key of the current logical day — watched for rollover in _tick()
            this._currentKey = todayKey();
            this._todaySec = this._data.days?.[this._currentKey]?.total ?? 0;

            this._idleMonitor = global.backend.get_core_idle_monitor();

            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                TICK_INTERVAL_SECONDS,
                () => { this._tick(); return GLib.SOURCE_CONTINUE; }
            );

            this.menu.connect('open-state-changed', (_menu, open) => {
                if (open) this._rebuildMenu();
            });

            this._updateLabel();
            this._updateStateIcon();

            // PopupMenu.open() returns early when the menu is empty
            // (isEmpty()), without any error or log. Building the contents
            // only in 'open-state-changed' is therefore a deadlock: empty
            // menu → open() bails → the signal never fires → the menu never
            // gets populated. So build it once eagerly here; the handler
            // above only refreshes the data on each open.
            this._rebuildMenu();
        }

        // -- Tick ----------------------------------------------------------

        _tick() {
            if (this._paused) return;

            const idleSec = this._idleMonitor.get_idletime() / 1000;
            if (idleSec >= IDLE_THRESHOLD_SECONDS) return;

            // A GNOME session survives suspend/resume, so the (logical) day
            // can change during this object's lifetime. Without this reset,
            // _todaySec would carry yesterday's total into the new day.
            const key = todayKey();
            if (key !== this._currentKey) {
                this._currentKey = key;
                this._todaySec = this._data.days?.[key]?.total ?? 0;
            }

            this._todaySec += TICK_INTERVAL_SECONDS;

            if (!this._data.days) this._data.days = {};
            if (!this._data.days[key]) this._data.days[key] = { total: 0, apps: {} };
            this._data.days[key].total = this._todaySec;

            if (TOP_APPS_TRACKING) {
                const appName = getActiveAppName();
                if (appName) {
                    if (!this._data.days[key].apps) this._data.days[key].apps = {};
                    const apps = this._data.days[key].apps;
                    apps[appName] = (apps[appName] ?? 0) + TICK_INTERVAL_SECONDS;
                }
            }

            if (++this._ticksSinceSave >= SAVE_INTERVAL_SECONDS) {
                this._saveData();
                this._ticksSinceSave = 0;
            }

            this._updateLabel();
        }

        // -- Label ---------------------------------------------------------

        _updateLabel() {
            const wSec = currentWeekSeconds(this._data);
            const mSec = currentMonthSeconds(this._data);
            this._label.set_text(
                `Today: ${formatDuration(this._todaySec)} | Week: ${formatDuration(wSec)} | Month: ${formatDuration(mSec)}`
            );
        }

        // Recording state icon: red record dot while tracking, pause bars
        // while paused. Cached so per-tick calls don't touch St properties.
        _updateStateIcon() {
            const recording = !this._paused;
            if (this._iconRecording === recording) return;
            this._iconRecording = recording;
            this._stateIcon.icon_name = recording
                ? 'media-record-symbolic'
                : 'media-playback-pause-symbolic';
            this._stateIcon.style_class = recording
                ? 'stt-state-icon stt-icon-recording'
                : 'stt-state-icon stt-icon-paused';
        }

        // -- Popup: weekly table -------------------------------------------

        _rebuildMenu() {
            // An exception inside the 'open-state-changed' handler kills
            // menu construction silently — catch it, log it, show it.
            try {
                this._buildMenuContents();
            } catch (e) {
                console.error('ScreenTimeTracker: failed to build menu', e);
                this.menu.removeAll();
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    `${_('Error')}: ${e.message}`, { reactive: false }));
            }
        }

        _buildMenuContents() {
            this.menu.removeAll();

            // Pause toggle
            const pauseItem = new PopupMenu.PopupMenuItem(
                this._paused ? `▶  ${_('Resume')}` : `⏸  ${_('Pause')}`);
            pauseItem.connect('activate', () => {
                this._paused = !this._paused;
                this._saveData(); // flush on pause — data always current
                this._updateLabel();
                this._updateStateIcon();
                pauseItem.label.set_text(
                    this._paused ? `▶  ${_('Resume')}` : `⏸  ${_('Pause')}`);
            });
            this.menu.addMenuItem(pauseItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const weeks = buildWeeks(this._data, HISTORY_MONTHS);
            const hasData = weeks.some(w => w.days.some(s => s));
            if (!hasData) {
                this._addTableRow([_('No data')]);
                return;
            }

            // Header row: localized weekday names + SUM
            this._addTableRow(
                [_('Week'), ...localizedDayNames(), _('SUM')], true);

            const thisMondayKey = dateKey(currentWeekMonday());
            let grandTotal = 0;

            for (const week of weeks) {
                const sum = week.days.reduce((s, v) => s + (v ?? 0), 0);
                if (sum === 0 && dateKey(week.monday) !== thisMondayKey)
                    continue; // skip fully empty weeks (except the current one)
                grandTotal += sum;

                const marker = dateKey(week.monday) === thisMondayKey ? '▶ ' : '';
                this._addTableRow([
                    marker + fmtWeekRange(week.monday),
                    ...week.days.map(fmtCell),
                    fmtCell(sum),
                ]);
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Total row: label expands, value lands under the SUM column
            // (the table rows are the widest menu items, so the row's right
            // edge coincides with the SUM column's right edge).
            const totalItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            totalItem.add_child(new St.Label({
                text: _('Total (last 4 months)'),
                style_class: 'stt-cell stt-cell-week stt-row-header',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            totalItem.add_child(new St.Label({
                text: fmtCell(grandTotal),
                style_class: 'stt-cell stt-row-header',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this.menu.addMenuItem(totalItem);
        }

        // Table row: one fixed-width St.Label per cell (styling lives in
        // stylesheet.css), so columns line up regardless of glyph widths.
        _addTableRow(cells, header = false) {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            cells.forEach((text, i) => {
                const label = new St.Label({
                    text,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: i === 0 ? 'stt-cell stt-cell-week' : 'stt-cell',
                });
                if (header)
                    label.add_style_class_name('stt-row-header');
                item.add_child(label);
            });
            this.menu.addMenuItem(item);
        }

        // -- Data ----------------------------------------------------------

        _loadData() {
            try {
                const dir = Gio.File.new_for_path(DATA_DIR);
                if (!dir.query_exists(null)) dir.make_directory_with_parents(null);

                const file = Gio.File.new_for_path(DATA_FILE);
                if (!file.query_exists(null)) return {};

                const [, contents] = file.load_contents(null);
                return JSON.parse(new TextDecoder().decode(contents));
            } catch (e) {
                console.error('ScreenTimeTracker: failed to read data', e);
                return {};
            }
        }

        // Asynchronous save: never blocks the compositor thread. Concurrent
        // calls coalesce — if a write is in flight, remember and re-save
        // once it finishes.
        _saveData() {
            if (this._saving) {
                this._savePending = true;
                return;
            }
            this._saving = true;

            const bytes = new GLib.Bytes(
                new TextEncoder().encode(JSON.stringify(this._data, null, 2)));
            const file = Gio.File.new_for_path(DATA_FILE);
            file.replace_contents_bytes_async(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.error('ScreenTimeTracker: failed to save data', e);
                    }
                    this._saving = false;
                    if (this._savePending) {
                        this._savePending = false;
                        this._saveData();
                    }
                });
        }

        // Final synchronous flush — used only from destroy(), where async
        // completion can no longer be awaited.
        _saveDataSync() {
            try {
                const file = Gio.File.new_for_path(DATA_FILE);
                file.replace_contents(
                    new TextEncoder().encode(JSON.stringify(this._data, null, 2)),
                    null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
            } catch (e) {
                console.error('ScreenTimeTracker: failed to save data', e);
            }
        }

        // -- Cleanup -------------------------------------------------------

        destroy() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = null;
            }
            this._saveDataSync(); // don't lose the last ≤30 s
            super.destroy();
        }
    });

// -- Extension lifecycle -------------------------------------------------------

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._indicator = new ScreenTimeIndicator();
        Main.panel.addToStatusArea('screentime-tracker', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}