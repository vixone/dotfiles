# dotfiles

Managed with [chezmoi](https://chezmoi.io).

## New Machine Setup

```bash
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply vixone
```

After bootstrap:
- Open tmux → press `prefix + I` to install plugins
- Open nvim → LazyVim auto-installs on first launch
- Set up `~/.gitconfig` manually (name/email per machine)
