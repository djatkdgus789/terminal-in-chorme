#!/usr/bin/env python3
"""
Smoke test for terminal_host.py that speaks the Chrome native messaging
framing over a pipe, exactly like Chrome does.

    python3 host/test_host.py
"""

import base64
import json
import os
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "terminal_host.py")


def send(proc, message):
    payload = json.dumps(message).encode()
    proc.stdin.write(struct.pack("<I", len(payload)) + payload)
    proc.stdin.flush()


def recv(proc, timeout=5.0):
    deadline = time.time() + timeout
    header = b""
    while len(header) < 4:
        chunk = proc.stdout.read(4 - len(header))
        if not chunk:
            raise AssertionError("host closed stdout")
        header += chunk
        if time.time() > deadline:
            raise AssertionError("timeout waiting for message header")
    (length,) = struct.unpack("<I", header)
    body = b""
    while len(body) < length:
        body += proc.stdout.read(length - len(body))
    return json.loads(body)


def collect_output(proc, until, timeout=5.0):
    """Read data messages until `until` appears in the decoded output."""
    buf = b""
    deadline = time.time() + timeout
    while until not in buf:
        if time.time() > deadline:
            raise AssertionError("timeout; got so far: %r" % buf)
        msg = recv(proc)
        if msg["type"] == "data":
            buf += base64.b64decode(msg["data"])
        elif msg["type"] == "error":
            raise AssertionError("host error: %s" % msg["message"])
        elif msg["type"] == "exit":
            raise AssertionError("shell exited early: %r (output %r)" % (msg, buf))
    return buf


def main():
    proc = subprocess.Popen(
        [sys.executable, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE)
    try:
        send(proc, {"type": "ping"})
        assert recv(proc)["type"] == "pong", "ping/pong failed"

        send(proc, {"type": "spawn", "cols": 100, "rows": 30, "shell": "/bin/sh"})
        ready = recv(proc)
        assert ready["type"] == "ready", ready
        assert ready["shell"] == "/bin/sh", ready
        print("spawned pid", ready["pid"], "shell", ready["shell"], "cwd", ready["cwd"])

        cmd = b"echo MARKER_$((6*7)); stty size; echo $TERM\n"
        send(proc, {"type": "input", "data": base64.b64encode(cmd).decode()})
        out = collect_output(proc, b"xterm-256color")
        assert b"MARKER_42" in out, out
        assert b"30 100" in out, "window size not applied: %r" % out
        print("echo + initial size OK")

        send(proc, {"type": "resize", "cols": 55, "rows": 17})
        time.sleep(0.1)
        send(proc, {"type": "input", "data": base64.b64encode(b"stty size; echo RE\"\"SIZED\n").decode()})
        out = collect_output(proc, b"RESIZED")
        assert b"17 55" in out, "resize not applied: %r" % out
        print("resize OK")

        # Unicode round trip
        text = "echo 한글-héllo-🍎\n".encode("utf-8")
        send(proc, {"type": "input", "data": base64.b64encode(text).decode()})
        out = collect_output(proc, "🍎".encode("utf-8"))
        assert "한글-héllo-🍎".encode("utf-8") in out
        print("unicode OK")

        # Ctrl-C reaches the foreground process
        send(proc, {"type": "input", "data": base64.b64encode(b"sleep 30; echo AFTER_\"\"SLEEP\n").decode()})
        time.sleep(0.3)
        send(proc, {"type": "input", "data": base64.b64encode(b"\x03").decode()})
        send(proc, {"type": "input", "data": base64.b64encode(b"echo INTER\"\"RUPTED\n").decode()})
        out = collect_output(proc, b"INTERRUPTED")
        assert b"AFTER_SLEEP" not in out
        print("ctrl-c OK")

        send(proc, {"type": "input", "data": base64.b64encode(b"exit 3\n").decode()})
        while True:
            msg = recv(proc)
            if msg["type"] == "exit":
                assert msg["code"] == 3, msg
                break
        print("exit code OK")

        proc.stdin.close()
        proc.wait(timeout=5)
        assert proc.returncode == 0, proc.returncode
        print("ALL TESTS PASSED")
    finally:
        if proc.poll() is None:
            proc.kill()
        err = proc.stderr.read().decode(errors="replace")
        if err:
            print("host stderr:\n" + err, file=sys.stderr)


if __name__ == "__main__":
    main()
