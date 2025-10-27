#!/bin/bash

# Profile IDs
DEFAULT_PROFILE_ID=$(gsettings get org.gnome.Terminal.ProfilesList default | tr -d "'")

# Get current system color-scheme
THEME=$(gsettings get org.gnome.desktop.interface color-scheme)

set_profile_setting () {
  # $1 Default profile ID
  # $2 key to change value for
  # $3 Value itself
  gsettings set org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:$1/ $2 $3 
}

FOREGROUND_COLOR='rgb(46,52,54)'
BACKGROUND_COLOR='rgb(238,238,236)'

if [ "$THEME" = "'prefer-dark'" ]; then
  FOREGROUND_COLOR='rgb(211,215,207)'
  BACKGROUND_COLOR='rgb(46,52,54)'
fi

set_profile_setting $DEFAULT_PROFILE_ID 'foreground-color' $FOREGROUND_COLOR
set_profile_setting $DEFAULT_PROFILE_ID 'background-color' $BACKGROUND_COLOR
