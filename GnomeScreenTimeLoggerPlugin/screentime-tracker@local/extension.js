import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ── Stałe ─────────────────────────────────────────────────────────────────────
const IDLE_THRESHOLD_SECONDS = 60;
const TICK_INTERVAL_SECONDS = 1;
const SAVE_INTERVAL_SECONDS = 30;   // zapis na dysk co 30 s (nie co sekundę)
const DAY_ROLLOVER_HOUR = 4;        // logiczna doba/tydzień zaczyna się o 04:00
const HISTORY_MONTHS = 4;           // ile miesięcy wstecz pokazuje tabela
const TOP_APPS_TRACKING = true;     // nadal zbieramy statystyki aplikacji do JSON-a
const DATA_DIR = GLib.get_user_data_dir() + '/screentime-tracker';
const DATA_FILE = DATA_DIR + '/data.json';

// ── Helpers: daty ─────────────────────────────────────────────────────────────

// "Logiczne teraz": czas przesunięty o -DAY_ROLLOVER_HOUR godzin.
// Dzięki temu 00:00–04:00 w poniedziałek liczy się jeszcze jako niedziela
// (poprzedni tydzień), a nowy tydzień startuje w poniedziałek o 04:00.
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

// Poniedziałek logicznego bieżącego tygodnia (00:00:00 czasu logicznego)
function currentWeekMonday() {
    const d = logicalNow();
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=niedziela
    const diff = (day === 0) ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
}

// Suma sekund od daty startowej (włącznie) do logicznego dziś
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
    } catch (_) {
        return null;
    }
}

// ── Helpers: tabela tygodni ───────────────────────────────────────────────────

// Buduje listę tygodni z ostatnich `monthsBack` miesięcy.
// Każdy tydzień: { monday: Date, days: [sekundy|null ×7] } — null = przyszłość.
// Najnowszy tydzień pierwszy.
function buildWeeks(data, monthsBack) {
    const today = logicalNow();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setMonth(start.getMonth() - monthsBack);
    const sd = start.getDay();
    start.setDate(start.getDate() + (sd === 0 ? -6 : 1 - sd)); // wyrównanie do pon

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

// Komórka tabeli: "h:mm", "–" dla zera, "·" dla przyszłości; szerokość 5 znaków
function fmtCell(sec) {
    if (sec === null) return '·'.padStart(5);
    if (!sec) return '–'.padStart(5);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`.padStart(5);
}

// Zakres tygodnia: "29.06–05.07"
function fmtWeekRange(monday) {
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const dm = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${dm(monday)}–${dm(sunday)}`;
}

// ── Indicator ─────────────────────────────────────────────────────────────────

const ScreenTimeIndicator = GObject.registerClass(
    class ScreenTimeIndicator extends PanelMenu.Button {

        _init() {
            super._init(0.0, 'Screen Time Tracker');

            this._label = new St.Label({
                text: '0m | W: 0m | M: 0m',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);

            this._paused = false;
            this._ticksSinceSave = 0;
            this._data = this._loadData();

            // Klucz bieżącego dnia logicznego — pilnujemy zmiany doby w _tick()
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

            // FIX: PopupMenu.open() w popupMenu.js robi wczesny return,
            // gdy menu jest puste (isEmpty()) — bez błędu i bez logów.
            // Budowanie zawartości wyłącznie w 'open-state-changed' to
            // deadlock: puste menu → open() przerywa → sygnał nigdy nie
            // leci → menu nigdy się nie zapełnia. Dlatego budujemy je raz
            // od razu; handler powyżej tylko odświeża dane przy otwarciu.
            this._rebuildMenu();
        }

        // ── Tick ──────────────────────────────────────────────────────────────

        _tick() {
            if (this._paused) return;

            const idleSec = this._idleMonitor.get_idletime() / 1000;
            if (idleSec >= IDLE_THRESHOLD_SECONDS) return;

            // FIX: sesja GNOME przeżywa suspend/resume, więc doba może się
            // zmienić w trakcie życia obiektu. Bez tego resetu _todaySec
            // przenosił wczorajszą (albo piątkową!) sumę do nowego dnia,
            // przez co licznik tygodniowy "nie resetował się" w poniedziałek.
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

            // Zapis co SAVE_INTERVAL_SECONDS zamiast co sekundę
            if (++this._ticksSinceSave >= SAVE_INTERVAL_SECONDS) {
                this._saveData();
                this._ticksSinceSave = 0;
            }

            this._updateLabel();
        }

        // ── Label ─────────────────────────────────────────────────────────────

        _updateLabel() {
            const wSec = currentWeekSeconds(this._data);
            const mSec = currentMonthSeconds(this._data);
            const pause = this._paused ? ' ⏸' : '';
            this._label.set_text(
                `${formatDuration(this._todaySec)} | W: ${formatDuration(wSec)} | M: ${formatDuration(mSec)}${pause}`
            );
        }

        // ── Popup: tabela tygodniowa ──────────────────────────────────────────

        _rebuildMenu() {
            // Wyjątek w handlerze 'open-state-changed' zabija budowanie menu
            // po cichu — dlatego łapiemy go, logujemy i pokazujemy w menu.
            try {
                this._buildMenuContents();
            } catch (e) {
                console.error('ScreenTimeTracker: błąd budowania menu', e);
                this.menu.removeAll();
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    `Błąd: ${e.message}`, { reactive: false }));
            }
        }

        _buildMenuContents() {
            this.menu.removeAll();

            // Przycisk pauzy
            const pauseItem = new PopupMenu.PopupMenuItem(this._paused ? '▶  Wznów' : '⏸  Pauzuj');
            pauseItem.connect('activate', () => {
                this._paused = !this._paused;
                this._saveData(); // flush przy pauzie — dane zawsze aktualne
                this._updateLabel();
                pauseItem.label.set_text(this._paused ? '▶  Wznów' : '⏸  Pauzuj');
            });
            this.menu.addMenuItem(pauseItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const weeks = buildWeeks(this._data, HISTORY_MONTHS);
            const hasData = weeks.some(w => w.days.some(s => s));
            if (!hasData) {
                this._addMonoRow('Brak danych');
                return;
            }

            // Nagłówek
            const header =
                'Tydzień'.padEnd(14) +
                ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd', 'SUMA']
                    .map(s => s.padStart(5)).join(' ');
            this._addMonoRow(header, true);

            const thisMondayKey = dateKey(currentWeekMonday());
            let grandTotal = 0;

            for (const week of weeks) {
                const sum = week.days.reduce((s, v) => s + (v ?? 0), 0);
                if (sum === 0 && dateKey(week.monday) !== thisMondayKey)
                    continue; // pomiń całkiem puste tygodnie (poza bieżącym)
                grandTotal += sum;

                const marker = dateKey(week.monday) === thisMondayKey ? '▶ ' : '  ';
                const row =
                    (marker + fmtWeekRange(week.monday)).padEnd(14) +
                    week.days.map(fmtCell).join(' ') + ' ' +
                    fmtCell(sum);
                this._addMonoRow(row);
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addMonoRow(
                `Razem (${HISTORY_MONTHS} mies.)`.padEnd(14 + 6 * 7) + fmtCell(grandTotal),
                true
            );
        }

        // Wiersz tabeli: standardowy PopupMenuItem (sprawdzony w każdej wersji
        // Shella) z przestylowanym wbudowanym labelem — bez ręcznego add_child.
        _addMonoRow(text, bold = false) {
            const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
            item.label.set_style(
                'font-family: monospace; font-size: 9.5pt;' +
                (bold ? ' font-weight: bold;' : '')
            );
            this.menu.addMenuItem(item);
        }

        // ── Dane ──────────────────────────────────────────────────────────────

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

        // ── Cleanup ───────────────────────────────────────────────────────────

        destroy() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = null;
            }
            this._saveData(); // flush — nie gubimy ostatnich ≤30 s
            super.destroy();
        }
    });

// ── Extension lifecycle ───────────────────────────────────────────────────────

export default class ScreenTimeExtension {
    enable() {
        console.log('[ScreenTimeTracker] v3 loaded');
        this._indicator = new ScreenTimeIndicator();
        Main.panel.addToStatusArea('screentime-tracker', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}