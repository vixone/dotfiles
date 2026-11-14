# No user rc files in seat panes.
PATH="$DEVRIG_RIG_PATH"
export PATH

# Operator shells opened in the rig's Herdr (not seat panes, which carry OPENRIG_SESSION_NAME) get the
# rig commands. Inside Herdr, `rig tui` runs the TUI in place so its "Open terminal" stays in Herdr.
if [[ "${HERDR_ENV:-}" == 1 && -z "${OPENRIG_SESSION_NAME:-}" ]]; then
  rig() { "${ZDOTDIR:h}/bin/devrig" rig "$@"; }
  devrig() { "${ZDOTDIR:h}/bin/devrig" "$@"; }
fi
