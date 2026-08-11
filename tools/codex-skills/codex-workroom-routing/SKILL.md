---
name: codex-workroom-routing
description: Parse Korean route aliases such as 집-코덱스-그록 or 사무실-클로드-딥시크, select the operator/writer workflow, prepare independent grade-based test and review workrooms, and apply the current Codex/Claude model matrix. Use when the user asks to route, open, configure, dispatch, test, review, rename, or document these workrooms.
---

# Codex 작업방 라우팅

장소·오퍼레이터·라이터를 하나의 명시적 라우팅 키로 해석하고, 등급별 테스트·검수 작업방과 최종검수 경로를 준비한다. 라우팅은 계획과 실행을 분리하고, 확인되지 않은 실행 파일·경로·등급 스위치를 추측하지 않는다.

## 1. 참조와 우선순위

1. 이 스킬을 트리거한 뒤 [사용 설명서](references/usage-guide.md)를 읽고 현재 등급표와 모델 매트릭스를 적용한다.
2. 현재 사용자가 명시한 최신 override를 가장 우선한다. 이전 설정으로 조용히 되돌리지 않는다.
3. 저장소 운영 기준이 필요하면 `E:\sswcenter\00-오케스트레이션-작업지침.md`를 먼저 확인한다. 파일이 없거나 읽을 수 없으면 `UNKNOWN/BLOCKED`로 보고하고 다른 문서를 정식 기준으로 가장하지 않는다.
4. 현재 checkout/worktree, 기준 SHA, dirty 상태, writable owner/path를 확인한다. 원본 WIP를 reset, clean, checkout, overwrite하지 않는다.

## 2. 호출 문법

`<장소>-<오퍼레이터>-<라이터>`를 세 토큰으로 파싱한다.

| 토큰 | 허용 값 |
|---|---|
| 장소 | `집`, `사무실` |
| 오퍼레이터 | `코덱스`, `클로드` |
| 라이터 | `그록`, `딥시크` |

예: `집-코덱스-그록`, `사무실-클로드-딥시크`.

- 토큰이 빠졌거나 둘 이상의 의미로 해석되면 추측하지 말고 `BLOCKED`와 필요한 선택지를 출력한다.
- 라이터는 항상 정확히 하나만 선택한다. 실패한 라이터를 다른 라이터로 자동 대체하지 않는다.
- bare alias는 기본적으로 dry-run/계획으로 처리한다. 실제 worktree 생성·dispatch는 사용자가 `실행`, `열어`, `생성`, `배정`처럼 명시할 때만 수행한다.

## 3. 실행 전 확인

다음 순서로 확인하고 결과를 계획에 포함한다.

1. 장소에 해당하는 머신 프로필과 프로젝트 경로를 확인한다.
2. 오퍼레이터와 라이터의 실제 executable/connector 경로를 확인한다. 경로가 비어 있거나 실행할 수 없으면 해당 장소에서 멈추고 `BLOCKED`로 보고한다.
3. 현재 wrapper가 모델·effort·fast·grade를 실제로 받을 수 있는지 검사한다. 지원하지 않는 flag를 만들어 내지 않는다. 등급별 flag가 없으면 등급과 모델을 orchestration metadata와 handoff에 기록한다.
4. 기준 저장소의 SHA와 worktree 목록을 확인한다. 각 방의 owner, writable path, branch/worktree 정책을 먼저 적는다.
5. 실행 전에는 `PLAN`을 출력한다. 계획에는 route, writer, 방 1–6, 최종검수, 검증 명령, 예상 산출물을 포함한다.

## 4. 라우팅 규칙

### 코덱스 오퍼레이터

- 라이터는 그록 또는 딥시크 중 하나만 사용한다.
- 테스트 1–3과 검수 4–6을 각각 독립 worktree로 준비한다.
- 각 방에는 [사용 설명서](references/usage-guide.md)의 grade/model/effort/fast 조합을 그대로 붙인다.
- 최신 규칙상 방 3(5등급 테스트)은 `gpt-5.6-sol`, `max`, `fast on`이다.
- 최종 독립검수는 Claude Opus 5, `ultra`, `fast off`로 지정한다. 현재 환경의 Claude wrapper가 다른 버전만 제공하면 대체하지 말고 `BLOCKED/UNAVAILABLE`로 표시한다.

### 클로드 오퍼레이터

- 라이터는 그록 또는 딥시크 중 하나만 사용한다.
- 테스트와 검수는 등급표에 따라 Codex 방으로 배정한다.
- 최종검수는 `gpt-5.6-sol`, `ultra`, `fast off`로 지정한다.

## 5. 독립 작업방과 안전 경계

- 방 1–6은 서로 별도의 Codex 관리 worktree/task로 만든다. 원본 checkout은 보존한다.
- coordinator는 다른 방의 dirty WIP를 합치거나 정리하지 않는다.
- 구현·테스트·검수의 writable owner를 분리하고, 검수 방은 read-only 경계를 유지한다.
- 사용자가 명시하지 않은 stage, commit, push, dependency 설치, DB reset, destructive cleanup을 하지 않는다.
- 실행 결과는 `PASS`, `FAIL`, `BLOCKED`, `UNKNOWN` 중 하나로 닫고, `BLOCKED`이면 원인·미실행 게이트·다음 필요한 입력을 적는다.

## 6. 소단위 lifecycle과 새 독립방

- W2를 W1A/W1B/W1C/W1D처럼 소단위로 나누어 관리한다. 소단위 완료는 코드 변경만 끝난 시점이 아니라 테스트·독립검수·인수인계·승인 게이트가 닫힌 시점이다.
- 소단위가 `PASS`로 닫히면 다음 소단위 시작 전에 **새로운 독립 작업방 세트**를 만든다. 이전 room/thread/worktree를 다음 소단위에 재활용하거나 reset해서 쓰지 않는다.
- 새 세트는 승인된 이전 소단위의 기준 SHA에서 새 worktree/thread ID로 만들고, 장소·오퍼레이터·라이터·등급별 model/effort/fast·보고 의무를 다시 주입한다.
- 이전 소단위의 방은 삭제하거나 덮어쓰지 않는다. 결과·로그·diff·handoff의 증거로 보존하고, 필요하면 archive만 한다.
- 다음 세트를 만들기 전에 `unit_id`, `previous_unit_id`, `base_sha`, `room_generation`, `fresh_worktree=true`를 계획과 각 방의 첫 보고에 적는다.
- 소단위가 `FAIL`/`BLOCKED`이면 새 소단위 방을 만들어 문제를 숨기지 않는다. 현재 세트에서 operator 판단으로 범위 내 수정·제한 재시도를 진행하고, 다음 소단위로 넘어갈지 여부만 중요 결정으로 분리한다.

## 7. 출력 형식

항상 아래를 짧게 보고한다.

1. `route`: 장소 / 오퍼레이터 / 라이터
2. `mode`: `PLAN` 또는 `EXECUTE`
3. `rooms`: 방 번호, grade, model, effort, fast, owner/worktree
4. `final_review`: 모델, effort, fast, 실제 사용 가능 여부
5. `evidence`: 확인한 경로·SHA·명령·exit code
6. `status`: PASS/FAIL/BLOCKED/UNKNOWN 및 unverified 항목
7. `unit_lifecycle`: unit_id, previous_unit_id, base_sha, room_generation, fresh_worktree

계획이나 확인만 끝났다면 실제 실행·테스트·검수 완료라고 표현하지 않는다.
