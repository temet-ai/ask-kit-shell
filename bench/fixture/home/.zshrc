# interactive zsh
export PATH="$HOME/bin:$PATH"
export EDITOR=hx
export WATCH_ENV=staging
export WATCH_TOKEN=fake-token-0000
alias gco='git checkout'
alias gs='git status -sb'
alias g=git
alias ll='ls -la'
alias python=python3
mkcd() { mkdir -p "$1" && cd "$1"; }
[ -f ~/.config/watch/extra.zsh ] && source ~/.config/watch/extra.zsh
eval "$(mise activate zsh)"
