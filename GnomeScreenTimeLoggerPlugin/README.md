What does it do? 

Displays total time spent on current user profile if format of 

```Today: <time> | Week: <time> ```

Deactivates after 5 minutes of idle.
Click on it to pause or play again.

Where to put plugin

```
~/.local/share/gnome-shell/extensions/screentime-tracker@local/
├── extension.js      ← główna logika
├── metadata.json     ← definicja wtyczki
└── stylesheet.css    ← style (na razie puste)
```


How to activate it: 

```gnome-extensions enable screentime-tracker@local```

Where to look for debug info: 

```journalctl -f -o cat /usr/bin/gnome-shell 2>/dev/null | grep -i screentime```
