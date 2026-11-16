# Loaded by non-interactive bash shells through BASH_ENV (set by router-loop.sh): agents that run commands in Git Bash call
# the real pnpm/npm/npx/ng directly, so route them through the wrapper, which holds the machine-wide heavy-run lock.
# Functions are used instead of files on PATH: an extensionless file on PATH makes Windows ask which app should open it.
for _wv_t in pnpm npm npx ng; do
  eval "$_wv_t() { bash \"\$HOME/.wv-bin/wv-wrap.sh\" $_wv_t \"\$@\"; }"
done
unset _wv_t
