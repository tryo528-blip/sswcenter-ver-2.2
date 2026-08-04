# W1E-A1 Luna Max/Fast 파일럿 2차 테스트 운용서

> 상태: `COMPLETED_NOT_PROMOTED`
> 작성일: 2026-08-01 KST
> 문서 성격: 1회성 제한 실험 운용서. 정본 운영규정이 아님.
> 상위 규정: `docs/AI_업무분담_운영규정_v3.7.md`
> 1차 평가: `review/reports/W1E_A1_LUNA_ALLOCATION_PILOT_EVALUATION_afccd06.md`
> 2차 평가: `review/reports/W1E_A1_LUNA_PILOT_R2_EVALUATION_db5516b.md`

## 1. 실험 목적

2차 파일럿은 다음 세 질문에 각각 답한다.

1. **품질:** Luna writer 1명과 새 별도 작업방의 반복 독립검수로, 동일한 최종
   SHA에서 2회 연속 승인을 얻어 기존 방식과 같거나 더 높은 완성도를 유지할 수
   있는가?
2. **시간:** 긴 문맥 재독과 반복 반려를 줄여 모델 활성 시간과 전체 경과시간을
   1차 파일럿보다 유의미하게 줄일 수 있는가?
3. **비용:** 같은 추론강도·속도에서 사용자가 확인한 25:1 가격 비율의 이점이
   실제 호출 수·token·청구 기록에서도 남는가?

품질·시간·비용 중 하나를 다른 하나로 뭉뚱그려 성공 처리하지 않는다. 세 항목을
분리 판정한다.

## 2. 1차 파일럿에서 고칠 점

1차 파일럿 기준값은 다음과 같다.

| 항목 | 1차 결과 |
|---|---:|
| Luna 작업 | 9개 작업 / 10 turns |
| Luna 활성 시간 | 2h 29m 55.023s |
| 독립검수 반려 | R1~R6, 6회 |
| 최초 패키지 | 1,685줄 |
| 최종 패키지 | 3,409줄 |
| 제품 결과 | Phase-1 RED 승인 |
| 방법 결과 | `NOT_PROMOTE_UNCHANGED` |

2차에서는 다음 실패 원인을 제거한다.

- 3천 줄 전체를 매 검수마다 다시 읽지 않는다.
- mutation corpus를 반려 뒤 한 개씩 추가하지 않고 시작 패킷에 넣는다.
- Regina가 반복적인 의미 수정 writer가 되지 않는다.
- 첫 APPROVE 하나만 골라 종료하지 않으며, 반대로 무제한 검수도 하지 않는다.
  동일 SHA 2회 연속 승인과 최대 2회 보정이라는 명시적 종료조건을 사용한다.
- 실행 불가능한 provider·환경을 오래 탐색하지 않는다.

## 3. 2차 파일럿 대상

### 3.1 제안 대상

첫 적용 후보는 `W1E-A1-G1 STATIC FOUNDATION`이다.

- W1D head의 직속 child인
  `backend/alembic/versions/20260801_0012_w1e_care_assignment.py`
- `backend/app/db/models.py`의 `CareAssignment` ORM
- 승인된 W1E-A1 GENERAL DB/contract RED를 **수정하지 않고** 정적 GREEN으로 전환
- 실 PostgreSQL, service, API, UI, FAMILY, 월별 전문인력, care-change는 비범위

### 3.2 시작 전 크기 판정

writer는 쓰기 전에 예상 변경량과 구현 단위를 보고한다.

- 허용 예상 변경량: **순증 600~900줄 이하**
- 허용 write path: 위 migration 1개와 `backend/app/db/models.py`만
- 기존 RED·plan·packet·정본 문서 수정: 금지

예상 순증이 900줄을 넘거나, migration과 ORM만으로 한 완료조건을 만들 수 없다고
판단되면 제품 파일을 쓰지 않는다. Regina가 범위를 더 작게 재봉인한 뒤 새 파일럿으로
다시 시작한다. 시간 제한을 맞추기 위해 테스트를 약화하거나 제외 범위를 끌어오지 않는다.

## 4. 역할과 독립성

### Regina

- branch·base SHA·dirty state·허용 경로·완료조건을 봉인한다.
- 작업 생성, patch 통합, 시간·token·문제 기록, 최종 상태 판정을 담당한다.
- 제품 의미를 직접 고치지 않는다.
- patch 충돌이 단순 기계 적용을 넘어가면 writer에게 돌려보낸다.
- 마지막 확인은 수행하지만 독립검수 횟수로 세지 않는다.

### Writer

- `gpt-5.6-luna`, reasoning `max`, Fast intent로 실행한다.
- 한 작업방·한 context·한 writer만 사용한다.
- 하위 에이전트와 병렬 writer를 만들지 않는다.
- 허용된 두 경로 외에는 쓰지 않는다.
- 완료조건, 실행 증거, 남은 위험, 정확한 변경 경로를 인계한다.

### 독립검수자

- 사이드바에 보이는 **새 별도 작업방**에서 실행한다.
- clean worktree와 exact candidate SHA를 사용한다.
- read-only이며 수정·stage·commit·push·하위 에이전트를 금지한다.
- writer의 자기평가를 승인 근거로 사용하지 않고 코드·테스트·mutation 출력으로
  독립 판정한다.
- 동일한 Luna 모델을 써도 되지만 제작 대화의 context는 이어받지 않는다.

## 5. 공급자와 모델 봉인

이번 2차 테스트는 Luna 방식 자체를 비교하기 위한 **Luna-first 제한 실험**이다.

```text
MODEL=gpt-5.6-luna
REASONING=max
FAST_INTENT=ON
```

작업 생성 API가 Fast 적용 여부를 직접 노출하지 않으면 다음과 같이 기록한다.

```text
FAST_INHERITED_NOT_INDEPENDENTLY_VERIFIABLE
```

이 실험 중 Claude/OpenRouter/DeepSeek/Grok을 같은 후보의 writer 또는 reviewer로
섞지 않는다. 정상 공급자 순서 실험으로 바꾸려면 파일럿 이름과 비교 기준을 새로
봉인한다.

## 6. 시간 제한

| 단계 | hard cap | 비고 |
|---|---:|---|
| Regina preflight·packet | 5분 | 기존 문서 재전량 읽기 금지 |
| writer | 15분 | 15분이면 현재 결과를 인계하고 중단 |
| Regina 통합·정적 gate | 10분 | 의미 수정 금지 |
| 독립검수 각 회 | 10분 | 최대 R4, 매회 새 작업방 |
| writer 보정 각 회 | 10분 | 최대 2회, 직전 findings만 |

무보정 목표 경로는 writer+독립검수 2회의 모델 활성 시간 **35분 이하**, Regina 포함
전체 **50분 이하**다. 1회 보정 경로는 모델 활성 **55분**, 전체 **70분 이하**,
2회 보정 절대상한은 모델 활성 **75분**, 전체 **90분 이하**다. 한 단계가 cap을
넘으면 그 사실을 숨기지 않고 `TIMEBOX_FAIL`로 기록한다. 초과 뒤 계속 작업해
파일럿 성공으로 바꾸지 않는다.

## 7. 시작 전 preflight

Regina는 다음을 5분 안에 확인한다.

1. 실제 cwd, branch, `PILOT_R2_BASE_SHA`, local/upstream/remote 관계
2. staged·unstaged·untracked 상태와 기존 사용자 WIP
3. 허용 path 두 개의 현재 hash와 migration sole head
4. 검증 interpreter:
   `C:\sswcenter\2.1\backend\.venv\Scripts\python.exe`
5. Luna task 생성 가능 여부와 `max` 설정
6. 현재 W1E 기준 증거:
   - collect 10
   - contract 1 pass + 3 `W1E_PRODUCT_ABSENT`
   - PostgreSQL gate unset 6 skipped
7. writer에게 제공할 bounded evidence index와 mutation 목록

worktree에 venv가 없으면 설치하지 않는다. 검증된 본 checkout interpreter를 절대
경로로 사용한다. 환경 문제를 제품 실패로 계산하지 않는다.

## 8. writer 패킷

writer에게 처음부터 다음을 제공한다.

- exact base SHA와 허용 write path
- `W1E_CARE_ASSIGNMENT_PLAN.md`의 관련 line/marker index
- `test_w1e_contract.py`의 exact migration/ORM 기대값
- migration predecessor `20260730_0011_w1d_recipient_contract`
- 금지 범위와 금지 행위
- 완료 명령과 expected count
- 아래 mutation corpus

writer는 전체 저장소를 탐색하기 전에 evidence index를 사용한다. 필요한 근거가 index에
없을 때만 marker 중심으로 추가 읽기하고 그 경로를 기록한다.

## 9. 시작 시 제공할 mutation corpus

다음 공격면을 reviewer가 사후 발명하지 않도록 패킷에 미리 넣는다.

1. 함수 문자열 속 canonical `CREATE TABLE` decoy + 실제 table column 변이
2. 함수 문자열 속 canonical version update decoy + 실제 top-level update 변이
3. 실제 FK/check/exclusion clause 변이와 unnamed/duplicate constraint
4. extra single-quoted `DO`, duplicate/decorated `COMMIT`
5. 동명 함수·trigger OID 오결속과 executable side effect
6. ORM table/schema, identity/default/computed, FK action, exclusion deferrability 변이
7. CARE_WORKER·연속 qualification·reverse guard·replacement 방향의 정적 계약
8. 범위 밖 FAMILY/API/UI/service object 도입 여부

mutation fixture 자체의 quoting/path 오류는 observer trouble로 따로 기록한다. 성공한
fixture 출력만 제품 판정에 사용한다.

## 10. writer 완료조건

writer 후보는 다음을 모두 만족해야 `READY_FOR_REVIEW`다.

1. 변경 경로가 허용된 migration과 `models.py`뿐이다.
2. 순증이 900줄 이하이며 불가피한 예외는 시작 전에 승인받았다.
3. `test_w1e_contract.py`: 4 passed, exit 0
4. W1E 전체 collect: 10, exit 0
5. `test_w1e_postgres.py` with gate unset: 6 skipped, exit 0
6. Alembic sole head가 정확히 `20260801_0012_w1e_care_assignment`
7. offline `alembic upgrade ... --sql`: exit 0
8. 변경 Python Ruff와 syntax/AST: exit 0
9. `git diff --check`: exit 0
10. 실 PostgreSQL을 실행하거나 GREEN으로 주장하지 않는다.

제품 코드가 존재한 뒤 `W1E_PRODUCT_ABSENT`가 남으면 ready가 아니다. 테스트를 수정해
통과시키는 것도 금지한다.

## 11. 독립검수 절차

각 독립검수는 exact candidate SHA에서 다음 순서로 진행한다.

1. HEAD/ref/base, four-way status, 허용 path, line count 봉인
2. writer 완료 명령을 독립 재실행
3. mutation corpus 중 실제 false-pass 가능성이 큰 항목부터 실행
4. packet/plan과 migration/ORM 의미 비교
5. `APPROVE`, `REJECT`, `BLOCKED` 중 하나로 판정

반려 finding은 P0/P1/P2, exact file:line, 재현 입력, 기대값을 포함한다. 스타일 취향이나
이미 닫힌 동일 질문은 보정 사유가 아니다.

최종 통과조건은 **같은 변경 없는 SHA에 대한 새 독립 작업방 2회의 연속 APPROVE**다.
한 검수라도 REJECT면 그 SHA의 승인 연속횟수는 0이 되고, 기존 writer가 finding
범위만 보정한다. SHA가 바뀌면 이전 APPROVE는 새 후보에 승계되지 않는다.

검수는 최대 R4, writer 보정은 최대 2회다. 정상 경로는 다음 셋 중 하나다.

```text
무보정: R1 APPROVE -> R2 APPROVE -> 통과
1회 보정: R1 REJECT -> repair 1 -> R2 APPROVE -> R3 APPROVE -> 통과
2회 보정: R1 REJECT -> repair 1 -> R2 REJECT -> repair 2
          -> R3 APPROVE -> R4 APPROVE -> 조건부 통과
```

APPROVE와 REJECT를 다수결로 상쇄하지 않는다. 모든 actionable finding을 닫아야 하며,
나중의 승인 하나만 선택해 통과시킬 수 없다. 홀수 검수는 요구사항·계약·증거 결속을,
짝수 검수는 mutation·false-pass·회귀 공격면을 우선하되, 매회 전체 후보에 대한
승인 책임은 유지한다.

두 번 보정한 뒤 다시 REJECT가 나오거나 R4까지 2회 연속 승인을 만들지 못하면 제품을
포기하지 않는다. 파일럿 방법만 `NOT_PROMOTE`로 종료하고, 범위 분할 또는 다음
공급자 escalation으로 제품 완성을 계속한다.

## 12. 즉시 중단 조건

다음 중 하나면 `PILOT_R2_ABORT_OR_SPLIT`이다.

- 예상 또는 실제 순증 900줄 초과
- writer 15분 초과
- 허용 path 밖 의미 변경 필요
- dependency 설치·전역 환경 변경 필요
- RED·plan·packet을 구현에 맞춰 약화해야 함
- 별도 독립 작업방 생성·읽기 불가
- 보정 2회 뒤 추가 REJECT 또는 R4까지 2회 연속 승인 실패
- Regina의 의미 수정 없이는 후보가 성립하지 않음
- 보안·권한·개인정보·동시성의 새 HIGH/BLOCKER가 범위를 넓힘

중단은 실패 기록이지 임의 승인이나 무한 재시도의 근거가 아니다.

## 13. 측정 원장

각 단계마다 다음을 한 행으로 기록한다.

| 필드 | 필수 내용 |
|---|---|
| task | 작업 ID와 역할 |
| runtime | model, reasoning, Fast 확인 상태 |
| time | started/completed/active/wall time |
| size | 시작·종료 line count, net delta |
| tokens | input, cached input, output, reasoning, total |
| cost | 실제 청구액 또는 공급자 과금 근거 |
| evidence | command, cwd, exit, count, marker |
| findings | writer 자기발견 / 독립검수 신규발견 분리 |
| trouble | 재실행, quoting, path, 환경, handler, 사람 개입 |
| seal | candidate SHA, status, cleanup |

task API가 token·비용을 노출하지 않으면 `NOT_EXPOSED`라고 쓴다. 25:1 가격표만으로
실제 절감액을 확정하지 않는다. 무보정 경로 3 turns는 단순 proxy
`3/25 = 0.12 Sol-call`, 최대 경로 7 turns는 `7/25 = 0.28 Sol-call`로 별도
표시할 수 있다.

## 14. 최종 판정

### 품질

- `QUALITY_PASS`: scoped gate 전부 통과, unresolved P0/P1 없음, 동일 SHA 독립 승인
  2회 연속
- `QUALITY_FAIL`: false pass, 계약 누락, test 약화, unresolved P0/P1

### 시간

- `TIME_PASS`: 무보정 또는 1회 보정, 모델 활성 55분/전체 70분 이내
- `TIME_CONDITIONAL`: 2회 보정, 모델 활성 75분/전체 90분 이내
- `TIME_FAIL`: 위 cap 초과 또는 중단 뒤 계속 실행

### 비용

- `COST_PASS`: 비교 가능한 실제 과금에서 기존 기준보다 낮음
- `COST_PROVISIONAL`: 가격 proxy는 낮지만 실제 과금 미노출
- `COST_FAIL`: 재호출·context 재독으로 실제 총비용이 기준 이상

### 방법

- `PROMOTE_BOUNDED`: QUALITY_PASS + TIME_PASS + COST_PASS/PROVISIONAL,
  역할·독립성 위반 0
- `REPEAT_ONCE`: 품질은 통과했으나 시간 또는 비용 표본이 불충분
- `NOT_PROMOTE`: 품질 실패, 시간 실패, 승인 2회 연속 실패, 보정 2회 초과,
  Regina 의미 수정, 범위 위반

## 15. 고정 결과 마커

```text
PILOT_R2_WRITER_RESULT=READY_FOR_REVIEW|TIMEBOX_STOP|BLOCKED
PILOT_R2_INDEPENDENT_R1_RESULT=APPROVE|REJECT|BLOCKED
PILOT_R2_INDEPENDENT_R2_RESULT=APPROVE|REJECT|NOT_USED|BLOCKED
PILOT_R2_INDEPENDENT_R3_RESULT=APPROVE|REJECT|NOT_USED|BLOCKED
PILOT_R2_INDEPENDENT_R4_RESULT=APPROVE|REJECT|NOT_USED|BLOCKED
PILOT_R2_REPAIR_1_RESULT=READY|NOT_USED|BLOCKED
PILOT_R2_REPAIR_2_RESULT=READY|NOT_USED|BLOCKED
PILOT_R2_APPROVAL_STREAK=0|1|2
PILOT_R2_REPAIR_CYCLES=0|1|2
REGINA_PILOT_R2_QUALITY_RESULT=PASS|FAIL
REGINA_PILOT_R2_TIME_RESULT=PASS|CONDITIONAL|FAIL
REGINA_PILOT_R2_COST_RESULT=PASS|PROVISIONAL|FAIL
REGINA_PILOT_R2_METHOD_RESULT=PROMOTE_BOUNDED|REPEAT_ONCE|NOT_PROMOTE
LIVE_POSTGRES=NOT_RUN
```

## 16. 종료와 다음 gate

2차 파일럿은 정적 foundation까지만 판정한다. 승인되더라도 다음을 주장하지 않는다.

- W1E runtime GREEN
- W1E 전체 완료
- W1 완료

후속 실 PostgreSQL은 별도 슬라이스로 봉인하고 shared harness를 `workers=1`로 한 번만
실행한다. 제품 bytes가 바뀌면 2차 파일럿의 독립승인을 새 후보에 재사용하지 않는다.

## 17. 실행 후 판정과 다음 실험 보정

이 절은 실행 당시의 규칙을 소급 변경하지 않는 사후 기록이다. 2차 파일럿은 제품
후보 `db5516be1487f84ebd870ccb9e45f4ae0b8745d8`에서 두 번째 보정 뒤 R3가 다시
반려하여 종료했다. R4를 실행해도 같은 SHA의 2회 연속 승인을 만들 수 없으므로 만들지
않았다.

```text
REGINA_PILOT_R2_QUALITY_RESULT=FAIL
REGINA_PILOT_R2_TIME_RESULT=FAIL
REGINA_PILOT_R2_COST_RESULT=PROVISIONAL
REGINA_PILOT_R2_METHOD_RESULT=NOT_PROMOTE
```

다음 별도 파일럿에는 아래 보정을 시작 조건으로 반영한다.

1. 무결성 함수와 trigger가 많은 migration은 순증 600~900줄이라는 숫자만으로 작은
   슬라이스로 보지 않는다. table/ORM, 정방향 guard, 역방향 guard·downgrade를
   독립 invariant family로 나누고, 한 writer 후보는 원칙적으로 순증 300줄 안팎을
   목표로 한다.
2. 제품 writer 전에 RED/harness hardening 슬라이스를 둔다. OLD key를 잃는
   reparent/rekey, 계약 service-type 전환, PERIOD_FACT self/active-row link를 mutation
   corpus에 포함하고 실제 false pass가 닫힌 뒤 제품 구현을 시작한다.
3. reviewer가 새 false pass를 찾으면 제품 코드만 즉시 고치지 않는다. 별도 RED owner가
   재현 test를 먼저 봉인하고, 같은 writer가 그 test를 통과시키며, 새 SHA를 다시
   독립검수한다. reviewer와 제품 writer는 test를 수정하지 않는다.
4. 시간은 모델의 자기보고가 아니라 작업 API의 active duration을 정본으로 삼고,
   dispatcher가 hard cap에서 실제 종료·분할한다. 초과한 결과를 이어서 성공으로
   전환하지 않는다.
5. 새 작업방은 독립검수의 필요조건일 뿐 strict blind의 충분조건이 아니다. strict
   blind 실험은 공유 memory를 읽지 않도록 명시하고, 읽었으면 독립이되 비맹검으로
   공개한다.
6. 홀수·짝수 검수의 우선순위는 유지하되 둘 다 전체 후보 승인 책임을 진다. 반복 횟수를
   늘리는 대신 시작 mutation과 evidence binding을 강화한다.
7. 실제 token/cache/output 또는 청구 export가 없으면 비용 결과는 계속
   `PROVISIONAL`이다.

상세 단계별 시간, finding, trouble과 다음 gate는 2차 평가 보고서를 따른다.
