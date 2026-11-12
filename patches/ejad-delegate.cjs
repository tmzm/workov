// Adds copilot, kilo and antigravity to worker-fleet's delegate-task.sh (command lines from implementers.json).
const fs = require('fs');
const f = '.claude/scripts/delegate-task.sh';
let t = fs.readFileSync(f, 'utf8');
const anchor = `  *)
    echo "ERROR: Unsupported delegation target '$TARGET'. Allowed: codex, opencode" >&2`;
if (!t.includes('copilot|kilo|antigravity)')) {
  if (!t.includes(anchor)) throw new Error('delegate-task.sh anchor missing');
  t = t.replace(anchor, `  copilot|kilo|antigravity)
    # Ejad: command lines come from .claude/scripts/implementers.json ({prompt} is replaced).
    SPEC="$(dirname "$0")/implementers.json"
    PROMPT="$FULL_PROMPT" node -e '
      const spec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (!Array.isArray(spec)) { console.error("no command for " + process.argv[2] + " in implementers.json"); process.exit(1); }
      const args = spec.map((a) => a.split("{prompt}").join(process.env.PROMPT));
      const r = require("child_process").spawnSync(args[0], args.slice(1), { stdio: "inherit" });
      if (r.error) { console.error("ERROR: " + args[0] + " is not installed or not in PATH"); process.exit(127); }
      process.exit(r.status ?? 1);
    ' "$SPEC" "$TARGET"
    ;;

  *)
    echo "ERROR: Unsupported delegation target '$TARGET'. Allowed: codex, opencode, copilot, kilo, antigravity" >&2`);
  fs.writeFileSync(f, t);
}
console.log('delegate-task.sh patched');
