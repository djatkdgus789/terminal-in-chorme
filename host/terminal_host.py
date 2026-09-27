#!/usr/bin/env python3
"""
Native messaging host for the "Terminal in Chrome" extension.

Chrome starts one of these per connectNative() port. It is a thin bridge:
frames from Chrome (stdin) are forwarded to terminal_daemon.py over a Unix
socket and frames from the daemon are written back to Chrome (stdout). Both
sides use the same framing (4-byte little-endian length + JSON), so bytes are
relayed untouched. The daemon owns the shells, which is what lets a shell
survive its browser tab being closed.

If no daemon is running, one is started (detached from Chrome) first.
"""

import fcntl
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON = os.path.join(HERE, "terminal_daemon.py")
sys.path.insert(0, HERE)
from terminal_daemon import runtime_dir, socket_path  # noqa: E402

STDIN = sys.stdin.fileno()
STDOUT = sys.stdout.fileno()


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        view = view[n:]


def send_to_chrome(message):
    payload = json.dumps(message).encode("utf-8")
    write_all(STDOUT, struct.pack("<I", len(payload)) + payload)


def try_connect(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(path)
        return sock
    except OSError:
        sock.close()
        return None


def start_daemon():
    log_path = os.path.join(runtime_dir(), "daemon.log")
    with open(log_path, "ab") as log:
        subprocess.Popen(
            [sys.executable, DAEMON],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
            close_fds=True, start_new_session=True, cwd=os.path.expanduser("~"))


def connect_daemon():
    path = socket_path()
    sock = try_connect(path)
    if sock is not None:
        return sock
    # Several ports can start at the same time (a page re-attaching many
    # tabs); make sure only one of them launches the daemon.
    lock_path = os.path.join(runtime_dir(), "daemon.lock")
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sock = try_connect(path)
        if sock is None:
            start_daemon()
            deadline = time.time() + 10
            while sock is None and time.time() < deadline:
                time.sleep(0.05)
                sock = try_connect(path)
        fcntl.flock(lock, fcntl.LOCK_UN)
    if sock is None:
        raise RuntimeError("could not start the session daemon; see %s" %
                           os.path.join(runtime_dir(), "daemon.log"))
    return sock


def pump_chrome_to_daemon(sock):
    try:
        while True:
            chunk = os.read(STDIN, 65536)
            if not chunk:
                break
            sock.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def pump_daemon_to_chrome(sock):
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            write_all(STDOUT, chunk)
    except OSError:
        pass


def main():
    try:
        sock = connect_daemon()
    except Exception as exc:
        send_to_chrome({"type": "error", "message": str(exc)})
        return 1
    threading.Thread(target=pump_chrome_to_daemon, args=(sock,), daemon=True).start()
    pump_daemon_to_chrome(sock)
    sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
