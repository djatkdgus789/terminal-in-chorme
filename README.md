# Terminal in Chrome

macOS의 실제 셸(zsh/bash 등)을 Chrome 탭 또는 사이드 패널 안에서 사용하는 확장 프로그램입니다.

```
┌───────────────────────┐   Native Messaging   ┌──────────────────────┐   pty   ┌──────────┐
│ Chrome 확장 (xterm.js) │ ◀──────────────────▶ │ host/terminal_host.py │ ◀─────▶ │ /bin/zsh │
└───────────────────────┘   (stdin/stdout JSON) └──────────────────────┘         └──────────┘
```

브라우저 확장은 직접 프로세스를 실행할 수 없기 때문에, Chrome이 공식 지원하는
[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
방식으로 Mac에 설치된 작은 Python 프로그램(`host/terminal_host.py`)과 통신합니다.
이 호스트가 pty를 열어 로그인 셸을 띄우고, 입출력을 확장으로 중계합니다.
Python 표준 라이브러리만 사용하므로 별도 패키지 설치가 필요 없습니다.

## 기능

- 진짜 셸: 로그인 셸(`-l`)로 실행되어 `~/.zprofile`, `~/.zshrc`, Homebrew PATH 등이 그대로 적용
- 256색/트루컬러, 창 크기 자동 반영(`stty size`, vim/htop 등 정상 동작), 유니코드/한글
- 탭 여러 개(각 탭은 독립된 셸 프로세스), 사이드 패널 모드
- ⌘C/⌘V 복사·붙여넣기, ⌘-클릭으로 링크 열기, 폰트 크기 단축키
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
| `⌘+` / `⌘-` / `⌘0` | 폰트 크기 조절 |
| `⌘-클릭` | 링크를 새 브라우저 탭에서 열기 |

`⌘T`, `⌘W`, `⌘1~9` 등 Chrome이 예약한 단축키는 확장에서 가로챌 수 없어 브라우저 동작이 우선합니다.

설정(툴바 아이콘 우클릭 → 옵션, 또는 터미널 탭의 ⚙)에서 셸 경로, 시작 디렉터리, 테마, 폰트, 커서, Option 키를 Meta로 사용할지, 툴바 버튼이 탭/사이드 패널 중 무엇을 열지 지정할 수 있습니다. 설정 페이지의 **Test connection** 버튼으로 호스트 설치 상태를 확인할 수 있습니다.

## 프로젝트 구조

```
extension/            Chrome 확장 (Manifest V3)
  manifest.json
  background.js       툴바 버튼·단축키 → 탭/사이드 패널 열기
  terminal.html/js    xterm.js 터미널 UI, 탭 관리, 네이티브 포트 연결
  panel.html          사이드 패널용 진입점 (같은 스크립트)
  options.html/js     설정 페이지 + 호스트 연결 테스트
  shared.js           설정 기본값, base64 유틸, 오류 메시지
  vendor/             xterm.js 5.5.0, fit / web-links 애드온 (MIT)
host/
  terminal_host.py    네이티브 메시징 호스트 (pty 생성, 입출력 중계, 크기 조절)
  test_host.py        호스트 프로토콜 스모크 테스트
install.sh            macOS 호스트 등록 스크립트
uninstall.sh
test/e2e_page_test.mjs  headless Chromium으로 확장 페이지 + 실제 호스트 E2E 테스트
```

### 메시지 프로토콜

확장 → 호스트: `spawn {cols, rows, shell?, cwd?}`, `input {data: base64}`, `resize {cols, rows}`, `ping`
호스트 → 확장: `ready {pid, shell, cwd}`, `data {data: base64}`, `exit {code, signal}`, `error {message}`, `pong`

pty 출력은 바이너리이므로 base64로 감싸며, 호스트 → Chrome 메시지 1 MB 제한을 고려해 64 KB 단위로 나눠 보냅니다.

## 테스트

```bash
python3 host/test_host.py          # 호스트만: spawn/echo/resize/유니코드/Ctrl-C/exit 확인
node test/e2e_page_test.mjs        # playwright 필요 (npm i playwright): 실제 페이지 + 실제 호스트
```

## 문제 해결

- **"Native host is not installed"**: `./install.sh`를 다시 실행하고 브라우저를 완전히 종료 후 재시작합니다.
- **"Native host does not allow this extension"**: 확장 ID가 매니페스트의 `allowed_origins`와 다릅니다. `./install.sh --extension-id <ID>`.
- **"Native host failed to start"**: 터미널에서 `host/run_host.sh`를 직접 실행해 보세요. Python이 없다면 `xcode-select --install`.
- 셸이 뜨지만 PATH가 이상하다면 셸 설정 파일(`~/.zprofile`, `~/.zshrc`)을 확인하세요. 호스트는 로그인 셸로 실행하므로 보통 터미널.app과 동일하게 동작합니다.

## 보안 참고

이 확장은 사용자 계정 권한으로 셸을 실행합니다. 네이티브 호스트 매니페스트의 `allowed_origins`에 등록된 확장 ID만 호스트에 접속할 수 있으며, 웹 페이지는 접근할 수 없습니다. 신뢰할 수 있는 컴퓨터에서만 사용하세요.

## 라이선스

이 저장소의 코드는 MIT 라이선스입니다. `extension/vendor/`의 xterm.js는 별도 MIT 라이선스(`LICENSE.xterm`)를 따릅니다.
