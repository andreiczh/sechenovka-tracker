#!/bin/sh
# Run on the hosting account after uploading the verified release archive.
# Usage: sh prepare-alwaysdata.sh ACCOUNT ARCHIVE EXPECTED_SHA256
set -eu
umask 077
task_account=${1:?Specify the alwaysdata account name}
task_archive=${2:?Specify the uploaded archive path}
task_expected=${3:?Specify the expected archive SHA256}
case "$task_account" in ''|*[!a-z0-9-]*) echo 'Invalid account name' >&2; exit 1;; esac
case "$task_expected" in *[!a-f0-9]*|'') echo 'Invalid SHA256' >&2; exit 1;; esac
[ "${#task_expected}" -eq 64 ] || exit 1
[ "$(id -un)" = "$task_account" ] || { echo 'Run as the intended hosting account' >&2; exit 1; }
task_actual=$(sha256sum "$task_archive" | cut -d ' ' -f 1)
[ "$task_actual" = "$task_expected" ] || { echo 'Archive checksum mismatch' >&2; exit 1; }
tar -tzf "$task_archive" | awk '/(^\/|(^|\/)\.\.(\/|$)|(^|\/)(\.data|\.git|node_modules|test-results)(\/|$)|(^|\/)\.env$)/ { bad=1 } END { exit bad }' || { echo 'Unexpected archive member' >&2; exit 1; }
export NODEJS_VERSION=24
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node.js 24 is required"); require("node:sqlite");'
task_base="/home/$task_account/sechenovka"
task_env="$task_base/shared/production.env"
task_release="$task_base/releases/$(date -u +%Y%m%dT%H%M%SZ)-$(printf %.12s "$task_expected")"
mkdir -p "$task_base/releases" "$task_base/shared/data" "$task_release"
tar -xzf "$task_archive" -C "$task_release"
(cd "$task_release" && npm ci --ignore-scripts)
if [ ! -f "$task_env" ]; then
  node --input-type=module - "$task_env" "$task_account" <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const [file, account] = process.argv.slice(2);
const settings = [
  'NODE_ENV=production', 'NODEJS_VERSION=24', 'DEMO_MODE=true',
  `PUBLIC_ORIGIN=https://${account}.alwaysdata.net`,
  `DATA_DIR=/home/${account}/sechenovka/shared/data`,
  'REMINDER_SCHEDULER=off', `CRON_SECRET=${randomBytes(32).toString('hex')}`,
];
writeFileSync(file, settings.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
JS
fi
chmod 600 "$task_env"
if [ -f "$task_base/shared/data/demo.sqlite" ]; then
  node --env-file="$task_env" "$task_release/scripts/backup.mjs"
fi
node --env-file="$task_env" "$task_release/scripts/preflight.mjs"
if [ -e "$task_base/current" ] && [ ! -L "$task_base/current" ]; then
  echo 'Existing current directory is not a symlink; it was left untouched.' >&2
  exit 1
fi
if [ -L "$task_base/current" ]; then
  readlink "$task_base/current" > "$task_base/shared/previous-release.txt"
fi
ln -s "$task_release" "$task_base/current.next.$$"
mv -Tf "$task_base/current.next.$$" "$task_base/current"
printf 'Release prepared: %s\n' "$task_release"
printf 'Website command: node --env-file=%s %s/current/server.mjs\n' "$task_env" "$task_base"
printf 'Website environment: NODEJS_VERSION=24\n'
printf 'Restart the website and run the public health check.\n'
