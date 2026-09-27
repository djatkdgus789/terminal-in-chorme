#!/usr/bin/env python3
"""
Smoke test for terminal_host.py + terminal_daemon.py. It speaks the Chrome
native messaging framing over pipes exactly like Chrome does.

    python3 host/test_host.py
"""

import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "terminal_host.py")


class Port:
    """One connectNative() port = one host process."""

    def __init__(self, env):
        self.proc = subprocess.Popen(
            [sys.executable, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env)

    def send(self, message):
        payload = json.dumps(message).encode()
        self.proc.stdin.write(struct.pack("<I", len(payload)) + payload)
        self.proc.stdin.flush()

    def recv(self, timeout=5.0):
        header = self._read(4, timeout)
        (length,) = struct.unpack("<I", header)
        return json.loads(self._read(length, timeout))

    def _read(self, size, timeout):
        # stdout is a blocking pipe; rely on the daemon answering promptly.
        buf = b""
        deadline = time.time() + timeout
        while len(buf) < size:
            chunk = self.proc.stdout.read(size - len(buf))
            if not chunk:
                raise AssertionError("host closed stdout; stderr=%r" % self.proc.stderr.read())
            buf += chunk
            if time.time() > deadline:
                raise AssertionError("timeout reading from host")
        return buf

    def expect(self, kind, timeout=5.0):
        while True:
            msg = self.recv(timeout)
            if msg["type"] == "hello":
                continue
            if msg["type"] == kind:
                return msg
            if msg["type"] == "error":
                raise AssertionError("host error: %s" % msg["message"])
            if msg["type"] != "data":
                raise AssertionError("expected %s, got %r" % (kind, msg))

    def type(self, text):
        self.send({"type": "input", "data": base64.b64encode(text.encode()).decode()})

    def read_until(self, marker, timeout=5.0):
        buf = b""
        deadline = time.time() + timeout
        while marker.encode() not in buf:
            if time.time() > deadline:
                raise AssertionError("timeout waiting for %r; got %r" % (marker, buf))
            msg = self.recv(timeout)
            if msg["type"] == "data":
                buf += base64.b64decode(msg["data"])
            elif msg["type"] == "error":
                raise AssertionError("host error: %s" % msg["message"])
            elif msg["type"] == "exit":
                raise AssertionError("shell exited early: %r (output %r)" % (msg, buf))
        return buf.decode("utf-8", "replace")

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)
        return self.proc.returncode


def main():
    runtime = tempfile.mkdtemp(prefix="tic-test-")
    env = dict(os.environ, TIC_RUNTIME_DIR=runtime)
    try:
        run(env)
    finally:
        log = os.path.join(runtime, "daemon.log")
        if os.path.exists(log):
            print("--- daemon.log ---")
            print(open(log).read())
        shutil.rmtree(runtime, ignore_errors=True)


def run(env):
    # 1. basics: ping, spawn, echo, initial size, TERM
    a = Port(env)
    a.send({"type": "ping"})
    a.expect("pong")
    a.send({"type": "spawn", "cols": 100, "rows": 30, "shell": "/bin/sh"})
    ready = a.expect("ready")
    sid = ready["session"]
    assert ready["shell"] == "/bin/sh" and ready["replay"] is False, ready
    print("spawned session", sid, "pid", ready["pid"])

    a.type("echo MARKER_$((6*7)); stty size; echo $TERM\n")
    out = a.read_until("xterm-256color")
    assert "MARKER_42" in out and "30 100" in out, out
    print("echo + initial size OK")

    # 2. resize
    a.send({"type": "resize", "cols": 55, "rows": 17})
    time.sleep(0.1)
    a.type('stty size; echo RE""SIZED\n')
    assert "17 55" in a.read_until("RESIZED")
    print("resize OK")

    # 3. unicode
    a.type("echo 한글-héllo-🍎\n")
    assert "한글-héllo-🍎" in a.read_until("🍎")
    print("unicode OK")

    # 4. ctrl-c reaches the foreground job
    a.type('sleep 30; echo AFTER_""SLEEP\n')
    time.sleep(0.3)
    a.type("\x03")
    a.type('echo INTER""RUPTED\n')
    out = a.read_until("INTERRUPTED")
    assert "AFTER_SLEEP" not in out
    print("ctrl-c OK")

    # 5. title + list
    a.send({"type": "title", "title": "my tab"})
    a.send({"type": "list"})
    lst = a.expect("sessions")["sessions"]
    assert [s["session"] for s in lst] == [sid] and lst[0]["attached"] and lst[0]["title"] == "my tab", lst
    print("list OK")

    # 6. detach (close the port) -> shell keeps running, state preserved
    a.type("MYVAR=persisted; cd /tmp\n")
    a.read_until("cd /tmp")
    assert a.close() == 0

    b = Port(env)
    b.send({"type": "list"})
    lst = b.expect("sessions")["sessions"]
    assert len(lst) == 1 and not lst[0]["attached"], lst
    b.send({"type": "attach", "session": sid, "cols": 90, "rows": 25})
    ready = b.expect("ready")
    assert ready["session"] == sid and ready["replay"] is True, ready
    replay = b.read_until("cd /tmp")
    assert "MARKER_42" in replay, "scrollback was not replayed: %r" % replay
    b.type('echo $MYVAR-$(pwd); stty size; echo RE""ATTACHED\n')
    out = b.read_until("REATTACHED")
    assert "persisted-/tmp" in out and "25 90" in out, out
    print("detach / re-attach with replay OK")

    # 7. a second port cannot steal an attached session
    c = Port(env)
    c.send({"type": "attach", "session": sid, "cols": 80, "rows": 24})
    msg = c.recv()
    while msg["type"] == "hello":
        msg = c.recv()
    assert msg["type"] == "error" and "attached" in msg["message"], msg
    c.close()
    print("exclusive attach OK")

    # 8. flow control: pause stops output, resume delivers it
    b.send({"type": "pause"})
    time.sleep(0.1)
    b.type('echo PAU""SED_OUTPUT\n')
    time.sleep(0.5)
    b.send({"type": "resume"})
    b.read_until("PAUSED_OUTPUT", timeout=3)
    print("pause/resume OK")

    # 9. spawn a second shell on another port, kill it by id from the first
    d = Port(env)
    d.send({"type": "spawn", "cols": 80, "rows": 24, "shell": "/bin/sh"})
    sid2 = d.expect("ready")["session"]
    b.send({"type": "kill", "session": sid2})
    ex = d.expect("exit")
    assert ex["signal"] is not None or ex["code"] is not None, ex
    d.close()
    print("kill by id OK")

    # 10. exit code is reported and the session disappears
    b.type("exit 3\n")
    ex = b.expect("exit")
    assert ex["code"] == 3, ex
    b.send({"type": "list"})
    assert b.expect("sessions")["sessions"] == []
    assert b.close() == 0
    print("exit code OK")

    # 11. shell integration (bash): prompt marks, exit codes, cwd reports;
    #     the "open" message validates paths
    e = Port(env)
    e.send({"type": "spawn", "cols": 80, "rows": 24, "shell": "/bin/bash", "integration": True, "profile": "p1"})
    assert e.expect("ready")["profile"] == "p1"
    e.type("cd /tmp; false\n")
    out = e.read_until("/tmp\x07")  # the OSC 7 report that follows the exit mark
    for mark in ("\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07", "\x1b]133;D;1\x07", "\x1b]7;file://"):
        assert mark in out, "missing %r in %r" % (mark, out)
    e.send({"type": "open", "path": "/definitely/not/here"})
    msg = e.recv()
    while msg["type"] in ("hello", "data"):
        msg = e.recv()
    assert msg["type"] == "error" and "no such file" in msg["message"], msg
    e.send({"type": "open", "path": HOST, "line": 3, "command": "true {path} {line}"})
    assert e.expect("opened")["path"] == HOST
    e.type("exit\n")
    e.expect("exit")
    e.close()
    print("shell integration + open OK")

    # 12. with nothing left to do the daemon exits on its own
    sock = os.path.join(env["TIC_RUNTIME_DIR"], "daemon.sock")
    deadline = time.time() + 30
    while os.path.exists(sock) and time.time() < deadline:
        time.sleep(0.5)
    assert not os.path.exists(sock), "daemon did not exit when idle"
    print("idle exit OK")
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
