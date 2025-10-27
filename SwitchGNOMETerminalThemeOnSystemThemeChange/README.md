File terminal-theme-watcher.service goes into  
`~/.config/systemd/user/`

File switch-terminal-color-scheme.sh goes into  
`~/.local/bin/`

Make it executable:  
`chmod +x ~/.local/bin/switch-terminal-color-scheme.sh`

Once there use systemctl to load and enable your service:  
`systemctl --user enable --now terminal-theme-watcher.service`

To see service status use:  
`systemctl --user status terminal-theme-watcher.service`

On service change load it again  
`systemctl --user daemon-reload`

Once enabled your service will startup on boot.
To disable service use:  
`systemctl --user disable terminal-theme-watcher.service`

To write this service I've used gsettings extensively. 
Besides ones in the code there waaay more  

Listen to events in gnome:  
`gsettings monitor org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:uid/`

See type of data for keys:  
`gsettings range org.gnome.Terminal.Legacy.Settings always-check-default-terminal`

See schema and values for given entity:  
`gsettings list-recursively org.gnome.Terminal.Legacy.Settings`
