# pi-subagent

[README.md](./README.md) — English version

전문 서브에이전트에게 작업을 위임하는 Pi 확장 프로그램입니다. 각 서브에이전트는 별도 `pi` 프로세스에서 독립된 컨텍스트 윈도우로 실행됩니다.

## 주요 기능

- **서브에이전트 자동 발견** — YAML frontmatter가 있는 마크다운 파일로 에이전트를 정의합니다:
  - `~/.pi/agent/agents/*.md` (사용자 수준, 기본 스코프)
  - `.pi/agents/*.md` (프로젝트 수준, cwd에서 가까운 디렉터리로 검색)
- **세 가지 실행 모드**
  - `single`: `{ agent, task }` — 에이전트 1개 실행
  - `parallel`: `{ tasks: [{ agent, task }, ...] }` — 최대 8개 태스크 동시 실행 (동시성 4)
  - `chain`: `{ chain: [{ agent, task }, ...] }` — 순차 실행, 각 단계에서 `{previous}` 플레이스홀더로 이전 단계 결과를 참조
- **실시간 스트리밍** — 서브에이전트 출력은 도구 결과에 스트리밍됩니다 (parallel은 태스크별, chain은 단계별 업데이트)
- **풍부한 TUI 렌더링** — 테마가 적용된 호출/결과 렌더링, 태스크별 토큰/비용 사용량 통계, 도구 호출 미리보기, 마크다운 출력
- **안전장치** — 프로젝트 로컬 에이전트는 레포지토리에서 관리되므로 실행 전에 확인 프롬프트를 표시합니다 (호출마다 `confirmProjectAgents: false`로 비활성화 가능)
- **컨텍스트 상속** — 서브에이전트는 부모 세션의 현재 모델(에이전트가 자체 모델을 지정하지 않은 경우 사고(thinking) 레벨 포함)를 상속합니다
- **타임아웃** — 각 에이전트에 실행 시간 상한이 있습니다 (기본 30분, 호출마다 설정 가능). 한계를 초과하면 프로세스가 종료됩니다 (SIGTERM → SIGKILL)
- **워치독** — 5분 간격으로 각 서브에이전트의 최신 출력을 검사합니다. 오류가 없으면 계속 대기합니다. 검사에서 오류 상태를 발견하면 한 사이클 더 대기하고, 다음 검사에서도 여전히 오류 상태면 프로세스를 종료(SIGTERM → SIGKILL)하여 서브에이전트의 오류 메시지를 실패로 보고합니다
- **출력 truncate** — 방대한 서브에이전트 출력이 부모 컨텍스트 윈도우를 오염시키지 않도록 보호합니다. 최종 출력(single / parallel / chain)은 50 KiB에서 head-truncate되고 생략된 바이트 수를 알리는 마커가 붙습니다. 전체 출력은 도구 디테일(Ctrl+O로 확장)에 보존됩니다. chain의 `{previous}` 치환은 다음 에이전트 프롬프트 부풀림을 막기 위해 32 KiB로 더 엄격하게 제한됩니다
- **`subagent_manager` 도구** — 에이전트 정의 파일 추가/수정/삭제 (`create` / `update` / `delete`, 사용자·프로젝트 스코프의 `.md` 파일 편집)
- **`/subagents` 명령** — 사용 가능한 모든 에이전트와 출처를 목록으로 표시
- **내장 기본 에이전트** — 최초 로드 시 `planner`, `coder`, `websearcher`, `reviewer`, `agentbrowser` 5개의 에이전트를 `~/.pi/agent/agents/`에 자동 설치합니다. 기존 파일은 절대 덮어쓰지 않으며, `PI_SUBAGENT_NO_DEFAULT_AGENTS=1`로 설치를 건너뛸 수 있습니다

## 에이전트 정의 형식

```markdown
---
name: code-reviewer
description: Reviews code changes for bugs and style
tools: [read, grep, bash]      # 선택, 쉼표 문자열 또는 배열
model: anthropic/claude-...    # 선택, 서브에이전트 모델 고정
noContextFiles: true           # 선택, AGENTS.md / 프로젝트 컨텍스트 파일 건너뛰기
---
You are a meticulous code reviewer. Always check for null safety...
```

- `name`과 `description`은 필수입니다.
- `tools`는 서브에이전트가 사용할 수 있는 도구를 제한합니다. **보안 참고:** `tools`를 생략하면 서브에이전트는 기본 도구(read, bash, edit, write)와 확장 도구를 모두 받으며, 비대화적으로 실행되므로 **확인 프롬프트 없이** 실행됩니다. 전체 파일/셸 접근이 필요 없는 에이전트에는 반드시 `tools`를 설정하세요.
- `model`은 특정 모델을 고정합니다. 생략하면 부모 세션의 모델이 사용됩니다.
- `noContextFiles: true`는 `--no-context-files`로 서브에이전트를 시작하여 AGENTS.md / 프로젝트 컨텍스트 파일을 로드하지 않습니다. 완전히 격리된 프롬프트 전용 에이전트에 유용합니다.
- 마크다운 본문은 시스템 프롬프트에 추가로 인젝션됩니다.
- 두 에이전트가 같은 `name`을 선언하면 뒤의 것이 우선됩니다 (`both` 스코프에서 프로젝트가 사용자를 덮어씀) 콘솔에 경고가 출력됩니다.

## 서브에이전트 사용법

설치 후 이 확장 프로그램은 `subagent` 도구를 등록합니다. 자연어로 메인 에이전트에게 위임을 요청할 수도 있고("code-reviewer 에이전트에게 코드 리뷰를 위임해 줘"), 도구를 직접 호출할 수도 있습니다.

### 1. 에이전트 파일 만들기

기본 에이전트 5개는 최초 로드 시 `~/.pi/agent/agents/`에 자동 설치됩니다. 자유롭게 수정 또는 삭제해도 절대 덮어쓰지 않으며, `PI_SUBAGENT_NO_DEFAULT_AGENTS=1`을 설정하면 자동 설치가 비활성화됩니다.

| 에이전트 | 역할 | 도구 |
|---|---|---|
| `planner` | 필요 시 코드베이스 분석 후 단계별 상세 구현 계획 수립 | read, grep, find, ls |
| `coder` | 계획 구현: 코드 수정, 빌드/테스트/lint로 검증 | read, grep, find, ls, edit, write, bash |
| `reviewer` | 코드 변경 사항 리뷰: 버그, 엣지 케이스, 보안 이슈, 테스트 공백 발견 | read, grep, find, ls, bash |
| `websearcher` | 웹 검색 / URL 읽기로 외부 자료 조사 및 구조화 | websearch_searxng_web_search, websearch_web_url_read |
| `agentbrowser` | 브라우저 자동화: 사이트 탐색, 폼 입력, 클릭, 스크린샷, 데이터 추출, 로그인, 웹앱 테스트, Electron 앱 자동화 — 모든 브라우저/웹 상호작용 작업은 이 에이전트에 위임 (`agent-browser` CLI 사용) | bash, read |

전형적인 파이프라인: `planner` → `coder` → `reviewer` (chain 모드로 각 단계가 `{previous}`를 통해 이전 결과를 받도록 구성).

사용자 정의 에이전트는 `~/.pi/agent/agents/`(또는 `.pi/agents/`)에 마크다운 파일을 만들면 됩니다:

```markdown
# ~/.pi/agent/agents/code-reviewer.md
---
name: code-reviewer
description: Reviews code changes for bugs and style
tools: [read, grep]
---
You are a meticulous code reviewer. Always check for null safety...
```

프로젝트 수준 에이전트는 레포지토리 내부의 `.pi/agents/`에 두며, 실행 전에 확인이 필요합니다 (`confirmProjectAgents: false`를 전달하지 않는 한).

### 2. single 모드 — 한 태스크, 한 에이전트

```json
{
  "agent": "code-reviewer",
  "task": "Review src/utils/parse.ts for bugs",
  "cwd": "/path/to/project",      // 선택
  "timeout": 45                   // 선택, 분 단위 (기본 30)
}
```

### 3. parallel 모드 — 최대 8개의 독립 태스크 (동시성 4)

```json
{
  "tasks": [
    { "agent": "code-reviewer", "task": "Review the auth module" },
    { "agent": "test-writer", "task": "Write tests for the payment module" },
    { "agent": "doc-writer", "task": "Update the API docs", "cwd": "/path/to/docs" }
  ]
}
```

태스크끼리 의존성이 없을 때 parallel 모드를 사용합니다. 어떤 태스크라도 실패하면 호출은 에러로 보고되지만, 출력에는 모든 태스크별 결과가 그대로 포함됩니다.

### 4. chain 모드 — 컨텍스트를 공유하는 순차 단계

```json
{
  "chain": [
    { "agent": "researcher", "task": "Summarize the API surface of src/api.ts" },
    { "agent": "doc-writer", "task": "Write documentation based on this summary: {previous}" }
  ]
}
```

각 단계의 결과는 `{previous}`를 배치한 위치에 다음 단계의 태스크로 대체됩니다. 첫 실패한 단계에서 체인이 중단되고, 어느 단계가 실패했는지 보고됩니다.

### 5. 사용 가능한 에이전트 확인

pi 세션에서 `/subagents`를 실행하면 발견된 모든 에이전트와 출처(사용자 vs. 프로젝트)가 목록으로 표시됩니다. 호출 시 `agentScope: "both"`(또는 `"project"`)를 설정하면 프로젝트 로컬 에이전트도 포함되고, `confirmProjectAgents: false`를 설정하면 확인 프롬프트를 건너뜁니다.

### 팁

- **소음이 많은 작업은 격리하세요** — 장시간 탐색 작업(로그 분석, 대규모 리팩터링, 테스트 실행)을 위임하면 메인 세션의 컨텍스트 윈도우를 작게 유지할 수 있습니다.
- **도구를 빡빡하게 지정하세요** — 에이전트 frontmatter에 항상 `tools`를 설정하세요. 서브에이전트는 확인 프롬프트 없이 비대화적으로 실행됩니다.
- **에이전트별로 모델을 고정하세요** — frontmatter의 `model:`로 저렴한/빠른 모델(요약 작업)을 쓰고, 부모 세션은 강력한 모델을 유지할 수 있습니다.
- **`noContextFiles: true` 사용** — AGENTS.md / 프로젝트 컨텍스트를 보지 말아야 하는 완전히 격리된 프롬프트 전용 에이전트에 사용하세요.

### 6. 에이전트 관리 (추가/수정/삭제)

`subagent_manager` 도구가 에이전트 정의 파일을 직접 편집하므로 수동 파일 편집이 필요 없습니다:

```jsonc
// 새로운 사용자 수준 에이전트 생성
{ "action": "create", "name": "reviewer", "scope": "user",
  "description": "버그 여부를 검토하는 리뷰어", "systemPrompt": "You are a reviewer...",
  "tools": ["read", "grep", "find"] }

// 제공한 필드만 수정 (tools: [] 은 도구 목록 초기화, model: "" 은 모델 오버라이드 해제)
{ "action": "update", "name": "reviewer", "scope": "user", "model": "anthropic/claude-sonnet-4-6" }

// 에이전트 삭제
{ "action": "delete", "name": "reviewer", "scope": "user" }
```

참고:
- `scope: "project"` 는 가장 가까운 `.pi/agents/` 디렉터리를 대상입니다 (`create` 시 자동으로 생성).
- `create` 는 `overwrite: true` 를 설정하지 않으면 기존 에이전트를 덮어쓰지 않습니다.
- 새로 만든 에이전트는 재시작 없이 즉시 `subagent` 도구에서 사용할 수 있습니다.

## 도구 파라미터

| 파라미터 | 설명 |
|---|---|
| `agent`, `task` | single 모드 (호출마다 모드는 정확히 하나만) |
| `tasks` | parallel 모드: `{ agent, task, cwd? }` 배열 (최대 8개) |
| `chain` | chain 모드: `{ agent, task, cwd? }` 배열; 태스크의 `{previous}`는 이전 단계의 결과로 대체됨 |
| `agentScope` | `user` (기본), `project`, 또는 `both` |
| `confirmProjectAgents` | 프로젝트 로컬 에이전트 실행 전 확인 프롬프트 (기본 `true`) |
| `timeout` | 에이전트별 최대 실행 시간 (분, 기본 `30`) |
| `cwd` | 에이전트 프로세스의 작업 디렉터리 (single 모드) |

### 실패 의미론

- 프로세스가 0이 아닌 코드로 종료된 경우(OOM 등 신호로 인한 사망 포함), 에이전트가 `error`/`aborted` stop reason을 보고한 경우, 타임아웃에 도달한 경우, 반복 오류로 워치독에 종료된 경우에 태스크는 실패로 간주됩니다.
- **워치독 동작**: 5분마다 각 서브에이전트를 검사합니다. 한 번의 검사에서 오류 상태만 발견되면 한 사이클 더 대기하며, 연속된 검사에서 계속 오류 상태가 확인되면 프로세스를 종료하고 마지막 오류 메시지를 보고합니다.
- parallel 모드에서는 **어떤** 태스크라도 실패하면 호출이 에러(`isError`)로 표시되며, 텍스트 출력에는 여전히 태스크별 결과가 포함됩니다.
- chain 모드에서는 체인이 첫 실패한 단계에서 중단되고, 어느 단계가 실패했는지 보고됩니다.

## 설치

```bash
pi install git:github.com/giocom/pi-subagent
```

로컬 경로에서:

```bash
pi install /path/to/pi-subagent
```

또는 테스트를 위해 직접 실행:

```bash
pi -e ./src/index.ts
```

## 개발

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run check       # typecheck + tests
```

## 라이선스

MIT
