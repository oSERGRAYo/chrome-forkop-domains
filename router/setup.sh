#!/bin/sh
# Forkop Domains — router-side setup.
#
# Creates a dedicated rpcd user with a narrow ACL so the browser extension can
# edit forkop's manual domain lists and apply changes, and nothing else.
#
# Usage (run on the OpenWrt router):
#   sh setup.sh <username> <password>
#
# Then in the extension options set the same <username>/<password> and the
# router URL (e.g. http://192.168.1.1/).

set -e

USER="${1:-forkop-ext}"
PASS="$2"

if [ -z "$PASS" ]; then
	echo "usage: sh setup.sh <username> <password>" >&2
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

echo "==> ACL -> $ACL_DST"
if [ -f "$ACL_SRC" ]; then
	cp "$ACL_SRC" "$ACL_DST"
else
	echo "  acl.d/forkop-domain-mgr.json not found next to this script;" >&2
	echo "  copy it manually to $ACL_DST" >&2
	exit 1
fi

echo "==> rpcd user '$USER'"
if grep -q "option username '$USER'" /etc/config/rpcd 2>/dev/null; then
	echo "  user already present in /etc/config/rpcd — leaving it as is"
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
RESP="$(curl -s "http://127.0.0.1/ubus" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"00000000000000000000000000000000\",\"session\",\"login\",{\"username\":\"$USER\",\"password\":\"$PASS\"}]}")"
case "$RESP" in
	*ubus_rpc_session*) echo "  OK — got a session" ;;
	*) echo "  FAILED: $RESP" >&2; exit 1 ;;
esac

echo
echo "Done. In the extension options use:"
echo "  router URL : http://<router-ip>/"
echo "  user       : $USER"
echo "  password   : (the one you just passed)"
