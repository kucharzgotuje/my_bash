import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const IDLE_THRESHOLD_SECONDS = 60;
const TICK_INTERVAL_SECONDS = 1;
const DATA_DIR = GLib.get_user_data_dir() + '/screentime-tracker';
const DATA_FILE = DATA_DIR + '/data.json';

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    // const s = seconds % 60;
    // if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    // return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${m}m`;
}

function weekSeconds(data) {
    const today = new Date();
    let total = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        total += data.days?.[key]?.total ?? 0;
    }
    return total;
}

const ScreenTimeIndicator = GObject.registerClass(
    class ScreenTimeIndicator extends PanelMenu.Button {

        _init() {
            super._init(0.0, 'Screen Time Tracker');

            this._label = new St.Label({
                text: 'Today: 0m 00s | Week: 0m 00s',
                y_align: 2,
            });
            this.add_child(this._label);

            this._paused = false;
            this._todaySec = 0;
            this._data = this._loadData();

            const key = todayKey();
            this._todaySec = this._data.days?.[key]?.total ?? 0;

            this._idleMonitor = global.backend.get_core_idle_monitor();

            // Kliknięcie = toggle pauzy
            this.connect('button-press-event', () => {
                this._paused = !this._paused;
                this._updateLabel();
                return true; // zatrzymaj propagację (nie otwieraj menu)
            });

            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                TICK_INTERVAL_SECONDS,
                () => { this._tick(); return GLib.SOURCE_CONTINUE; }
            );

            this._updateLabel();
        }

        _tick() {
            if (this._paused) return;

            const idleSec = this._idleMonitor.get_idletime() / 1000;
            if (idleSec >= IDLE_THRESHOLD_SECONDS) return;

            this._todaySec += TICK_INTERVAL_SECONDS;

            const key = todayKey();
            if (!this._data.days) this._data.days = {};
            if (!this._data.days[key]) this._data.days[key] = { total: 0 };
            this._data.days[key].total = this._todaySec;

            this._saveData();
            this._updateLabel();
        }

        _updateLabel() {
            const wSec = weekSeconds(this._data);
            const pause = this._paused ? '▶︎' : '⏸';
            this._label.set_text(`Today: ${formatDuration(this._todaySec)} | Week: ${formatDuration(wSec)} ${pause}`);
        }

        _loadData() {
            try {
                const dir = Gio.File.new_for_path(DATA_DIR);
                if (!dir.query_exists(null)) dir.make_directory_with_parents(null);

                const file = Gio.File.new_for_path(DATA_FILE);
                if (!file.query_exists(null)) return {};

                const [, contents] = file.load_contents(null);
                return JSON.parse(new TextDecoder().decode(contents));
            } catch (e) {
                console.error('ScreenTimeTracker: błąd odczytu danych', e);
                return {};
            }
        }

        _saveData() {
            try {
                const file = Gio.File.new_for_path(DATA_FILE);
                file.replace_contents(
                    new TextEncoder().encode(JSON.stringify(this._data, null, 2)),
                    null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
            } catch (e) {
                console.error('ScreenTimeTracker: błąd zapisu danych', e);
            }
        }

        destroy() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = null;
            }
            super.destroy();
        }
    });

export default class ScreenTimeExtension {
    enable() {
        this._indicator = new ScreenTimeIndicator();
        Main.panel.addToStatusArea('screentime-tracker', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
