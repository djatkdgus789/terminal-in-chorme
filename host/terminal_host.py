#!/usr/bin/env python3
"""
Native messaging host for the "Terminal in Chrome" extension.

Chrome launches this script (see install.sh) and talks to it over stdin/stdout
using the Chrome native messaging protocol: every message is a 4-byte
little-endian length followed by a UTF-8 JSON document.

Messages from the extension:
  {"type": "spawn", "cols": 80, "rows": 24, "shell": "/bin/zsh", "cwd": "~"}
  {"type": "input", "data": "<base64>"}
  {"type": "resize", "cols": 120, "rows": 40}
  {"type": "ping"}

Messages to the extension:
  {"type": "ready", "pid": 123, "shell": "/bin/zsh", "cwd": "/Users/me"}
  {"type": "data", "data": "<base64>"}
  {"type": "exit", "code": 0, "signal": null}
  {"type": "error", "message": "..."}
  {"type": "pong"}

Only the Python standard library is used so nothing has to be installed on
the Mac beyond the Python 3 that ships with the Xcode command line tools.
"""

import base64
import errno
import fcntl
import json
import os
import pwd
import select
import signal
import struct
import sys
import termios
import threading

# Chrome refuses host->extension messages larger than 1 MB. Base64 grows data
# by 4/3, so keep raw pty chunks well below that.
MAX_CHUNK = 64 * 1024

_stdout_lock = threading.Lock()
_stdin_fd = sys.stdin.fileno()
_stdout_fd = sys.stdout.fileno()


def send(message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    header = struct.pack("<I", len(payload))
    with _stdout_lock:
        _write_all(_stdout_fd, header + payload)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        view = view[n:]


def _read_exact(fd, size):
    chunks = []
    remaining = size
    while remaining > 0:
        try:
            chunk = os.read(fd, remaining)
        except InterruptedError:
            continue
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def receive():
    header = _read_exact(_stdin_fd, 4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    body = _read_exact(_stdin_fd, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def default_shell():
    shell = os.environ.get("SHELL")
    if not shell:
        try:
            shell = pwd.getpwuid(os.getuid()).pw_shell
        except KeyError:
            shell = None
    if not shell or not os.path.exists(shell):
        for candidate in ("/bin/zsh", "/bin/bash", "/bin/sh"):
            if os.path.exists(candidate):
                return candidate
    return shell or "/bin/sh"


def build_env():
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "terminal-in-chrome"
    env.setdefault("LANG", "en_US.UTF-8")
    env.setdefault("HOME", os.path.expanduser("~"))
    # Chrome launches us with a very small PATH when started from the Dock.
    # A login shell (-l) will rebuild PATH from the user's profile, but make
    # sure the common directories exist even before that happens.
    path_parts = env.get("PATH", "").split(":") if env.get("PATH") else []
    for extra in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                  "/usr/sbin", "/sbin"):
        if extra not in path_parts:
            path_parts.append(extra)
    env["PATH"] = ":".join(p for p in path_parts if p)
    return env


def set_winsize(fd, rows, cols):
    rows = max(1, int(rows or 24))
    cols = max(1, int(cols or 80))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Session:
    def __init__(self):
        self.pid = None
        self.fd = None
        self.reader = None
        self.exited = threading.Event()

    def spawn(self, cols, rows, shell=None, cwd=None):
        if self.pid is not None:
            raise RuntimeError("a shell is already running in this session")

        shell = shell or default_shell()
        if not os.path.exists(shell):
            raise RuntimeError("shell not found: %s" % shell)

        cwd = os.path.expanduser(cwd) if cwd else os.path.expanduser("~")
        if not os.path.isdir(cwd):
            cwd = os.path.expanduser("~")

        env = build_env()
        env["SHELL"] = shell
        argv = [os.path.basename(shell)]
        if os.path.basename(shell) in ("zsh", "bash", "fish", "sh", "ksh", "tcsh"):
            argv.append("-l")  # login shell so ~/.zprofile etc. are read

        # Open the pty ourselves (instead of pty.fork()) so the window size is
        # set on the tty *before* the child exists. Otherwise a resize that
        # arrives while the child is still starting could be overwritten by
        # the child's own initial size.
        master, slave = os.openpty()
        set_winsize(master, rows, cols)
        pid = os.fork()
        if pid == 0:  # child
            try:
                os.close(master)
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                os.dup2(slave, 0)
                os.dup2(slave, 1)
                os.dup2(slave, 2)
                if slave > 2:
                    os.close(slave)
                os.chdir(cwd)
                # Restore default signal dispositions Chrome may have changed.
                for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP,
                            signal.SIGPIPE):
                    signal.signal(sig, signal.SIG_DFL)
                os.execvpe(shell, argv, env)
            except Exception as exc:  # pragma: no cover - runs in the child
                os.write(2, ("exec failed: %s\n" % exc).encode())
            finally:
                os._exit(127)
        os.close(slave)
        fd = master

        self.pid = pid
        self.fd = fd
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()
        return {"pid": pid, "shell": shell, "cwd": cwd}

    def _pump(self):
        fd = self.fd
        while True:
            try:
                ready, _, _ = select.select([fd], [], [], 1.0)
            except (OSError, ValueError):
                break
            if not ready:
                continue
            try:
                data = os.read(fd, MAX_CHUNK)
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                break  # EIO: slave side closed, shell exited
            if not data:
                break
            send({"type": "data", "data": base64.b64encode(data).decode("ascii")})
        self._finish()

    def _finish(self):
        code, sig = None, None
        try:
            _, status = os.waitpid(self.pid, 0)
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                sig = os.WTERMSIG(status)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.exited.set()
        send({"type": "exit", "code": code, "signal": sig})

    def write(self, data):
        if self.fd is None or self.exited.is_set():
            return
        try:
            _write_all(self.fd, data)
        except OSError:
            pass

    def resize(self, cols, rows):
        if self.fd is None or self.exited.is_set():
            return
        try:
            set_winsize(self.fd, rows, cols)
            os.kill(self.pid, signal.SIGWINCH)
        except OSError:
            pass

    def terminate(self):
        if self.pid is None or self.exited.is_set():
            return
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
            except OSError:
                return
            if self.exited.wait(0.5):
                return


def main():
    session = Session()
    try:
        while True:
            message = receive()
            if message is None:
                break  # Chrome closed the port
            kind = message.get("type")
            try:
                if kind == "spawn":
                    info = session.spawn(
                        message.get("cols"), message.get("rows"),
                        message.get("shell") or None, message.get("cwd") or None)
                    info["type"] = "ready"
                    send(info)
                elif kind == "input":
                    session.write(base64.b64decode(message.get("data", "")))
                elif kind == "resize":
                    session.resize(message.get("cols"), message.get("rows"))
                elif kind == "ping":
                    send({"type": "pong"})
                else:
                    send({"type": "error", "message": "unknown message type: %r" % kind})
            except Exception as exc:
                send({"type": "error", "message": str(exc)})
    finally:
        session.terminate()


if __name__ == "__main__":
    main()
