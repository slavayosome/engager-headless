export type SkillInstallClient = "claude" | "codex";
export type SkillInstallFile = {
  path: string;
  sha256: string;
  bytes: number;
};
export type SkillInstallSpec = {
  name: string;
  /** Omit to fetch the deployment-generated checksum manifest over HTTPS. */
  files?: readonly SkillInstallFile[];
};

/**
 * The shell mirror of this rule is `safe_skill_name`, and it spells the class
 * out — `[!abcdefghijklmnopqrstuvwxyz0123456789-]` — rather than the shorter
 * `[!a-z0-9-]` or `[![:lower:][:digit:]-]`. Both of those resolve in the
 * ambient locale and neither resolves to this regex: a UTF-8 bash accepts
 * `engager-Retired` and `engager-ß` through the range, and `engager-тест`
 * through the classes. This regex is ASCII by construction, so no release can
 * have served a name it rejects; and because the predicate decides what an
 * install prunes, every name it accepts beyond this regex is a directory the
 * owner made themselves, moved into the transaction's backups and destroyed
 * with the transaction at commit. Written out, the two agree character for
 * character in every locale — the `-*`, `*-` and `*--*` arms beside it carry
 * the leading, trailing and repeated hyphens this regex's shape forbids.
 */
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_FILE_PATH = /^[A-Za-z0-9._/-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "skill installer base URL must be an HTTP(S) URL without credentials or query state",
    );
  }
  return value.replace(/\/+$/, "");
}

function safeManifestPath(value: string): boolean {
  return (
    SAFE_FILE_PATH.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function manifestSetup(skills: readonly SkillInstallSpec[]): string {
  return skills
    .map((skill, index) => {
      const destination = `"$INSTALL_TMP/manifests/${skill.name}.sha256"`;
      if (!skill.files) {
        return `curl -fsSL "$BASE/${skill.name}/manifest.sha256" -o ${destination}`;
      }
      const delimiter = `ENGAGER_MANIFEST_${index}_${skill.name.replaceAll("-", "_")}`;
      const lines = skill.files
        .map((file) => `${file.sha256} ${file.bytes} ${file.path}`)
        .join("\n");
      return `cat > ${destination} <<'${delimiter}'\n${lines}\n${delimiter}`;
    })
    .join("\n");
}

/**
 * Render the copy-paste shell contract used by the dashboard's HTTPS fallback.
 *
 * Every file is downloaded into a durable, same-filesystem transaction first.
 * The installed skill is then replaced with directory renames whose journal and
 * parent directories are fsynced in order. A later process recovers stale work,
 * including when the original process or its recovery process was killed. A
 * failed request, crash, or power loss therefore cannot report success or
 * silently leave a mixed-version skill set behind.
 *
 * Retired directories participate in the transaction. For a journalled
 * install, edited and unowned files are retained; an unjournalled retired
 * directory belongs to the previous Engager install.
 *
 * The prune is best-effort where the swap is not. A `$SKILLS` rename that fails
 * takes the install down, because a release lands whole or not at all. A prune
 * rename that fails names the directory on stderr and carries on: a retired
 * tree the owner has made unmovable — read-only is enough, since POSIX
 * `rename()` wants write permission on the directory it renames — sits outside
 * the set this install delivers and must not be able to block it.
 *
 * That journal is why the transaction schema is `2`. A pre-prune script
 * recovering a prune-bearing transaction would restore the swapped entries and
 * then delete the transaction directory with a pruned skill still in its
 * backups — a silent delete of an installed skill — so it must refuse the
 * schema it cannot read. Recovery here accepts either: a schema-1 journal
 * simply has nothing pruned.
 */
export function renderSkillInstallShell(input: {
  baseUrl: string;
  client: SkillInstallClient;
  skills: readonly SkillInstallSpec[];
  /**
   * Let a first positional argument override the baked-in client, so ONE hosted
   * script serves every client:
   *   curl -fsSL <origin>/skills/install.sh | sh -s -- codex
   * Off by default: the dashboard's copy-paste block and the scout README render
   * a client-specific script, and their bytes are pinned by tests.
   */
  clientOverridable?: boolean;
}): string {
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  if (input.skills.length === 0) {
    throw new Error("skill installer requires at least one skill");
  }
  for (const skill of input.skills) {
    if (!SAFE_SKILL_NAME.test(skill.name)) {
      throw new Error(`unsafe skill name: ${skill.name}`);
    }
    if (skill.files) {
      if (skill.files.length === 0) {
        throw new Error(`embedded manifest is empty: ${skill.name}`);
      }
      const paths = new Set<string>();
      for (const file of skill.files) {
        if (!safeManifestPath(file.path)) {
          throw new Error(`unsafe embedded manifest path: ${file.path}`);
        }
        if (!SHA256.test(file.sha256)) {
          throw new Error(
            `invalid embedded sha256 for ${skill.name}/${file.path}`,
          );
        }
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
          throw new Error(
            `invalid embedded byte count for ${skill.name}/${file.path}`,
          );
        }
        if (paths.has(file.path)) {
          throw new Error(`duplicate embedded manifest path: ${file.path}`);
        }
        paths.add(file.path);
      }
      if (!paths.has("SKILL.md")) {
        throw new Error(`embedded manifest omits SKILL.md: ${skill.name}`);
      }
    }
  }
  const names = input.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error("skill installer cannot install duplicate skill names");
  }
  const manifests = manifestSetup(input.skills);
  // `$#` is checked before `$1` is read, so this stays safe under `set -eu`.
  // The value is never expanded into a path — the case below maps only the two
  // known literals to a SKILL_ROOT and exits on anything else.
  const clientOverride = input.clientOverridable
    ? `\nif [ "$#" -gt 0 ]; then CLIENT="$1"; fi`
    : "";

  return `set -eu

BASE=${shellQuote(baseUrl)}
CLIENT=${shellQuote(input.client)}${clientOverride}
SKILLS=${shellQuote(names.join(" "))}

case "$CLIENT" in
  claude) SKILL_ROOT="$HOME/.claude/skills" ;;
  codex) SKILL_ROOT="$HOME/.agents/skills" ;;
  *) echo "Unsupported skill client: $CLIENT" >&2; exit 1 ;;
esac

LOCK_LINK="$SKILL_ROOT/.engager-install.lock"
OWNED_TX=""

fsync_dir() {
  node -e 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$1"
}

durable_mkdir() {
  node -e 'const fs=require("node:fs");const path=require("node:path");const target=path.resolve(process.argv[1]);const first=fs.mkdirSync(target,{recursive:true,mode:0o700});function flush(p){const fd=fs.openSync(p,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}flush(target);if(first!==undefined){const boundary=path.resolve(first);let current=target;for(;;){const parent=path.dirname(current);flush(parent);if(current===boundary)break;if(parent===current)throw new Error("created-directory boundary not reached");current=parent}}' "$1"
}

fsync_file() {
  node -e 'const fs=require("node:fs");const path=require("node:path");const p=process.argv[1];let fd=fs.openSync(p,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fd=fs.openSync(path.dirname(p),"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$1"
}

durable_write() {
  node -e 'const fs=require("node:fs");const path=require("node:path");const p=process.argv[1];fs.writeFileSync(p,process.argv[2],{mode:0o600});let fd=fs.openSync(p,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fd=fs.openSync(path.dirname(p),"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$1" "$2"
}

durable_append_line() {
  node -e 'const fs=require("node:fs");const path=require("node:path");const p=process.argv[1];const fd=fs.openSync(p,"a",0o600);try{fs.writeSync(fd,process.argv[2]+"\\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}const parent=fs.openSync(path.dirname(p),"r");try{fs.fsyncSync(parent)}finally{fs.closeSync(parent)}' "$1" "$2"
}

durable_tree() {
  node -e 'const fs=require("node:fs");const path=require("node:path");function flush(p){const fd=fs.openSync(p,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}function sync(p){const s=fs.lstatSync(p);if(s.isSymbolicLink())throw new Error("symlink in staged skill: "+p);if(s.isDirectory()){for(const n of fs.readdirSync(p))sync(path.join(p,n));flush(p);return}if(!s.isFile())throw new Error("unsupported staged entry: "+p);flush(p)}sync(process.argv[1]);flush(path.dirname(process.argv[1]))' "$1"
}

atomic_commit() {
  node -e 'const fs=require("node:fs");const path=require("node:path");const dir=process.argv[1];function sync(p){const fd=fs.openSync(p,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}function marker(name){const tmp=path.join(dir,name+".tmp");fs.writeFileSync(tmp,"v1",{mode:0o600});sync(tmp);sync(dir);fs.renameSync(tmp,path.join(dir,name));sync(dir)}marker("COMMITTED");marker("COMMIT_PROVEN")' "$1"
}

durable_mkdir "$SKILL_ROOT"

safe_skill_name() {
  case "$1" in
    ""|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*|-*|*-|*--*) return 1 ;;
    *) return 0 ;;
  esac
}

safe_tx_target() {
  case "$1" in
    .engager-install.tx.*)
      suffix="\${1#.engager-install.tx.}"
      case "$suffix" in
        ""|*[!A-Za-z0-9._-]*|*/*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

load_transaction() {
  target="$1"
  if ! safe_tx_target "$target"; then
    echo "Unsafe Engager installer transaction target" >&2
    return 1
  fi
  tx="$SKILL_ROOT/$target"
  if [ ! -d "$tx" ] || [ -L "$tx" ]; then
    echo "Invalid Engager installer transaction directory" >&2
    return 1
  fi
  for required in schema pid skills swapped; do
    if [ ! -f "$tx/$required" ] || [ -L "$tx/$required" ]; then
      echo "Incomplete Engager installer transaction: $required" >&2
      return 1
    fi
  done
  for required_dir in states backups staged manifests; do
    if [ ! -d "$tx/$required_dir" ] || [ -L "$tx/$required_dir" ]; then
      echo "Incomplete Engager installer transaction directory: $required_dir" >&2
      return 1
    fi
  done
  tx_schema="$(cat "$tx/schema")"
  case "$tx_schema" in
    1) ;;
    2)
      if [ ! -f "$tx/pruned" ] || [ -L "$tx/pruned" ]; then
        echo "Incomplete Engager installer transaction: pruned" >&2
        return 1
      fi
      ;;
    *)
      echo "Unsupported Engager installer transaction schema" >&2
      return 1
      ;;
  esac
  tx_pid="$(cat "$tx/pid")"
  case "$tx_pid" in
    ""|*[!0-9]*) echo "Invalid Engager installer owner PID" >&2; return 1 ;;
  esac

  tx_skills=""
  tx_skill_set=" "
  tx_skill_count=0
  skill=""
  while IFS= read -r skill || [ -n "$skill" ]; do
    if ! safe_skill_name "$skill"; then
      echo "Unsafe skill name in Engager installer transaction" >&2
      return 1
    fi
    case "$tx_skill_set" in
      *" $skill "*) echo "Duplicate skill in Engager installer transaction" >&2; return 1 ;;
    esac
    tx_skills="$tx_skills $skill"
    tx_skill_set="$tx_skill_set$skill "
    tx_skill_count=$((tx_skill_count + 1))
  done < "$tx/skills"
  if [ "$tx_skill_count" -eq 0 ]; then
    echo "Empty Engager installer transaction" >&2
    return 1
  fi

  tx_swapped_reverse=""
  tx_swapped_set=" "
  tx_swapped_count=0
  skill=""
  while IFS= read -r skill || [ -n "$skill" ]; do
    if ! safe_skill_name "$skill"; then
      echo "Unsafe swapped skill in Engager installer transaction" >&2
      return 1
    fi
    case "$tx_skill_set" in
      *" $skill "*) ;;
      *) echo "Unknown swapped skill in Engager installer transaction" >&2; return 1 ;;
    esac
    case "$tx_swapped_set" in
      *" $skill "*) echo "Duplicate swapped skill in Engager installer transaction" >&2; return 1 ;;
    esac
    present="$tx/states/$skill.present"
    absent="$tx/states/$skill.absent"
    if [ -L "$present" ] || [ -L "$absent" ]; then
      echo "Unsafe state marker in Engager installer transaction" >&2
      return 1
    fi
    state_count=0
    [ -f "$present" ] && state_count=$((state_count + 1))
    [ -f "$absent" ] && state_count=$((state_count + 1))
    if [ "$state_count" -ne 1 ]; then
      echo "Ambiguous state marker in Engager installer transaction" >&2
      return 1
    fi
    tx_swapped_reverse="$skill $tx_swapped_reverse"
    tx_swapped_set="$tx_swapped_set$skill "
    tx_swapped_count=$((tx_swapped_count + 1))
  done < "$tx/swapped"

  tx_pruned_reverse=""
  tx_pruned_set=" "
  skill=""
  if [ "$tx_schema" = "2" ]; then
    while IFS= read -r skill || [ -n "$skill" ]; do
      if ! safe_skill_name "$skill"; then
        echo "Unsafe pruned skill in Engager installer transaction" >&2
        return 1
      fi
      case "$tx_skill_set" in
        *" $skill "*) echo "Installed skill recorded as pruned in Engager installer transaction" >&2; return 1 ;;
      esac
      case "$tx_pruned_set" in
        *" $skill "*) echo "Duplicate pruned skill in Engager installer transaction" >&2; return 1 ;;
      esac
      tx_pruned_reverse="$skill $tx_pruned_reverse"
      tx_pruned_set="$tx_pruned_set$skill "
    done < "$tx/pruned"
  fi

  tx_committed=0
  has_committed=0
  has_commit_proof=0
  if [ -e "$tx/COMMITTED" ] || [ -L "$tx/COMMITTED" ]; then
    if [ ! -f "$tx/COMMITTED" ] || [ -L "$tx/COMMITTED" ] || [ "$(cat "$tx/COMMITTED")" != "v1" ]; then
      echo "Invalid committed marker in Engager installer transaction" >&2
      return 1
    fi
    has_committed=1
  fi
  if [ -e "$tx/COMMIT_PROVEN" ] || [ -L "$tx/COMMIT_PROVEN" ]; then
    if [ ! -f "$tx/COMMIT_PROVEN" ] || [ -L "$tx/COMMIT_PROVEN" ] || [ "$(cat "$tx/COMMIT_PROVEN")" != "v1" ]; then
      echo "Invalid commit proof in Engager installer transaction" >&2
      return 1
    fi
    has_commit_proof=1
  fi
  if [ "$has_commit_proof" -eq 1 ] && [ "$has_committed" -ne 1 ]; then
    echo "Commit proof is missing its Engager installer marker" >&2
    return 1
  fi
  if [ "$has_committed" -eq 1 ] && [ "$has_commit_proof" -eq 1 ]; then
    if [ "$tx_swapped_count" -ne "$tx_skill_count" ]; then
      echo "Committed Engager installer transaction is incomplete" >&2
      return 1
    fi
    for skill in $tx_skills; do
      if [ ! -d "$SKILL_ROOT/$skill" ] || [ -L "$SKILL_ROOT/$skill" ]; then
        echo "Committed Engager installer destination is incomplete: $skill" >&2
        return 1
      fi
    done
    tx_committed=1
  fi

  TX_TARGET="$target"
  TX_DIR="$tx"
  TX_PID="$tx_pid"
  TX_SKILLS="$tx_skills"
  TX_SWAPPED_REVERSE="$tx_swapped_reverse"
  TX_PRUNED_REVERSE="$tx_pruned_reverse"
  TX_COMMITTED="$tx_committed"
}

release_loaded_transaction() {
  if [ ! -L "$LOCK_LINK" ] || [ "$(readlink "$LOCK_LINK")" != "$TX_TARGET" ]; then
    echo "Engager installer lock changed during recovery" >&2
    return 1
  fi
  rm -f -- "$LOCK_LINK" || return 1
  if ! fsync_dir "$SKILL_ROOT"; then
    ln -s "$TX_TARGET" "$LOCK_LINK" || return 1
    fsync_dir "$SKILL_ROOT" || return 1
    return 1
  fi
  if ! rm -rf -- "$TX_DIR"; then
    ln -s "$TX_TARGET" "$LOCK_LINK" || return 1
    fsync_dir "$SKILL_ROOT" || return 1
    return 1
  fi
  fsync_dir "$SKILL_ROOT" || return 1
}

recover_loaded_transaction() {
  if [ "$TX_COMMITTED" -eq 1 ]; then
    :
  else
    for skill in $TX_SWAPPED_REVERSE; do
      dest="$SKILL_ROOT/$skill"
      backup="$TX_DIR/backups/$skill"
      present="$TX_DIR/states/$skill.present"
      absent="$TX_DIR/states/$skill.absent"
      if { [ -e "$dest" ] || [ -L "$dest" ]; } && { [ ! -d "$dest" ] || [ -L "$dest" ]; }; then
        echo "Unsafe Engager skill destination during recovery: $skill" >&2
        return 1
      fi
      if [ -e "$backup" ] || [ -L "$backup" ]; then
        if [ ! -d "$backup" ] || [ -L "$backup" ]; then
          echo "Unsafe Engager skill backup during recovery: $skill" >&2
          return 1
        fi
        if [ -f "$absent" ]; then
          echo "Unexpected backup for newly installed Engager skill: $skill" >&2
          return 1
        fi
      elif [ -f "$present" ] && [ ! -d "$dest" ]; then
        echo "Missing original Engager skill during recovery: $skill" >&2
        return 1
      fi
    done
    for skill in $TX_PRUNED_REVERSE; do
      dest="$SKILL_ROOT/$skill"
      backup="$TX_DIR/backups/$skill"
      if { [ -e "$dest" ] || [ -L "$dest" ]; } && { [ ! -d "$dest" ] || [ -L "$dest" ]; }; then
        echo "Unsafe Engager skill destination during recovery: $skill" >&2
        return 1
      fi
      if { [ -e "$backup" ] || [ -L "$backup" ]; } && { [ ! -d "$backup" ] || [ -L "$backup" ]; }; then
        echo "Unsafe Engager skill backup during recovery: $skill" >&2
        return 1
      fi
    done
    for skill in $TX_PRUNED_REVERSE; do
      dest="$SKILL_ROOT/$skill"
      backup="$TX_DIR/backups/$skill"
      if [ -e "$backup" ] || [ -L "$backup" ]; then
        rm -rf -- "$dest" || return 1
        fsync_dir "$SKILL_ROOT" || return 1
        mv -- "$backup" "$dest" || return 1
        fsync_dir "$TX_DIR/backups" || return 1
        fsync_dir "$SKILL_ROOT" || return 1
      fi
    done
    for skill in $TX_SWAPPED_REVERSE; do
      dest="$SKILL_ROOT/$skill"
      backup="$TX_DIR/backups/$skill"
      if [ -e "$backup" ] || [ -L "$backup" ]; then
        rm -rf -- "$dest" || return 1
        fsync_dir "$SKILL_ROOT" || return 1
        mv -- "$backup" "$dest" || return 1
        fsync_dir "$TX_DIR/backups" || return 1
        fsync_dir "$SKILL_ROOT" || return 1
      elif [ -f "$TX_DIR/states/$skill.absent" ]; then
        rm -rf -- "$dest" || return 1
        fsync_dir "$SKILL_ROOT" || return 1
      else
        fsync_dir "$SKILL_ROOT" || return 1
      fi
    done
  fi
  release_loaded_transaction || return 1
}

safe_recovery_target() {
  case "$1" in
    .recovery.claim.*)
      suffix="\${1#.recovery.claim.}"
      case "$suffix" in
        ""|*[!A-Za-z0-9._-]*|*/*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

claim_recovery() {
  recovery_link="$TX_DIR/recovery.lock"
  while :; do
    if [ -e "$recovery_link" ] || [ -L "$recovery_link" ]; then
      if [ ! -L "$recovery_link" ]; then
        echo "Engager recovery lock is not a safe symlink" >&2
        return 1
      fi
      claim_target="$(readlink "$recovery_link")"
      if ! safe_recovery_target "$claim_target"; then
        echo "Unsafe Engager recovery lock target" >&2
        return 1
      fi
      claim_dir="$TX_DIR/$claim_target"
      if [ ! -d "$claim_dir" ] || [ -L "$claim_dir" ] || [ ! -f "$claim_dir/pid" ] || [ -L "$claim_dir/pid" ]; then
        echo "Invalid Engager recovery lock" >&2
        return 1
      fi
      claim_pid="$(cat "$claim_dir/pid")"
      case "$claim_pid" in
        ""|*[!0-9]*) echo "Invalid Engager recovery owner PID" >&2; return 1 ;;
      esac
      if kill -0 "$claim_pid" 2>/dev/null; then
        echo "Another process is already recovering the Engager skill install (pid $claim_pid)" >&2
        return 1
      fi
      stale_link="$(mktemp -d "$TX_DIR/.recovery.stale.XXXXXX")" || return 1
      rmdir "$stale_link" || return 1
      if mv -- "$recovery_link" "$stale_link" 2>/dev/null; then
        fsync_dir "$TX_DIR" || return 1
        rm -f -- "$stale_link" || return 1
        rm -rf -- "$claim_dir" || return 1
        fsync_dir "$TX_DIR" || return 1
      fi
      continue
    fi

    claim_dir="$(mktemp -d "$TX_DIR/.recovery.claim.XXXXXX")" || return 1
    claim_target="$(basename "$claim_dir")"
    safe_recovery_target "$claim_target" || { echo "Unsafe generated recovery target" >&2; return 1; }
    durable_write "$claim_dir/pid" "$$" || return 1
    fsync_dir "$TX_DIR" || return 1
    if ln -s "$claim_target" "$recovery_link" 2>/dev/null; then
      fsync_dir "$TX_DIR" || return 1
      RECOVERY_CLAIM="$claim_target"
      return 0
    fi
    rm -rf -- "$claim_dir" || return 1
    fsync_dir "$TX_DIR" || return 1
  done
}

recover_existing_lock() {
  if [ ! -L "$LOCK_LINK" ]; then
    echo "Engager installer lock is not a safe symlink; remove it only after inspection" >&2
    return 1
  fi
  target="$(readlink "$LOCK_LINK")"
  load_transaction "$target" || return 1
  if kill -0 "$TX_PID" 2>/dev/null; then
    echo "Another Engager skill install is still running (pid $TX_PID)" >&2
    return 1
  fi
  claim_recovery || return 1
  recover_loaded_transaction || return 1
}

finish_owned_transaction() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ -n "$OWNED_TX" ]; then
    if load_transaction "$OWNED_TX"; then
      recover_loaded_transaction || status=1
    else
      echo "Engager installer transaction requires manual inspection: $OWNED_TX" >&2
      status=1
    fi
  fi
  exit "$status"
}

if [ -e "$LOCK_LINK" ] || [ -L "$LOCK_LINK" ]; then
  recover_existing_lock || exit 1
fi

TX_DIR="$(mktemp -d "$SKILL_ROOT/.engager-install.tx.XXXXXX")"
TX_TARGET="$(basename "$TX_DIR")"
safe_tx_target "$TX_TARGET" || { echo "Unsafe generated installer transaction" >&2; exit 1; }
fsync_dir "$SKILL_ROOT"
mkdir -p \\
  "$TX_DIR/manifests" \\
  "$TX_DIR/staged" \\
  "$TX_DIR/backups" \\
  "$TX_DIR/states"
fsync_dir "$TX_DIR/manifests"
fsync_dir "$TX_DIR/staged"
fsync_dir "$TX_DIR/backups"
fsync_dir "$TX_DIR/states"
fsync_dir "$TX_DIR"
durable_write "$TX_DIR/schema" "2"
durable_write "$TX_DIR/pid" "$$"
durable_write "$TX_DIR/skills" ""
SKILL_SET=" "
preserve_edits() {
  node - "$1" "$2" "\${ENGAGER_HOME:-$HOME/.engager}/client-$CLIENT.json" "$3" "$4" <<'ENGAGER_EDITS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [root, staged, journal, name, kind] = process.argv.slice(2);
let rows;
try { rows = JSON.parse(fs.readFileSync(journal, 'utf8')).files; }
catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
if (!rows || typeof rows !== 'object') throw Error('invalid skill journal');
if (!Object.keys(rows).some(key => key.startsWith(name + '/'))) process.exit(0);
function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file, rel); continue; }
    if (!entry.isFile()) throw Error('unsupported entry in journalled skill: ' + file);
    const current = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const row = rows[name + '/' + rel];
    if (current === row?.installed || current === row?.pending) continue;
    const dest = path.join(staged, rel);
    if (kind === 'served' && !row) continue;
    if (fs.existsSync(dest) && crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === current) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    console.error('Kept your edit: ' + name + '/' + rel);
  }
}
walk(root, '');
ENGAGER_EDITS
}

for skill in $SKILLS; do
  safe_skill_name "$skill" || { echo "Unsafe generated skill name" >&2; rm -rf -- "$TX_DIR"; exit 1; }
  SKILL_SET="$SKILL_SET$skill "
  durable_append_line "$TX_DIR/skills" "$skill"
done
durable_write "$TX_DIR/swapped" ""
durable_write "$TX_DIR/pruned" ""

if ! ln -s "$TX_TARGET" "$LOCK_LINK" 2>/dev/null; then
  rm -rf -- "$TX_DIR"
  echo "Another Engager skill install acquired the lock" >&2
  exit 1
fi
fsync_dir "$SKILL_ROOT"
OWNED_TX="$TX_TARGET"
trap finish_owned_transaction EXIT
trap 'exit 1' HUP INT TERM
INSTALL_TMP="$TX_DIR"

${manifests}

for skill in $SKILLS; do
  manifest="$INSTALL_TMP/manifests/$skill.sha256"
  validated="$INSTALL_TMP/manifests/$skill.validated.txt"
  staged="$INSTALL_TMP/staged/$skill"
  mkdir -p "$staged"
  : > "$validated"

  file_count=0
  has_skill_md=0
  expected_sha=""
  expected_bytes=""
  f=""
  extra=""
  while IFS=' ' read -r expected_sha expected_bytes f extra || [ -n "$expected_sha$expected_bytes$f$extra" ]; do
    case "$expected_sha" in
      ""|*[!0-9a-f]*)
        echo "Invalid sha256 in manifest for $skill" >&2
        exit 1
        ;;
    esac
    if [ "\${#expected_sha}" -ne 64 ]; then
      echo "Invalid sha256 in manifest for $skill" >&2
      exit 1
    fi
    case "$expected_bytes" in
      ""|*[!0-9]*)
        echo "Invalid byte count in manifest for $skill/$f" >&2
        exit 1
        ;;
    esac
    if [ -n "$extra" ]; then
      echo "Invalid manifest entry for $skill/$f" >&2
      exit 1
    fi
    case "$f" in
      ""|/*|*[!A-Za-z0-9._/-]*)
        echo "Unsafe skill manifest path for $skill: $f" >&2
        exit 1
        ;;
    esac
    case "/$f/" in
      *"/../"*|*"/./"*|*"//"*)
        echo "Unsafe skill manifest path for $skill: $f" >&2
        exit 1
        ;;
    esac
    if grep -Fqx "$f" "$validated"; then
      echo "Duplicate skill manifest path for $skill: $f" >&2
      exit 1
    fi
    printf '%s\\n' "$f" >> "$validated"

    target="$staged/$f"
    mkdir -p "$(dirname "$target")"
    curl -fsSL "$BASE/$skill/$f" -o "$target"
    actual="$(node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const b=fs.readFileSync(process.argv[1]);process.stdout.write(crypto.createHash("sha256").update(b).digest("hex")+" "+b.length)' "$target")"
    actual_sha="\${actual%% *}"
    actual_bytes="\${actual#* }"
    if [ "$actual_sha" != "$expected_sha" ] || [ "$actual_bytes" != "$expected_bytes" ]; then
      echo "Checksum mismatch for $skill/$f" >&2
      exit 1
    fi
    fsync_file "$target"
    file_count=$((file_count + 1))
    if [ "$f" = "SKILL.md" ]; then has_skill_md=1; fi
  done < "$manifest"

  if [ "$file_count" -eq 0 ] || [ "$has_skill_md" -ne 1 ]; then
    echo "Incomplete skill manifest for $skill" >&2
    exit 1
  fi
  durable_tree "$staged"
done

for skill in $SKILLS; do
  dest="$SKILL_ROOT/$skill"
  backup="$INSTALL_TMP/backups/$skill"
  staged="$INSTALL_TMP/staged/$skill"
  if { [ -e "$dest" ] || [ -L "$dest" ]; } && { [ ! -d "$dest" ] || [ -L "$dest" ]; }; then
    echo "Unsafe existing Engager skill destination: $skill" >&2
    exit 1
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    preserve_edits "$dest" "$staged" "$skill" served
    durable_tree "$staged"
    durable_write "$TX_DIR/states/$skill.present" ""
  else
    durable_write "$TX_DIR/states/$skill.absent" ""
  fi
  durable_append_line "$TX_DIR/swapped" "$skill"
  if [ -e "$TX_DIR/states/$skill.present" ]; then
    mv -- "$dest" "$backup"
    fsync_dir "$SKILL_ROOT"
    fsync_dir "$TX_DIR/backups"
  fi
  mv -- "$staged" "$dest"
  fsync_dir "$TX_DIR/staged"
  fsync_dir "$SKILL_ROOT"
done

PRUNED=""
for name in engager-scout engager-commenter engager-strategy engager-channel engager-brain engager-voice engager-ambassador; do
  entry="$SKILL_ROOT/$name"
  { [ -d "$entry" ] && [ ! -L "$entry" ]; } || continue
  case "$SKILL_SET" in
    *" $name "*) continue ;;
  esac
  staged="$TX_DIR/staged/$name"
  preserve_edits "$entry" "$staged" "$name" retired
  if [ -d "$staged" ]; then durable_tree "$staged"; fi
  durable_append_line "$TX_DIR/pruned" "$name"
  if ! mv -- "$entry" "$TX_DIR/backups/$name"; then
    echo "Left a retired Engager skill in place: $name" >&2
    continue
  fi
  fsync_dir "$SKILL_ROOT"
  fsync_dir "$TX_DIR/backups"
  if [ -d "$staged" ]; then
    mv -- "$staged" "$entry"
    fsync_dir "$TX_DIR/staged"
    fsync_dir "$SKILL_ROOT"
  fi
  PRUNED="$PRUNED $name"
done

atomic_commit "$TX_DIR"
node - "\${ENGAGER_HOME:-$HOME/.engager}/client-$CLIENT.json" "$CLIENT" "$SKILL_ROOT" "$TX_DIR/manifests" $SKILLS <<'ENGAGER_RECORD'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [file, client, root, manifests, ...skills] = process.argv.slice(2);
let journal = { version: 1, client, files: {}, config: null };
try {
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('symlinked skill journal');
  journal = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (journal.version !== 1 || journal.client !== client || !journal.files) throw Error('invalid skill journal');
for (const skill of skills) {
  for (const line of fs.readFileSync(path.join(manifests, skill + '.sha256'), 'utf8').trim().split('\\n')) {
    const match = /^(\\S+)\\s+\\d+\\s+(.+)$/.exec(line);
    if (!match) throw Error('invalid skill manifest');
    const [, expected, relative] = match, dest = path.join(root, skill, relative);
    if (fs.existsSync(dest) && fs.lstatSync(dest).isFile() && crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === expected)
      journal.files[skill + '/' + relative] = { installed: expected };
  }
}
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temp = file + '.' + crypto.randomUUID() + '.tmp';
const fd = fs.openSync(temp, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(journal, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temp, file);
const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
ENGAGER_RECORD
printf 'Installed %s\\n' "$SKILLS"
if [ -n "$PRUNED" ]; then
  printf 'Retired %s\\n' "\${PRUNED# }"
fi`;
}
