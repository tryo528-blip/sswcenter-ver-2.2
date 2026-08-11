# 작업방 라우팅 사용 설명서

이 문서는 `$codex-workroom-routing`의 호출법, 등급표, 방 배정, 실행 경계를 설명한다. 스킬이 트리거되면 라우팅 결정을 내리기 전에 이 문서를 읽는다.

## 1. 가장 짧은 사용법

형식:

```text
<장소>-<오퍼레이터>-<라이터>
```

예시:

```text
집-코덱스-그록
집-코덱스-딥시크
사무실-클로드-그록
사무실-클로드-딥시크
```

처음에는 계획만 만든다.

```text
집-코덱스-그록 계획
```

실제 독립 작업방 생성·배정까지 요청할 때만 명시적으로 실행한다.

```text
집-코덱스-그록 실행
```

`그록 또는 딥시크`라고만 하면 둘 다 실행하지 말고 하나를 선택해 달라고 요청한다. 장소·오퍼레이터·라이터 중 하나라도 빠지면 `BLOCKED`로 닫는다.

## 2. 등급 범위

### 테스트

| 등급 | 범위 | 기본 모델 | effort | fast | 실행 경계 |
|---|---|---|---|---|---|
| 1 | 정적·문법·import·compile·smoke | gpt-5.3-codex-spark | xhigh | off | read-only, network off |
| 2 | 제한된 unit/component/contract | gpt-5.3-codex-spark | xhigh | off | read-only, network off |
| 3 | 격리 PostgreSQL/DB integration | gpt-5.6-luna | max | on | workspace-write, network on |
| 4 | API/frontend/service/E2E | gpt-5.6-luna | max | on | workspace-write, network on |
| 5 | 운영·복구·migration lifecycle·security·최종 acceptance | gpt-5.6-sol | max | on | workspace-write, network on |

### 검수

| 등급 | 범위 | 기본 모델 | effort | fast | 실행 경계 |
|---|---|---|---|---|---|
| 1 | focused review | gpt-5.6-luna | max | on | read-only |
| 2 | accuracy·regression·test adequacy | gpt-5.6-luna | max | on | read-only |
| 3 | cross-layer·data flow·integration·edge | gpt-5.6-sol | xhigh | on | read-only |
| 4 | architecture·security·concurrency·recovery·ops | gpt-5.6-sol | xhigh | on | read-only |
| 5 | final adversarial acceptance | gpt-5.6-sol | ultra | off | read-only |

`방 3`은 테스트 5등급 방을 뜻한다. 현재 override는 `gpt-5.6-sol / max / fast on`이며, 과거의 `xhigh`를 사용하지 않는다.

## 3. 코덱스 오퍼레이터 방 배정

코덱스가 오퍼레이터이면 라이터 하나를 선택하고 다음 여섯 개의 독립 worktree/task를 준비한다.

| 방 | 역할 | 등급 | 조합 |
|---|---|---|---|
| 1 | 테스트 | 1–2 | Spark / xhigh / fast off |
| 2 | 테스트 | 3–4 | Luna / max / fast on |
| 3 | 테스트 | 5 | Sol / max / fast on |
| 4 | 검수 | 1–2 | Luna / max / fast on |
| 5 | 검수 | 3–4 | Sol / xhigh / fast on |
| 6 | 검수 | 5 | Sol / ultra / fast off |

최종 독립검수:

```text
Claude Opus 5 / ultra / fast off
```

실제 Claude 실행 파일이 Opus 5가 아니면 Opus 4-8 등으로 조용히 대체하지 않는다. `UNAVAILABLE` 또는 `BLOCKED`를 보고한다.

## 4. 클로드 오퍼레이터 방 배정

클로드가 오퍼레이터이면 라이터 하나를 선택한다. 테스트와 검수 방은 위 등급표를 기준으로 Codex에 배정하고, 최종검수는 다음으로 지정한다.

```text
gpt-5.6-sol / ultra / fast off
```

구체적인 방 수·worktree 생성 여부는 사용자의 실행 지시와 현재 프로젝트 운영 문서에 따른다. 코덱스 방 배정표를 클로드 경로에 자동으로 뒤집어 적용하지 않는다.

## 5. 실행 전 체크리스트

- [ ] `E:\sswcenter\00-오케스트레이션-작업지침.md` 존재·내용·최신성을 확인했는가?
- [ ] 장소의 머신 프로필과 프로젝트/worktree 경로를 확인했는가?
- [ ] 오퍼레이터와 라이터 executable/connector가 실제로 존재하는가?
- [ ] office 경로가 비어 있으면 home 경로로 fallback하지 않았는가?
- [ ] 현재 저장소 SHA와 dirty WIP를 보존하는가?
- [ ] 실제 wrapper가 요구한 model/effort/fast/grade를 지원하는가?
- [ ] wrapper에 grade flag가 없으면 grade/model을 handoff metadata로 기록했는가?
- [ ] 각 방의 owner, writable path, read-only 경계를 적었는가?
- [ ] 최종검수 모델의 실제 버전을 확인했는가?

검증되지 않은 항목이 하나라도 있으면 실행 대신 `BLOCKED/UNKNOWN` 계획을 출력한다.

## 6. 보고서 예시

```text
route: 집 / 코덱스 / 그록
mode: PLAN
rooms:
  1 테스트 1–2 | gpt-5.3-codex-spark | xhigh | fast off
  2 테스트 3–4 | gpt-5.6-luna       | max   | fast on
  3 테스트 5   | gpt-5.6-sol         | max   | fast on
  4 검수 1–2   | gpt-5.6-luna         | max   | fast on
  5 검수 3–4   | gpt-5.6-sol          | xhigh | fast on
  6 검수 5     | gpt-5.6-sol          | ultra | fast off
final_review: Claude Opus 5 | ultra | fast off
status: BLOCKED (실행 파일/기준 문서 미확인)
unverified: office profile, wrapper grade flags
```

실제 명령·경로·SHA·exit code를 확인하지 않았다면 `PASS`나 “테스트 완료”라고 쓰지 않는다.

## 7. 현재 wrapper와의 차이 처리

현재 wrapper가 `-SimpleTest`, `-Effort`, `-Fast`만 제공하고 `TestGrade`/`ReviewGrade` 스위치를 제공하지 않을 수 있다. 이 경우:

1. 스킬이 방 번호·등급·요구 모델을 외부 orchestration plan에 기록한다.
2. wrapper에 없는 flag를 전달하지 않는다.
3. wrapper가 실제로 실행한 모델·effort·fast를 결과에서 다시 읽는다.
4. 요청 조합과 실제 조합이 다르면 `FAIL` 또는 `BLOCKED`로 닫고 자동 보정하지 않는다.

## 8. W2 소단위가 끝난 뒤 방을 새로 만드는 규칙

W2는 한 덩어리로 계속 같은 방을 쓰지 않는다. W1A/W1B/W1C/W1D처럼 명확한 소단위를 정의하고, 한 소단위가 테스트·독립검수·인수인계·승인까지 닫히면 다음 소단위용 새 방 세트를 만든다.

예시:

```text
W2-A 완료(PASS) → 기존 방 1–6 보존 → W2-B용 새 방 1–6 생성
```

새 세트의 규칙:

- 이전 room/thread/worktree를 reset하거나 재활용하지 않는다.
- 승인된 이전 소단위의 기준 SHA에서 새 독립 worktree/task를 만든다.
- 새 방마다 장소·오퍼레이터·라이터, 등급표의 model/effort/fast, 보고 의무를 다시 전달한다.
- 이전 방은 결과·로그·diff·handoff 증거로 보존한다. 삭제 대신 필요할 때만 archive한다.
- 첫 계획과 첫 보고에 `unit_id`, `previous_unit_id`, `base_sha`, `room_generation`, `fresh_worktree=true`를 적는다.
- 소단위가 FAIL/BLOCKED이면 다음 소단위 방을 먼저 만들어 덮지 않는다. 현재 방에서 operator가 범위 안의 최소 수정·제한 재시도를 판단하고, 소단위 전환 여부만 중요 결정으로 분리한다.
