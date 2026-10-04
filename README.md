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
- 세션 지속: 페이지를 닫거나 새로고침해도 셸이 유지되고, 다시 열면 탭/분할 배치와 출력이 복원됨 (탭의 ×는 셸을 종료)
- 탭 여러 개와 **분할 창**(좌우/상하, 드래그로 크기 조절, 방향키로 포커스 이동), 사이드 패널 모드
- **프로파일**: 셸·시작 디렉터리·테마·폰트 세트를 여러 개 저장하고 탭마다 다르게 열기
- **셸 통합**(zsh, bash): 실패한 명령에 빨간 마크, ⌘↑/⌘↓로 프롬프트 사이 이동, 새 분할/탭이 현재 디렉터리에서 시작. dotfile을 건드리지 않음
- **이미지 표시**: `imgcat`(iTerm2 인라인 이미지 프로토콜)과 sixel(`img2sixel`, `chafa -f sixel` 등)을 터미널 안에 그대로 표시. 재연결 시에도 복원
- **브로드캐스트 입력**: 한 번 친 키 입력을 현재 탭의 모든 창, 또는 모든 탭의 모든 창에 동시에 전송. 창별로 제외 가능
- 여러 줄 붙여넣기 확인 창, 파일 경로 ⌘클릭으로 열기(`code -g {path}:{line}` 같은 명령 지정 가능)
- WebGL 렌더러(사용 불가 시 DOM 렌더러로 자동 대체), 대량 출력 시 흐름 제어(pause/resume)
- ⌘F 검색(정규식·대소문자 옵션), ⌘C/⌘V 복사·붙여넣기, ⌘-클릭으로 링크 열기, 폰트 크기 단축키
- 기본 테마는 [Dracula](https://draculatheme.com) (터미널 16색 팔레트와 탭 바·테두리 같은 화면 요소까지 공식 사양대로). Dark, Light, 시스템 따르기도 선택 가능
- 셸·시작 디렉터리·폰트·커서 등 설정 페이지
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
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | 터미널 탭 추가 / 현재 창 닫기 (마지막 창이면 탭 닫힘) |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | 오른쪽으로 분할 / 아래로 분할 |
| `Ctrl+Shift+←↑→↓` | 그 방향의 분할 창으로 포커스 이동 |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 이전 / 다음 터미널 탭 |
| `⌘↑` / `⌘↓` | 이전 / 다음 프롬프트로 스크롤 (셸 통합) |
| `Ctrl+Shift+B` | 브로드캐스트 입력: 끔 → 현재 탭 → 모든 탭 → 끔 (툴바의 안테나 버튼과 같음) |
| `Ctrl+Alt+Shift+B` | 브로드캐스트 중 현재 창을 제외 / 다시 포함 (창 오른쪽 아래 배지 클릭과 같음) |
| `⌘C` / `⌘V` | 선택 영역 복사 / 붙여넣기 (`Ctrl+C`는 평소처럼 SIGINT) |
| `⌘K` | 화면 지우기 |
| `⌘F` | 스크롤백 검색 (Enter 다음, Shift+Enter 이전, Esc 닫기) |
| `⌘+` / `⌘-` / `⌘0` | 폰트 크기 조절 |
| `⌘-클릭` | 링크는 새 브라우저 탭에서, 파일 경로(`src/app.py:12` 등)는 OS 또는 지정한 명령으로 열기 |
| `+` 우클릭 또는 `▾` | 프로파일을 골라 새 탭 열기 |

`⌘T`, `⌘W`, `⌘D`, `⌘1~9` 등 Chrome이 예약하거나 메뉴에 걸린 단축키는 확장에서 안전하게 가로챌 수 없어 iTerm2와 달리 Ctrl+Shift 조합을 씁니다.

### 프로파일

설정 페이지의 **Profiles**에서 이름, 셸, 시작 디렉터리, 테마, 폰트, 커서를 가진 프로파일을 여러 개 만들 수 있습니다. 비워 둔 항목은 전역 설정을 따릅니다. 기본 프로파일로 지정하면 `+` 버튼과 `Ctrl+Shift+T`가 그 프로파일로 열리고, 나머지는 `▾` 메뉴(또는 `+` 우클릭)에서 고릅니다. 분할 창은 원래 창의 프로파일을 물려받습니다.

### 이미지 표시

xterm.js 이미지 애드온으로 두 가지 프로토콜을 지원합니다.

- **iTerm2 인라인 이미지** (`ESC ] 1337 ; File=...`): 함께 들어 있는 `imgcat`이 셸의 PATH에 자동으로 추가됩니다. PNG, JPEG, GIF를 지원합니다.

  ```bash
  imgcat photo.png               # 원본 크기 (화면보다 크면 줄임)
  imgcat -W 40 photo.png         # 40칸 너비 (-W/-H는 칸 수, 300px, 50%, auto)
  curl -s https://…/a.png | imgcat
  ```

- **sixel**: `img2sixel`(libsixel), `chafa -f sixel`, `timg -p sixel` 등. 터미널이 장치 속성 응답(DA1)에 sixel 지원을 알리므로 자동 감지하는 도구도 동작합니다.

이미지 출력도 데몬의 재생 버퍼(최대 2 MB)에 들어가므로 탭을 닫았다 열면 다시 보입니다. 버퍼를 자를 때는 이미지 시퀀스 중간을 자르지 않아서, 버퍼보다 큰 이미지는 통째로 빠지고 base64가 글자로 쏟아지지 않습니다. 설정의 "Inline images"로 끌 수 있습니다. sixel 디코더가 WebAssembly라서 manifest의 CSP에 `wasm-unsafe-eval`이 들어 있습니다.

### 브로드캐스트 입력

iTerm2의 Broadcast Input과 같은 기능으로, 여러 서버에 같은 명령을 넣을 때 씁니다.

- 툴바의 안테나 버튼 또는 `Ctrl+Shift+B`로 **끔 → 현재 탭(Tab) → 모든 탭(All)** 순으로 바뀝니다. 켜져 있으면 버튼이 주황색이 되고, 입력을 받는 창마다 주황 테두리와 `BROADCAST` 배지가 붙습니다.
- 배지를 클릭하거나 `Ctrl+Alt+Shift+B`로 특정 창만 제외할 수 있습니다.
- 키보드, 붙여넣기, 한글 같은 IME 입력이 전달됩니다. 반면 터미널이 프로그램 질의에 자동으로 답하는 응답(커서 위치, 장치 속성 등)과 마우스 입력은 해당 창에만 갑니다. 이 구분이 없으면 한 창의 응답이 다른 셸에 쓰레기 입력으로 들어갑니다.
- 안전을 위해 브로드캐스트 상태는 저장하지 않습니다. 페이지를 다시 열면 항상 꺼진 상태입니다.

### 셸 통합

zsh와 bash에서 프롬프트 앞뒤와 명령 종료 시점에 OSC 133 시퀀스를, 디렉터리가 바뀔 때 OSC 7을 내보내도록 합니다. 방법은 VS Code와 같습니다.

- zsh: `ZDOTDIR`을 `host/shell-integration/zsh/`로 바꿔 시작하고, 그 안의 `.zshenv`/`.zprofile`/`.zshrc`가 사용자의 원래 파일을 순서대로 source한 뒤 훅을 설치하고 `ZDOTDIR`을 되돌립니다.
- bash: `bash --init-file host/shell-integration/bash/integration.bash`로 시작하고, 스크립트가 `/etc/profile`과 `~/.bash_profile`(없으면 `.bash_login`, `.profile`)을 source한 뒤 `PROMPT_COMMAND`와 `DEBUG` trap을 설치합니다.

사용자의 dotfile은 수정하지 않으며, fish 등 다른 셸은 통합 없이 그대로 실행됩니다. 설정에서 끌 수 있습니다.

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
  terminal.html/js    앱 셸: 탭, 프로파일 메뉴, 단축키, 배치 저장/복원
  session.js          터미널 창 하나: xterm.js, 네이티브 포트, 셸 통합, 검색, 붙여넣기 보호, 경로 링크
  workspace.js        탭 = 분할 창 트리 (렌더링, 드래그 리사이즈, 포커스 이동, 직렬화)
  panel.html          사이드 패널용 진입점 (같은 스크립트)
  options.html/js     설정 페이지 + 호스트 연결 테스트
  shared.js           설정 기본값, base64 유틸, 오류 메시지
  vendor/             xterm.js 5.5.0, fit / web-links / search / webgl / image 애드온 (MIT)
host/
  terminal_host.py    네이티브 메시징 호스트 (Chrome ↔ 데몬 브리지, 데몬 자동 시작)
  terminal_daemon.py  세션 데몬 (pty 생성, 셸 소유, 재연결/출력 재생, 흐름 제어, 파일 열기)
  shell-integration/  zsh, bash 셸 통합 스크립트
  bin/imgcat          iTerm2 인라인 이미지 출력 도구 (셸 PATH에 자동 추가)
  test_host.py        호스트+데몬 프로토콜 테스트
install.sh            macOS 호스트 등록 스크립트
uninstall.sh
test/e2e_page_test.mjs  headless Chromium으로 확장 페이지 + 실제 호스트 E2E 테스트
```

### 메시지 프로토콜

확장 → 데몬: `spawn {cols, rows, shell?, cwd?, integration?, profile?}`, `attach {session, cols, rows}`, `list`, `input {data: base64}`, `resize {cols, rows}`, `title {title}`, `open {path, line?, command?}`, `pause` / `resume`, `kill {session?}`, `ping`
데몬 → 확장: `hello {version}`, `ready {session, pid, shell, cwd, title, profile, replay}`, `data {data: base64}`, `exit {code, signal}`, `sessions [...]`, `opened {path}`, `error {message}`, `pong`

탭/분할 배치는 확장이 `chrome.storage.local`에 세션 ID 트리로 저장하고, 페이지를 열 때 데몬의 세션 목록과 맞춰 복원합니다.

브리지는 프레임을 해석하지 않고 그대로 넘기므로 양쪽 프레이밍이 동일합니다(4바이트 LE 길이 + JSON).
pty 출력은 바이너리이므로 base64로 감싸며, 호스트 → Chrome 메시지 1 MB 제한을 고려해 64 KB 단위로 나눠 보냅니다.
확장은 xterm.js가 아직 그리지 못한 바이트가 1 MB를 넘으면 `pause`를 보내 데몬이 pty 읽기를 멈추게 하고(셸은 자연스럽게 블록), 128 KB 아래로 내려오면 `resume`합니다.

## 테스트

```bash
python3 host/test_host.py          # 호스트+데몬: spawn/echo/resize/유니코드/Ctrl-C/detach·attach 재생/흐름 제어/kill/exit/idle 종료
node test/e2e_page_test.mjs        # playwright 필요 (npm i playwright): 실제 페이지 + 실제 호스트/데몬, 새로고침 후 재연결까지
node test/real_extension_test.mjs  # Linux: 압축 해제된 확장을 Chromium에 실제로 로드하고 네이티브 호스트를 등록해 사용자처럼 조작
```

`real_extension_test.mjs`는 아무것도 흉내 내지 않습니다. 확장 ID가 manifest 키대로 나오는지, 설치 직후 터미널 탭이 열리는지, 실제 `connectNative`로 셸이 붙는지, CSP 아래에서 이미지가 그려지는지, 분할과 브로드캐스트, 탭을 닫았다 열었을 때 같은 셸(PID)로 돌아오는지, 설정 페이지의 Test connection과 사이드 패널 페이지까지 확인합니다.

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

- [iTerm2](https://iterm2.com/) — 분할 창, 프로파일, 셸 통합(명령 마크·프롬프트 이동·현재 디렉터리 상속), 여러 줄 붙여넣기 경고, 파일 경로 ⌘클릭을 이 프로젝트에 맞게 옮겼습니다. Chrome 안에서는 핫키 창이나 ⌘T/⌘W/⌘D 같은 단축키를 그대로 쓸 수 없어 Ctrl+Shift 조합으로 대체했습니다.
- [VS Code 통합 터미널](https://github.com/microsoft/vscode) — dotfile을 건드리지 않는 셸 통합 방식(zsh `ZDOTDIR` 교체, bash `--init-file`)을 그대로 따랐습니다.
- [Termium](https://github.com/imshaikot/termium) — Chrome DevTools 안의 터미널. Rust 데몬이 pty를 소유해 DevTools를 닫아도 세션이 유지되는 구조, WebGL 렌더러, 검색 기능을 참고해 이 프로젝트의 세션 데몬 / 재연결 / ⌘F / WebGL을 추가했습니다. (Termium은 데이터 경로로 로컬 WebSocket을, 네이티브 메시징은 인증 티켓 발급에만 씁니다. 이 프로젝트는 의존성 없이 Python 표준 라이브러리만으로 끝내기 위해 네이티브 메시징 포트를 데이터 경로로 그대로 사용합니다.)
- [firefox-side-panel-terminal](https://github.com/chengmingbo/firefox-side-panel-terminal) — Firefox 사이드바 터미널 (xterm.js + Go 헬퍼). base64로 pty 바이트를 감싸는 방식과 재연결 지원이 같은 접근입니다.
- [Secure Shell / hterm](https://chromium.googlesource.com/apps/libapps/+/HEAD/nassh/docs/FAQ.md) — Google의 Chrome SSH 클라이언트. macOS에서 ⌘C/⌘V 동작, copy-on-select 옵션, Chrome이 예약한 단축키(⌘T, ⌘W 등)는 탭 안에서 가로챌 수 없다는 제약을 참고했습니다.
- [chrome-extensions-samples/nativeMessaging](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/nativeMessaging) — 공식 샘플. 사용자별/시스템 전역(`/Library/...`) 설치 스크립트 구조를 참고해 `--system` 옵션을 넣었습니다.
- [ttyd](https://github.com/tsl0922/ttyd), [WeTTY](https://github.com/butlerx/wetty), [GoTTY](https://github.com/yudai/gotty) — 로컬 HTTP/WebSocket 서버 + xterm.js 방식의 웹 터미널. 서버를 직접 띄우고 브라우저로 접속하는 구조라 확장 없이도 쓸 수 있지만, 포트를 열어야 하고 브라우저 UI(탭/사이드 패널/단축키)와 통합되지 않습니다.
- [xterm.js](https://github.com/xtermjs/xterm.js) — 터미널 에뮬레이터 본체. VS Code 통합 터미널과 같은 라이브러리이며, 흐름 제어 가이드(write 콜백 + watermark)를 그대로 따랐습니다.

## 라이선스

이 저장소의 코드는 MIT 라이선스입니다. `extension/vendor/`의 xterm.js는 별도 MIT 라이선스(`LICENSE.xterm`)를 따릅니다.
