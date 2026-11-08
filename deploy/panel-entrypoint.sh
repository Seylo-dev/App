#!/bin/sh
# Entrypoint of the panel image. deploy/panel.Dockerfile fills in the
# placeholders (a name between two @@) at build time.
#
# The panel runs as the panel user, uid/gid @@PANEL_UID@@, which no login
# user has (go/internal/docker PanelUID). Agents from 0.2.0-rc.2 on give
# the panel's data folder to that user and start the container with
# --user @@PANEL_UID@@:@@PANEL_UID@@; then this only runs the command.
#
# Started as root (by an older agent, which knows nothing of the panel
# user, or by hand: docker run ... bun apps/panel/dist/rotate-master-key.js)
# it runs the command as the owner of the data folder instead, never as
# root: the panel user once an agent moved the folder to it, uid 1000 while
# an older agent still runs the panel that way (so that agent's rollback to
# an older image keeps working on the same folder), and a folder root owns
# (new, or copied in by root) is given to the panel user first.
set -eu

panel_uid=@@PANEL_UID@@
data=${@@ENV_PREFIX@@_DATA_DIR:-@@DATA_DIR@@/panel}

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi
mkdir -p "$data"
uid=$(stat -c %u "$data")
gid=$(stat -c %g "$data")
if [ "$uid" = 0 ]; then
	chown -hR "$panel_uid:$panel_uid" "$data"
	uid=$panel_uid
	gid=$panel_uid
fi
[ "$gid" != 0 ] || gid=$uid
# Only root and the folder's owner: master.key and panel.db live here.
chmod 0700 "$data"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
