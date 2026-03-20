#!/bin/bash
set -euo pipefail

# 1. Install Homebrew
if ! command -v brew &>/dev/null; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# 2. Install packages from Brewfile
# Use CHEZMOI_SOURCE_DIR (injected by chezmoi) to avoid lock contention
brew bundle --file="${CHEZMOI_SOURCE_DIR:-$(chezmoi source-path)}/Brewfile"

# 3. Install Oh My Zsh
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
fi

# 4. Install TPM (Tmux Plugin Manager)
if [ ! -d "$HOME/.tmux/plugins/tpm" ]; then
    git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
fi

# 5. Create obsidian directories that chezmoi can't track (empty dirs)
mkdir -p "$HOME/obsidian-notes/daily-notes"
mkdir -p "$HOME/obsidian-notes/nvim"

# 6. Homebrew maintenance (cleanup stale downloads, not installed packages)
brew cleanup
brew doctor || true

echo ""
echo "✅ Bootstrap complete!"
echo "   → Open tmux and press 'prefix + I' to install tmux plugins"
echo "   → Open nvim — LazyVim will auto-install plugins on first launch"
