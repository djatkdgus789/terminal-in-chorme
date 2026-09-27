#!/usr/bin/env python3
"""
Session daemon for the "Terminal in Chrome" extension.

The daemon owns the pty sessions so that a shell keeps running when its
browser tab or side panel is closed. terminal_host.py (the native messaging
host Chrome starts per port) is only a bridge: it forwards frames between
Chrome and this daemon over a Unix socket. The daemon exits by itself once
no shells and no clients are left. This mirrors the "daemon owns the PTYs"
design of Termium (https://github.com/imshaikot/termium).

Framing is the Chrome native messaging framing on both sides: a 4-byte
little-endian length followed by UTF-8 JSON.

Client -> daemon:
  {"type": "spawn", "cols", "rows", "shell"?, "cwd"?, "integration"?, "profile"?}
                                                       start a shell and attach
  {"type": "attach", "session", "cols", "rows"}        attach to a detached shell
  {"type": "list"}                                     list sessions
  {"type": "input", "data": base64}
  {"type": "resize", "cols", "rows"}
  {"type": "title", "title"}                           remember the tab title
  {"type": "open", "path", "line"?, "command"?}        open a file with the OS / an editor
  {"type": "pause"} / {"type": "resume"}               flow control
  {"type": "kill", "session"?}                         terminate a shell
  {"type": "ping"}

Daemon -> client:
  {"type": "hello", "version"}
  {"type": "ready", "session", "pid", "shell", "cwd", "title", "profile", "replay": bool}
  {"type": "opened", "path"}
  {"type": "data", "data": base64}
  {"type": "exit", "code", "signal"}
  {"type": "sessions", "sessions": [...]}
  {"type": "error", "message"}
  {"type": "pong"}
"""

import base64
import errno
import shlex
import subprocess
import fcntl
import json
import os
import pwd
import select
import signal
import socket
import struct
import sys
import tempfile
import threading
import time
import uuid

VERSION = 3
HERE = os.path.dirname(os.path.abspath(__file__))
INTEGRATION_DIR = os.path.join(HERE, "shell-integration")
MAX_CHUNK = 64 * 1024          # keep host->Chrome frames well under 1 MB
SCROLLBACK_BYTES = 512 * 1024  # raw output replayed on re-attach
IDLE_EXIT_SECONDS = 15


def runtime_dir():
    base = os.environ.get("TIC_RUNTIME_DIR")
    if not base:
        base = os.path.join(tempfile.gettempdir(), "terminal-in-chrome-%d" % os.getuid())
    os.makedirs(base, mode=0o700, exist_ok=True)
    os.chmod(base, 0o700)
    return base


def socket_path():
    return os.path.join(runtime_dir(), "daemon.sock")


def log(message):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), message))
    sys.stderr.flush()


# --- framing ---------------------------------------------------------------

def pack(message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def recv_exact(sock, size):
    chunks = []
    while size > 0:
        chunk = sock.recv(size)
        if not chunk:
            return None
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def recv_frame(sock):
    header = recv_exact(sock, 4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    body = recv_exact(sock, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


# --- shell helpers ----------------------------------------------------------

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
    # Chrome starts native hosts with a tiny PATH when launched from the Dock.
    # The login shell rebuilds it from the user's profile, but seed the usual
    # directories anyway.
    parts = env.get("PATH", "").split(":") if env.get("PATH") else []
    for extra in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                  "/usr/sbin", "/sbin"):
        if extra not in parts:
            parts.append(extra)
    env["PATH"] = ":".join(p for p in parts if p)
    env.pop("TIC_RUNTIME_DIR", None)
    return env


def set_winsize(fd, rows, cols):
    rows = max(1, int(rows or 24))
    cols = max(1, int(cols or 80))
    fcntl.ioctl(fd, termios_TIOCSWINSZ(), struct.pack("HHHH", rows, cols, 0, 0))


def termios_TIOCSWINSZ():
    import termios
    return termios.TIOCSWINSZ


def termios_TIOCSCTTY():
    import termios
    return termios.TIOCSCTTY


# --- sessions ---------------------------------------------------------------

def shell_integration(shell, env, argv):
    """Arrange for the shell to emit OSC 133 prompt marks and OSC 7 cwd
    reports without touching the user's dotfiles (VS Code's approach)."""
    name = os.path.basename(shell)
    if name == "zsh":
        env["TIC_USER_ZDOTDIR"] = env.get("ZDOTDIR") or env["HOME"]
        env["ZDOTDIR"] = os.path.join(INTEGRATION_DIR, "zsh")
    elif name == "bash":
        # --init-file replaces the login files; our script sources them.
        argv = [argv[0], "--init-file", os.path.join(INTEGRATION_DIR, "bash", "integration.bash")]
    else:
        return argv  # fish & co: no integration yet
    env["TIC_SHELL_INTEGRATION"] = "1"
    return argv


def open_path(path, line=None, command=None):
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        raise RuntimeError("no such file: %s" % path)
    if command:
        argv = [a.replace("{path}", path).replace("{line}", str(line or 1)) for a in shlex.split(command)]
    elif sys.platform == "darwin":
        argv = ["open", path]
    else:
        argv = ["xdg-open", path]
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, env=build_env())
    return path


class Session:
    def __init__(self, daemon, cols, rows, shell=None, cwd=None, integration=True, profile=""):
        self.daemon = daemon
        self.id = uuid.uuid4().hex[:12]
        self.lock = threading.Lock()
        self.client = None
        self.title = ""
        self.profile = profile or ""
        self.created = time.time()
        self.exit_info = None
        self.buffer = bytearray()
        self.resume = threading.Event()
        self.resume.set()

        shell = shell or default_shell()
        if not os.path.exists(shell):
            raise RuntimeError("shell not found: %s" % shell)
        cwd = os.path.expanduser(cwd) if cwd else os.path.expanduser("~")
        if not os.path.isdir(cwd):
            cwd = os.path.expanduser("~")
        self.shell = shell
        self.cwd = cwd

        env = build_env()
        env["SHELL"] = shell
        env["TERMINAL_IN_CHROME_SESSION"] = self.id
        argv = [os.path.basename(shell)]
        if os.path.basename(shell) in ("zsh", "bash", "fish", "sh", "ksh", "tcsh"):
            argv.append("-l")  # login shell: ~/.zprofile, Homebrew PATH, ...
        if integration:
            argv = shell_integration(shell, env, argv)

        # Size the tty before the child exists so an early resize can never be
        # overwritten by the child's initial size.
        master, slave = os.openpty()
        set_winsize(master, rows, cols)
        pid = os.fork()
        if pid == 0:  # child: only async-signal-safe os-level calls here
            try:
                os.close(master)
                os.setsid()
                fcntl.ioctl(slave, termios_TIOCSCTTY(), 0)
                os.dup2(slave, 0)
                os.dup2(slave, 1)
                os.dup2(slave, 2)
                if slave > 2:
                    os.close(slave)
                os.chdir(cwd)
                for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP,
                            signal.SIGPIPE, signal.SIGTERM, signal.SIGHUP):
                    signal.signal(sig, signal.SIG_DFL)
                os.execvpe(shell, argv, env)
            except BaseException as exc:  # pragma: no cover
                os.write(2, ("exec failed: %s\n" % exc).encode())
            finally:
                os._exit(127)
        os.close(slave)
        self.pid = pid
        self.fd = master
        threading.Thread(target=self._pump, name="pty-" + self.id, daemon=True).start()

    # -- output ---------------------------------------------------------------
    def _pump(self):
        fd = self.fd
        while True:
            self.resume.wait()
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
                break  # EIO: shell exited
            if not data:
                break
            frame = pack({"type": "data", "data": base64.b64encode(data).decode("ascii")})
            with self.lock:
                self.buffer += data
                if len(self.buffer) > SCROLLBACK_BYTES * 3 // 2:
                    del self.buffer[:len(self.buffer) - SCROLLBACK_BYTES]
                client = self.client
            if client is not None:
                client.send_raw(frame)
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
        with self.lock:
            self.exit_info = {"code": code, "signal": sig}
            client = self.client
            self.client = None
        self.daemon.remove_session(self)
        if client is not None:
            client.send({"type": "exit", "code": code, "signal": sig})
            client.detach(self)
        log("session %s exited (code=%s signal=%s)" % (self.id, code, sig))

    # -- control --------------------------------------------------------------
    def attach(self, client, cols, rows, replay):
        with self.lock:
            if self.exit_info is not None:
                raise RuntimeError("session has exited")
            if self.client is not None and self.client is not client:
                raise RuntimeError("session is attached to another terminal")
            self.client = client
            snapshot = bytes(self.buffer) if replay else b""
            self._resize(cols, rows)
            client.send({"type": "ready", "session": self.id, "pid": self.pid,
                         "shell": self.shell, "cwd": self.cwd, "title": self.title,
                         "profile": self.profile, "replay": bool(snapshot)})
            for i in range(0, len(snapshot), MAX_CHUNK):
                chunk = snapshot[i:i + MAX_CHUNK]
                client.send({"type": "data", "data": base64.b64encode(chunk).decode("ascii")})
            # Nudge full-screen programs (vim, htop) to repaint for this viewer.
            if snapshot:
                self._signal_winch()

    def detach_client(self, client):
        with self.lock:
            if self.client is client:
                self.client = None
                self.resume.set()

    def write(self, data):
        if self.exit_info is not None:
            return
        view = memoryview(data)
        while view:
            try:
                n = os.write(self.fd, view)
            except InterruptedError:
                continue
            except OSError:
                return
            view = view[n:]

    def _resize(self, cols, rows):
        if self.exit_info is not None:
            return
        try:
            set_winsize(self.fd, rows, cols)
            self._signal_winch()
        except OSError:
            pass

    def _signal_winch(self):
        try:
            os.killpg(self.pid, signal.SIGWINCH)
        except OSError:
            pass

    def resize(self, cols, rows):
        with self.lock:
            self._resize(cols, rows)

    def terminate(self):
        if self.exit_info is not None:
            return
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.pid, sig)
            except OSError:
                return
            for _ in range(10):
                if self.exit_info is not None:
                    return
                time.sleep(0.05)

    def describe(self):
        return {"session": self.id, "pid": self.pid, "shell": self.shell,
                "cwd": self.cwd, "title": self.title, "profile": self.profile,
                "created": self.created, "attached": self.client is not None}


class Client:
    def __init__(self, daemon, sock):
        self.daemon = daemon
        self.sock = sock
        self.lock = threading.Lock()
        self.session = None
        self.closed = False

    def send(self, message):
        self.send_raw(pack(message))

    def send_raw(self, frame):
        with self.lock:
            if self.closed:
                return
            try:
                self.sock.sendall(frame)
            except OSError:
                self.closed = True

    def detach(self, session):
        if self.session is session:
            self.session = None

    def run(self):
        self.send({"type": "hello", "version": VERSION})
        try:
            while True:
                try:
                    message = recv_frame(self.sock)
                except (OSError, ValueError):
                    break
                if message is None:
                    break
                try:
                    self.handle(message)
                except Exception as exc:
                    self.send({"type": "error", "message": str(exc)})
        finally:
            self.close()

    def handle(self, message):
        kind = message.get("type")
        if kind == "spawn":
            if self.session is not None:
                raise RuntimeError("this connection already has a shell")
            session = self.daemon.create_session(
                message.get("cols"), message.get("rows"),
                message.get("shell") or None, message.get("cwd") or None,
                message.get("integration", True), message.get("profile") or "")
            self.session = session
            session.attach(self, message.get("cols"), message.get("rows"), replay=False)
        elif kind == "attach":
            if self.session is not None:
                raise RuntimeError("this connection already has a shell")
            session = self.daemon.get_session(message.get("session"))
            if session is None:
                raise RuntimeError("no such session: %s" % message.get("session"))
            self.session = session
            try:
                session.attach(self, message.get("cols"), message.get("rows"), replay=True)
            except Exception:
                self.session = None
                raise
        elif kind == "list":
            self.send({"type": "sessions", "sessions": self.daemon.list_sessions()})
        elif kind == "input":
            if self.session:
                self.session.write(base64.b64decode(message.get("data", "")))
        elif kind == "resize":
            if self.session:
                self.session.resize(message.get("cols"), message.get("rows"))
        elif kind == "title":
            if self.session:
                self.session.title = str(message.get("title", ""))[:200]
        elif kind == "open":
            path = open_path(message.get("path", ""), message.get("line"), message.get("command"))
            self.send({"type": "opened", "path": path})
        elif kind == "pause":
            if self.session:
                self.session.resume.clear()
        elif kind == "resume":
            if self.session:
                self.session.resume.set()
        elif kind == "kill":
            target = self.daemon.get_session(message.get("session")) if message.get("session") else self.session
            if target is not None:
                target.terminate()
        elif kind == "ping":
            self.send({"type": "pong"})
        else:
            raise RuntimeError("unknown message type: %r" % kind)

    def close(self):
        with self.lock:
            self.closed = True
        if self.session is not None:
            self.session.detach_client(self)
            self.session = None
        try:
            self.sock.close()
        except OSError:
            pass
        self.daemon.remove_client(self)


class Daemon:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.sessions = {}
        self.clients = set()
        self.idle_since = time.time()

    def create_session(self, cols, rows, shell, cwd, integration=True, profile=""):
        session = Session(self, cols, rows, shell, cwd, integration, profile)
        with self.lock:
            self.sessions[session.id] = session
        log("session %s spawned: %s (pid %d)" % (session.id, session.shell, session.pid))
        return session

    def get_session(self, session_id):
        with self.lock:
            return self.sessions.get(session_id)

    def list_sessions(self):
        with self.lock:
            sessions = list(self.sessions.values())
        return [s.describe() for s in sorted(sessions, key=lambda s: s.created)]

    def remove_session(self, session):
        with self.lock:
            self.sessions.pop(session.id, None)
            self._touch_idle()

    def remove_client(self, client):
        with self.lock:
            self.clients.discard(client)
            self._touch_idle()

    def _touch_idle(self):
        if not self.sessions and not self.clients:
            self.idle_since = time.time()

    def serve(self):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if os.path.exists(self.path):
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(self.path)
                probe.close()
                log("another daemon is already listening on %s" % self.path)
                return 0
            except OSError:
                os.unlink(self.path)
        try:
            server.bind(self.path)
        except OSError as exc:
            log("bind failed: %s" % exc)
            return 1
        os.chmod(self.path, 0o600)
        server.listen(16)
        server.settimeout(1.0)
        log("listening on %s (pid %d)" % (self.path, os.getpid()))
        try:
            while True:
                try:
                    sock, _ = server.accept()
                except socket.timeout:
                    with self.lock:
                        idle = not self.sessions and not self.clients
                        idle_for = time.time() - self.idle_since
                    if idle and idle_for > IDLE_EXIT_SECONDS:
                        log("idle, exiting")
                        return 0
                    continue
                client = Client(self, sock)
                with self.lock:
                    self.clients.add(client)
                threading.Thread(target=client.run, daemon=True).start()
        finally:
            server.close()
            try:
                os.unlink(self.path)
            except OSError:
                pass


def main():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    path = socket_path()
    if len(path) > 100:
        log("socket path too long for macOS: %s" % path)
        return 1
    return Daemon(path).serve()


if __name__ == "__main__":
    sys.exit(main())
