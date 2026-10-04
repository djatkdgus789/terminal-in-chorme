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


def test_replay_buffer():
    sys.path.insert(0, HERE)
    from terminal_daemon import ReplayBuffer

    # plain text: keeps the most recent bytes, starting on a fresh line
    rb = ReplayBuffer(1000)
    for i in range(300):
        rb.append(b"line %03d\n" % i)
    snap = rb.snapshot()
    assert len(snap) <= 1500 and snap.endswith(b"line 299\n") and snap.startswith(b"line "), snap[:40]

    # an image straddling the cut is dropped whole, never replayed as base64 text
    rb = ReplayBuffer(1000)
    rb.append(b"before\n" + b"\x1b]1337;File=inline=1:" + b"A" * 900 + b"\x07" + b"after-image\n")
    rb.append(b"x" * 700 + b"\n")
    snap = rb.snapshot()
    assert b"AAAA" not in snap and b"\x1b]1337" not in snap and snap.endswith(b"x\n"), snap[:60]

    # a sixel (DCS ... ESC \\) that ends before the cut is kept intact
    rb = ReplayBuffer(1000)
    sixel = b"\x1bPq#0;2;100;0;0#0!40~\x1b\\"
    rb.append(b"y" * 900 + b"\n" + sixel + b"\nend\n")
    rb.append(b"z" * 400 + b"\n")
    assert sixel in rb.snapshot()

    # a string longer than the whole buffer is skipped, including what is still to come
    rb = ReplayBuffer(1000)
    rb.append(b"\x1b]1337;File=inline=1:" + b"B" * 2000)
    assert rb.snapshot() == b"" and rb.skipping
    rb.append(b"B" * 500)
    rb.append(b"BBB\x07tail\n")
    assert rb.snapshot() == b"tail\n" and not rb.skipping, rb.snapshot()
    print("replay buffer trimming OK")


def main():
    test_replay_buffer()
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
    e.type('command -v imgcat; echo PATH_""OK\n')
    out = e.read_until("PATH_OK")
    assert "/host/bin/imgcat" in out, "imgcat not on PATH: %r" % out
    e.type("exit\n")
    e.expect("exit")
    e.close()
    print("shell integration + open + imgcat on PATH OK")

    # 12. an image bigger than the replay buffer never comes back as base64 text
    f = Port(env)
    f.send({"type": "spawn", "cols": 80, "rows": 24, "shell": "/bin/sh"})
    sid3 = f.expect("ready")["session"]
    big = os.path.join(env["TIC_RUNTIME_DIR"], "big.bin")
    with open(big, "wb") as fh:
        fh.write(os.urandom(3 * 1024 * 1024))   # base64 -> ~4 MB > 2 MB buffer
    f.type("%s %s %s >/dev/null; echo BIG_""SENT\n" % (sys.executable, os.path.join(HERE, "bin", "imgcat"), big))
    f.read_until("BIG_SENT")
    f.type("%s %s %s; echo AFTER_""BIG\n" % (sys.executable, os.path.join(HERE, "bin", "imgcat"), big))
    f.read_until("AFTER_BIG", timeout=30)
    f.close()
    g = Port(env)
    g.send({"type": "attach", "session": sid3, "cols": 80, "rows": 24})
    assert g.expect("ready")["replay"] is True
    replay = g.read_until("AFTER_BIG", timeout=10)
    printable_runs = max((len(r) for r in replay.replace("\r", "\n").split("\n")), default=0)
    assert printable_runs < 1000, "base64 leaked into the replay (line of %d chars)" % printable_runs
    g.type("exit\n")
    g.expect("exit")
    g.close()
    print("oversized image is not replayed as text OK")

    # 13. with nothing left to do the daemon exits on its own
    sock = os.path.join(env["TIC_RUNTIME_DIR"], "daemon.sock")
    deadline = time.time() + 30
    while os.path.exists(sock) and time.time() < deadline:
        time.sleep(0.5)
    assert not os.path.exists(sock), "daemon did not exit when idle"
    print("idle exit OK")
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
