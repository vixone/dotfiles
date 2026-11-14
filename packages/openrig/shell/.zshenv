# Seat panes run zsh with ZDOTDIR here. Keep PATH to the seat launchers and system tools only;
# ~/.local/bin is left out because its `pi` points at the operator's unrestricted Pi.
DEVRIG_RIG_PATH="${DEVRIG_RIG_PATH:-$PATH}"
export DEVRIG_RIG_PATH
PATH="$DEVRIG_RIG_PATH"
export PATH
