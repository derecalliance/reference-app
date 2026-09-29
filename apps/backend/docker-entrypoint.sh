#!/bin/sh
# Reconcile the data directory's ownership, then drop to the runtime user.
#
# A fresh named or anonymous volume inherits the image's ownership of
# /var/lib/derec, so that case needs nothing. A *bind-mounted host directory*
# keeps its host ownership, which is usually a different uid — and the symptom
# is a boot that aborts with a permission error naming a path the developer
# just mounted deliberately, which reads like the app rejecting their mount
# rather than like a uid mismatch.
#
# Only possible when the container starts as root. Run with `--user` and this
# step is skipped: the caller has chosen the uid and it is theirs to get right.
set -e

DATA_DIR="${DEREC_DATA_DIR:-/var/lib/derec}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"

    if [ "$(stat -c '%u' "$DATA_DIR")" != "10001" ]; then
        echo "entrypoint: taking ownership of $DATA_DIR for the derec user" >&2
        chown -R derec:derec "$DATA_DIR"
    fi

    # `exec` so the server is PID 1 and receives SIGTERM directly — without it
    # `docker stop` would signal this shell instead, and the graceful shutdown
    # the backend implements would never run.
    exec setpriv --reuid=derec --regid=derec --init-groups "$@"
fi

exec "$@"
