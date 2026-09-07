# AI Recovery Prompt

이 파일은 저장소가 손상되었거나 빌드/동작이 깨졌을 때, AI coding agent(Claude Code, Codex, Hermes, Cursor 등)에게
그대로 붙여넣어 **완전 복구**를 시키기 위한 프롬프트이다.

---

## 복구 프롬프트 (아래 블록을 AI에게 그대로 전달)

```
너는 이 저장소(task-beacon)의 복구 엔지니어다. 아래 절차와 제약을 따라 완전히 복구하라.

[프로젝트 정체]
- VS Code extension "Task Beacon" (publisher: YangKangSung). 사이드바에 TODO/Jira/Grafana/크론
  현황을 보여주는 대시보드 extension.
- 언어/도구: TypeScript + esbuild 번들링. 진입점 src/extension.ts -> esbuild.js가
  dist/extension.js로 번들. 런타임 의존성 없음(devDependencies만 존재).
- 핵심 파일: package.json(manifest + contributes 전체), esbuild.js, tsconfig.json, src/ 20개 파일.
- UI는 전부 Webview HTML string 기반(panelView/tableView/summaryView/settingsView 등).
  프레임워크 없음. Chart는 resources/beacon.svg + 인라인 JS.

[복구 절차 — 순서대로 실행하고 각 단계 실패 시 원인 분석 후 수정]
1. npm install
2. npx tsc -p tsconfig.json --noEmit   -> exit 0 확인. 타입 에러 나면 수정.
3. npm run build                        -> dist/extension.js 생성 확인.
4. npm run package                      -> *.vsix 생성 확인 (vsce, --allow-missing-repository).
5. code --install-extension <vsix> 후 F5(Extension Development Host)에서:
   - 사이드바 "Task Beacon" 아이콘 4개(비콘/표/그래프/ 크론) 렌더링
   - 설정 패널이 열리고 저장 시 에러 없음
   빌드+패키징까지 통과하면 복구 성공으로 간주.

[의도적으로 비워둔 설정 — 버그가 아니다]
public 배포판은 사내/개인 인프라 값을 의도적으로 제거했다. 절대 임의의 사내 URL을
다시 하드코딩하지 말 것. 전부 사용자 settings(taskBeacon.* )로 주입되는 구조가 정상:
- taskBeacon.jira.baseUrl: 기본값 "" -> 미설정 시 Jira 기능은 안내 메시지 후 비활성.
  Jira 연동 스크립트(show_todo.py)가 있는 경우 SHOW_TODO_* env override는
  src/fetchTodo.ts의 jiraEnvOverrides를 통해 주입된다.
- taskBeacon.litellmBaseUrl: AI 기능용. 미설정 시 AI health 뷰는 빈 목록 + 안내 표시.
  모델 목록은 정적 하드코딩이 아니라 프록시 /model/info 동적 탐지(discoverModels,
  src/aiConfig.ts)다. 프록시가 없으면 빈 목록이 정상 동작이다.
- taskBeacon.llmWikiRoot: 기본값 "" -> 미설정 시 TODO wiki fetch는 명시적 에러 가드.
- updateCheck.ts: github.com이면 api.github.com, 그 외 호스트는 /api/v3(GHES) 자동 분기.
  이 분기 로직을 단순 github.com 고정으로 되돌리지 말 것.

[제약]
- package.json의 publisher("YangKangSung")와 name("task-beacon")을 바꾸지 말 것(vsce 서명/식별자). Marketplace id는 YangKangSung.task-beacon.
- resources/icon.png, resources/beacon.svg는 manifest가 참조하므로 삭제/이름변경 금지.
- .github/workflows/build.yml는 CI 스모크(tsc+build) — 삭제하지 말 것.
- .github/workflows/vsce-publish.yml는 Marketplace 게시(kampff와 동일: VSCE_PAT, version 비교 후 publish). 삭제하지 말 것.
- git 히스토리는 단일 스냅샷으로 시작한다. 과거 히스토리 복원 시도는 불필요.
- 복구 후 반드시 2~4단계 검증을 다시 실행하여 통과를 확인하고, 변경 요약을 보고하라.
```

---

## 사용법

1. 저장소를 클론한다.
2. 위 프롬프트 블록 전체를 AI agent에게 전달한다.
3. agent가 검증(타입체크/빌드/패키징) 통과를 보고하면 복구 완료.

## 정상 상태 기준선 (복구 목표)

| 검사 | 기대 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0, 에러 0건 |
| `npm run build` | `dist/extension.js` 생성 |
| `npm run package` | `task-beacon-<version>.vsix` 생성 |
| 사내 URL 문자열 | 사내/개인 인프라 도메인명 grep 0건 (의도된 상태) |
