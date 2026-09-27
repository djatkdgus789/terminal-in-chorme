# Terminal in Chrome

macOS의 실제 셸(zsh/bash 등)을 Chrome 탭 또는 사이드 패널 안에서 사용하는 확장 프로그램입니다.

```
┌──────────────────────┐ Native Messaging ┌──────────────────┐ Unix socket ┌────────────────────┐ pty ┌──────────┐
│ Chrome 확장 (xterm.js)│ ◀──────────────▶ │ terminal_host.py │ ◀─────────▶ │ terminal_daemon.py │ ◀─▶ │ /bin/zsh │
│  탭마다 포트 1개       │  (stdin/stdout)  │   (탭마다 1개, 브리지)│             │ (사용자당 1개, 셸 소유)│     └──────────┘
└──────────────────────┘                  └──────────────────┘             └────────────────────┘
```

브라우저 확장은 직접 프로세스를 실행할 수 없기 때문에, Chrome이 공식 지원하는
[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
방식으로 Mac에 설치된 작은 Python 프로그램과 통신합니다.

- `host/terminal_host.py`: Chrome이 포트마다 하나씩 띄우는 **브리지**. stdin/stdout 프레임을 그대로 데몬의 Unix 소켓으로 중계합니다.
- `host/terminal_daemon.py`: 사용자당 하나 뜨는 **세션 데몬**. pty를 열어 로그인 셸을 실행하고 셸을 소유합니다. 필요할 때 자동으로 시작되고, 셸도 클라이언트도 없으면 스스로 종료합니다.

셸을 데몬이 소유하기 때문에 **브라우저 탭이나 사이드 패널을 닫아도 셸은 계속 실행**되고, 다음에 터미널 페이지를 열면 최근 출력(최대 512 KB)과 함께 자동으로 다시 연결됩니다. (Termium의 설계를 참고했습니다. 아래 "참고한 프로젝트" 참조.)
Python 표준 라이브러리만 사용하므로 별도 패키지 설치가 필요 없습니다.

## 기능

- 진짜 셸: 로그인 셸(`-l`)로 실행되어 `~/.zprofile`, `~/.zshrc`, Homebrew PATH 등이 그대로 적용
- 256색/트루컬러, 창 크기 자동 반영(`stty size`, vim/htop 등 정상 동작), 유니코드/한글
- 세션 지속: 페이지를 닫거나 새로고침해도 셸이 유지되고, 다시 열면 출력이 복원됨 (탭의 ×는 셸을 종료)
- 탭 여러 개(각 탭은 독립된 셸 프로세스), 사이드 패널 모드
- WebGL 렌더러(사용 불가 시 DOM 렌더러로 자동 대체), 대량 출력 시 흐름 제어(pause/resume)
- ⌘F 검색, ⌘C/⌘V 복사·붙여넣기, ⌘-클릭으로 링크 열기, 폰트 크기 단축키
- 다크/라이트/시스템 테마, 셸·시작 디렉터리·폰트·커서 등 설정 페이지
- 셸 종료 시 종료 코드 표시 및 재연결 버튼, 호스트 미설치 시 안내 화면

## 요구 사항

- macOS, Chrome 116 이상 (Chromium 계열: Brave, Edge, Arc, Vivaldi, Chrome Canary/Beta도 지원)
- `python3` — Xcode Command Line Tools(`xcode-select --install`) 또는 Homebrew(`brew install python`)

## 설치

```bash
git clone https://github.com/djatkdgus789/terminal-in-chorme.git
cd terminal-in-chorme
./install.sh
```

`install.sh`는 다음을 수행합니다.

1. 동작하는 `python3`를 찾아 `host/run_host.sh` 런처를 생성 (Chrome은 PATH가 거의 비어있는 상태로 호스트를 실행하므로 인터프리터 경로를 고정)
2. 설치된 각 브라우저의 `~/Library/Application Support/<브라우저>/NativeMessagingHosts/com.terminal_in_chrome.host.json` 매니페스트 작성

그 다음 확장을 로드합니다.

1. `chrome://extensions` → 우측 상단 **개발자 모드** 켜기
2. **압축해제된 확장 프로그램을 로드합니다** → 이 저장소의 `extension/` 폴더 선택
3. 확장 ID가 `njljokdmmbkdlmllndefhngkjcdgllma` 인지 확인 (manifest에 고정 키가 포함되어 있어 항상 같은 ID가 나옵니다)
4. 툴바 아이콘 클릭 또는 `Alt+Shift+T` → 터미널 탭이 열립니다

ID가 다르게 표시된다면(예: manifest의 `key`를 바꾼 경우):

```bash
./install.sh --extension-id <표시된 ID>
```

특정 브라우저에만 등록하려면 `./install.sh --browser chrome` (chrome, chrome-beta, chrome-canary, chromium, brave, edge, arc, vivaldi).
모든 계정에 적용하려면 `sudo ./install.sh --system` (`/Library/Google/Chrome/NativeMessagingHosts/`에 등록).

제거: `./uninstall.sh` 실행 후 `chrome://extensions`에서 확장 삭제.

## 사용법

| 단축키 | 동작 |
| --- | --- |
| `Alt+Shift+T` | 어느 페이지에서나 새 터미널 탭 열기 (`chrome://extensions/shortcuts`에서 변경 가능) |
| `Alt+Shift+P` | 사이드 패널에 터미널 열기 |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | 터미널 탭 추가 / 닫기 |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 이전 / 다음 터미널 탭 |
| `⌘C` / `⌘V` | 선택 영역 복사 / 붙여넣기 (`Ctrl+C`는 평소처럼 SIGINT) |
| `⌘K` | 화면 지우기 |
| `⌘F` | 스크롤백 검색 (Enter 다음, Shift+Enter 이전, Esc 닫기) |
| `⌘+` / `⌘-` / `⌘0` | 폰트 크기 조절 |
| `⌘-클릭` | 링크를 새 브라우저 탭에서 열기 |

`⌘T`, `⌘W`, `⌘1~9` 등 Chrome이 예약한 단축키는 확장에서 가로챌 수 없어 브라우저 동작이 우선합니다.

설정(툴바 아이콘 우클릭 → 옵션, 또는 터미널 탭의 ⚙)에서 셸 경로, 시작 디렉터리, 테마, 폰트, 커서, Option 키를 Meta로 사용할지, 툴바 버튼이 탭/사이드 패널 중 무엇을 열지, 페이지를 닫을 때 셸을 유지할지 지정할 수 있습니다.

### 세션 지속 동작

| 행동 | 결과 |
| --- | --- |
| 브라우저 탭/사이드 패널 닫기, 새로고침, Chrome 종료 | 셸은 데몬 안에서 계속 실행 (detach) |
| 터미널 페이지 다시 열기 | 연결되지 않은 셸을 모두 탭으로 복원, 최근 출력 재생 |
| 탭의 × 또는 `Ctrl+Shift+W` | 해당 셸 종료 (kill) |
| 셸에서 `exit` | 세션 삭제, 재연결 버튼으로 새 셸 시작 |

설정에서 "Keep shells running when the page is closed"를 끄면 페이지를 닫을 때 셸도 함께 종료됩니다. 한 셸은 한 화면에만 붙을 수 있으므로, 탭과 사이드 패널을 동시에 열면 각각 다른 셸을 보여줍니다. 설정 페이지의 **Test connection** 버튼으로 호스트 설치 상태를 확인할 수 있습니다.

## 프로젝트 구조

```
extension/            Chrome 확장 (Manifest V3)
  manifest.json
  background.js       툴바 버튼·단축키 → 탭/사이드 패널 열기
  terminal.html/js    xterm.js 터미널 UI, 탭 관리, 네이티브 포트 연결
  panel.html          사이드 패널용 진입점 (같은 스크립트)
  options.html/js     설정 페이지 + 호스트 연결 테스트
  shared.js           설정 기본값, base64 유틸, 오류 메시지
  vendor/             xterm.js 5.5.0, fit / web-links / search / webgl 애드온 (MIT)
host/
  terminal_host.py    네이티브 메시징 호스트 (Chrome ↔ 데몬 브리지, 데몬 자동 시작)
  terminal_daemon.py  세션 데몬 (pty 생성, 셸 소유, 재연결/출력 재생, 흐름 제어)
  test_host.py        호스트+데몬 프로토콜 테스트
install.sh            macOS 호스트 등록 스크립트
uninstall.sh
test/e2e_page_test.mjs  headless Chromium으로 확장 페이지 + 실제 호스트 E2E 테스트
```

### 메시지 프로토콜

확장 → 데몬: `spawn {cols, rows, shell?, cwd?}`, `attach {session, cols, rows}`, `list`, `input {data: base64}`, `resize {cols, rows}`, `title {title}`, `pause` / `resume`, `kill {session?}`, `ping`
데몬 → 확장: `hello {version}`, `ready {session, pid, shell, cwd, title, replay}`, `data {data: base64}`, `exit {code, signal}`, `sessions [...]`, `error {message}`, `pong`

브리지는 프레임을 해석하지 않고 그대로 넘기므로 양쪽 프레이밍이 동일합니다(4바이트 LE 길이 + JSON).
pty 출력은 바이너리이므로 base64로 감싸며, 호스트 → Chrome 메시지 1 MB 제한을 고려해 64 KB 단위로 나눠 보냅니다.
확장은 xterm.js가 아직 그리지 못한 바이트가 1 MB를 넘으면 `pause`를 보내 데몬이 pty 읽기를 멈추게 하고(셸은 자연스럽게 블록), 128 KB 아래로 내려오면 `resume`합니다.

## 테스트

```bash
python3 host/test_host.py          # 호스트+데몬: spawn/echo/resize/유니코드/Ctrl-C/detach·attach 재생/흐름 제어/kill/exit/idle 종료
node test/e2e_page_test.mjs        # playwright 필요 (npm i playwright): 실제 페이지 + 실제 호스트/데몬, 새로고침 후 재연결까지
```

두 테스트 모두 `TIC_RUNTIME_DIR` 환경 변수로 격리된 임시 디렉터리에 데몬을 띄우므로 실제 사용 중인 세션에 영향을 주지 않습니다.

## 문제 해결

- **"Native host is not installed"**: `./install.sh`를 다시 실행하고 브라우저를 완전히 종료 후 재시작합니다.
- **"Native host does not allow this extension"**: 확장 ID가 매니페스트의 `allowed_origins`와 다릅니다. `./install.sh --extension-id <ID>`.
- **"Native host failed to start"**: 터미널에서 `host/run_host.sh`를 직접 실행해 보세요. Python이 없다면 `xcode-select --install`.
- 셸이 뜨지만 뭔가 이상하거나 데몬 코드를 수정한 뒤라면 데몬을 재시작하세요: `pkill -f host/terminal_daemon.py` (실행 중인 셸도 함께 종료됩니다). 로그: `$TMPDIR/terminal-in-chrome-<uid>/daemon.log`.
- 셸이 뜨지만 PATH가 이상하다면 셸 설정 파일(`~/.zprofile`, `~/.zshrc`)을 확인하세요. 호스트는 로그인 셸로 실행하므로 보통 터미널.app과 동일하게 동작합니다.

## 보안 참고

이 확장은 사용자 계정 권한으로 셸을 실행합니다. 네이티브 호스트 매니페스트의 `allowed_origins`에 등록된 확장 ID만 호스트에 접속할 수 있으며, 웹 페이지는 접근할 수 없습니다. 데몬 소켓은 `0700` 디렉터리 안에 `0600` 권한으로 만들어져 같은 사용자만 접근할 수 있습니다. 신뢰할 수 있는 컴퓨터에서만 사용하세요.

## 참고한 프로젝트

- [Termium](https://github.com/imshaikot/termium) — Chrome DevTools 안의 터미널. Rust 데몬이 pty를 소유해 DevTools를 닫아도 세션이 유지되는 구조, WebGL 렌더러, 검색 기능을 참고해 이 프로젝트의 세션 데몬 / 재연결 / ⌘F / WebGL을 추가했습니다. (Termium은 데이터 경로로 로컬 WebSocket을, 네이티브 메시징은 인증 티켓 발급에만 씁니다. 이 프로젝트는 의존성 없이 Python 표준 라이브러리만으로 끝내기 위해 네이티브 메시징 포트를 데이터 경로로 그대로 사용합니다.)
- [firefox-side-panel-terminal](https://github.com/chengmingbo/firefox-side-panel-terminal) — Firefox 사이드바 터미널 (xterm.js + Go 헬퍼). base64로 pty 바이트를 감싸는 방식과 재연결 지원이 같은 접근입니다.
- [Secure Shell / hterm](https://chromium.googlesource.com/apps/libapps/+/HEAD/nassh/docs/FAQ.md) — Google의 Chrome SSH 클라이언트. macOS에서 ⌘C/⌘V 동작, copy-on-select 옵션, Chrome이 예약한 단축키(⌘T, ⌘W 등)는 탭 안에서 가로챌 수 없다는 제약을 참고했습니다.
- [chrome-extensions-samples/nativeMessaging](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/nativeMessaging) — 공식 샘플. 사용자별/시스템 전역(`/Library/...`) 설치 스크립트 구조를 참고해 `--system` 옵션을 넣었습니다.
- [ttyd](https://github.com/tsl0922/ttyd), [WeTTY](https://github.com/butlerx/wetty), [GoTTY](https://github.com/yudai/gotty) — 로컬 HTTP/WebSocket 서버 + xterm.js 방식의 웹 터미널. 서버를 직접 띄우고 브라우저로 접속하는 구조라 확장 없이도 쓸 수 있지만, 포트를 열어야 하고 브라우저 UI(탭/사이드 패널/단축키)와 통합되지 않습니다.
- [xterm.js](https://github.com/xtermjs/xterm.js) — 터미널 에뮬레이터 본체. VS Code 통합 터미널과 같은 라이브러리이며, 흐름 제어 가이드(write 콜백 + watermark)를 그대로 따랐습니다.

## 라이선스

이 저장소의 코드는 MIT 라이선스입니다. `extension/vendor/`의 xterm.js는 별도 MIT 라이선스(`LICENSE.xterm`)를 따릅니다.
