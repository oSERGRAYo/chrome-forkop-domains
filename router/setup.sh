#!/bin/sh
# Forkop Domains — router-side setup.
#
# Creates a dedicated rpcd user with a narrow ACL so the browser extension can
# edit forkop's manual domain lists and apply changes, and nothing else.
#
# Usage (run on the OpenWrt router):
#   sh setup.sh [username]              # prompts for the password (preferred)
#   sh setup.sh <username> <password>   # deprecated: the password lands in `ps`
#
# Then in the extension options set the same <username>/<password> and the
# router URL (e.g. http://192.168.1.1/).

set -e

USER="${1:-forkop-ext}"
PASS="$2"

if [ -n "$PASS" ]; then
	echo "warning: passing the password as an argument exposes it in 'ps' and shell history." >&2
else
	# Read it interactively instead, with echo off where the shell supports it.
	printf 'Password for rpcd user "%s": ' "$USER" >&2
	if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
		stty -echo 2>/dev/null || true
		trap 'stty echo 2>/dev/null || true' EXIT INT TERM
		read -r PASS
		stty echo 2>/dev/null || true
		trap - EXIT INT TERM
		echo >&2
	else
		read -r PASS
	fi
fi

if [ -z "$PASS" ]; then
	echo "usage: sh setup.sh [username] [password]" >&2
	exit 1
fi

ACL_SRC="$(dirname "$0")/acl.d/forkop-domain-mgr.json"
ACL_DST="/usr/share/rpcd/acl.d/forkop-domain-mgr.json"

echo "==> packages"
if command -v apk >/dev/null 2>&1; then
	apk add uhttpd-mod-ubus rpcd rpcd-mod-file
else
	opkg update
	opkg install uhttpd-mod-ubus rpcd rpcd-mod-file
fi
# rpcd-mod-file is only needed for the optional "Команда применения" escape
# hatch (file.exec /etc/init.d/forkop). The default commit-only path uses uci.

echo "==> ACL -> $ACL_DST"
if [ -f "$ACL_SRC" ]; then
	cp "$ACL_SRC" "$ACL_DST"
else
	echo "  acl.d/forkop-domain-mgr.json not found next to this script;" >&2
	echo "  copy it manually to $ACL_DST" >&2
	exit 1
fi

echo "==> rpcd user '$USER'"
USER_EXISTED=0
if grep -q "option username '$USER'" /etc/config/rpcd 2>/dev/null; then
	USER_EXISTED=1
	echo "  user already present in /etc/config/rpcd — leaving its password as is"
	echo "  (if you meant to change it, edit /etc/config/rpcd by hand)"
else
	HASH="$(uhttpd -m "$PASS")"
	cat >> /etc/config/rpcd <<EOF

config login
	option username '$USER'
	option password '$HASH'
	list read 'forkop-domain-mgr'
	list write 'forkop-domain-mgr'
EOF
fi

echo "==> restart rpcd"
/etc/init.d/rpcd restart

echo "==> verify login"
# Build the JSON payload in a file rather than inlining the password into a
# shell-quoted string: a password containing " or \ would otherwise produce
# invalid JSON. 077 + trap keeps it off other users' eyes and out of the way.
ESCAPED=$(printf '%s' "$PASS" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
OLDMASK=$(umask)
umask 077
REQ="/tmp/forkop-setup-$$.json"
trap 'rm -f "$REQ"' EXIT INT TERM
cat > "$REQ" <<EOF
{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"$USER","password":"$ESCAPED"}]}
EOF
umask "$OLDMASK"

RESP="$(curl -s "http://127.0.0.1/ubus" -H 'Content-Type: application/json' -d @"$REQ")"
rm -f "$REQ"
trap - EXIT INT TERM

case "$RESP" in
	*ubus_rpc_session*) echo "  OK — got a session" ;;
	*)
		echo "  FAILED: $RESP" >&2
		[ "$USER_EXISTED" = 1 ] && echo "  (the user already existed — the stored password is probably not the one you just entered)" >&2
		exit 1
		;;
esac

echo
echo "Done. In the extension options use:"
echo "  router URL : http://<router-ip>/"
echo "  user       : $USER"
echo "  password   : (the one you just entered)"
