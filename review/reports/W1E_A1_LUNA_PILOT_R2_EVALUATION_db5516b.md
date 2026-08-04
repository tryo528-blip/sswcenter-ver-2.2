# W1E-A1 Luna Max/Fast 파일럿 2차 평가

- 평가일: 2026-08-01 KST
- base SHA: `6447a3422efd84695c5e80ed187331139ef62d47`
- 최종 제품 후보: `db5516be1487f84ebd870ccb9e45f4ae0b8745d8`
- 브랜치: `codex/w1e-assignment`
- 모델: `gpt-5.6-luna`, reasoning `max`, Fast intent
- 범위: W1E-A1 GENERAL care-assignment migration/ORM 정적 foundation
- 실 PostgreSQL: `NOT_RUN`

## 1. 결론

2차 파일럿은 정해둔 중단 조건까지 실행했고, 방법은 **승격하지 않는다**.

저렴한 모델을 여러 번 독립 실행하는 방식은 실제 결함 탐지력을 보여줬다. R1~R3가
정적 gate를 통과한 후보에서 서로 다른 무결성 결함을 계속 찾아냈다. 그러나 두 번의
writer 보정 뒤에도 R3에서 P1 3건이 남았고, 같은 SHA의 독립 APPROVE는 한 번도
없었다. writer·R1·R3는 단계별 hard cap도 초과했다.

따라서 이번 결과는 “싼 반복 검수가 품질을 올릴 수 있다”는 가설의 **탐지 측면**은
지지하지만, “기존 방식보다 완성도를 유지·향상하면서 시간과 비용을 줄였다”는 전체
가설은 입증하지 못한다. 현재 제품 후보는 `STATIC_REJECT`이며 W1E runtime GREEN,
W1E 완료, W1 완료를 주장하지 않는다.

```text
PILOT_R2_WRITER_RESULT=READY_FOR_REVIEW
PILOT_R2_INDEPENDENT_R1_RESULT=REJECT
PILOT_R2_INDEPENDENT_R2_RESULT=REJECT
PILOT_R2_INDEPENDENT_R3_RESULT=REJECT
PILOT_R2_INDEPENDENT_R4_RESULT=NOT_USED
PILOT_R2_REPAIR_1_RESULT=READY
PILOT_R2_REPAIR_2_RESULT=READY
PILOT_R2_APPROVAL_STREAK=0
PILOT_R2_REPAIR_CYCLES=2
REGINA_PILOT_R2_QUALITY_RESULT=FAIL
REGINA_PILOT_R2_TIME_RESULT=FAIL
REGINA_PILOT_R2_COST_RESULT=PROVISIONAL
REGINA_PILOT_R2_METHOD_RESULT=NOT_PROMOTE
LIVE_POSTGRES=NOT_RUN
```

## 2. 후보 봉인과 변경량

제품 후보의 흐름은 다음과 같다.

| 단계 | main 후보 SHA | 의미 |
|---|---|---|
| 파일럿 base | `6447a3422efd84695c5e80ed187331139ef62d47` | 운용서·패킷 준비 완료 |
| 최초 writer 통합 | `2701cb6555deb846104efe56dbe146b7da0a2118` | 정적 foundation 최초 구현 |
| repair 1 통합 | `78a8bd56e83cf8a8044361efaadbcd5bc1e560e4` | qualification coverage polarity 보정 |
| repair 2 통합 | `db5516be1487f84ebd870ccb9e45f4ae0b8745d8` | downgrade의 qualification child 복원 |

base 대비 최종 제품 변경은 허용된 두 경로뿐이다.

| 경로 | 삽입 | 삭제 |
|---|---:|---:|
| `backend/alembic/versions/20260801_0012_w1e_care_assignment.py` | 514 | 0 |
| `backend/app/db/models.py` | 87 | 1 |
| 합계 | 601 | 1 |

순증은 정확히 600줄이다. 이 보고서와 운용 문서의 사후 부록을 넣는 문서 commit은
제품 바이트를 바꾸지 않으며, 독립검수 판정 대상 SHA는 계속 `db5516b`다.

## 3. 작업·시간 원장

writer 보정은 최초 writer와 같은 작업방에만 보냈고, 검수는 매번 새 사용자 표시
작업방과 별도 worktree에서 수행했다. 하위 에이전트나 제작방 자기검수는 독립검수로
세지 않았다.

| 단계 | 작업 ID | API active | cap | 결과 |
|---|---|---:|---:|---|
| 최초 writer | `019fba88-a62e-7312-8dac-337d528efb56` | 15m 14.206s | 15m | READY, `TIMEBOX_FAIL` 14.206s 초과 |
| 독립 R1 | `019fba99-587a-74a3-80d0-0843d4701b41` | 10m 02.036s | 10m | REJECT, `TIMEBOX_FAIL` 2.036s 초과 |
| repair 1 | writer와 동일 | 2m 17.827s | 10m | READY |
| 독립 R2 | `019fbaa6-d76b-76c0-aa7f-10f28db8583e` | 8m 38.063s | 10m | REJECT |
| repair 2 | writer와 동일 | 3m 00.588s | 10m | READY |
| 독립 R3 | `019fbab4-7229-7a00-9eae-ca01f13c4a05` | 10m 28.016s | 10m | REJECT, `TIMEBOX_FAIL` 28.016s 초과 |
| 독립 R4 | 생성하지 않음 | 0 | 10m | `NOT_USED` |
| 합계 | 4개 작업, 6 turns | **49m 40.736s** | 2회 보정 절대상한 75m | 단계별 cap 위반 |

작업방이 자기보고한 시간과 API duration이 다른 경우 API 값을 정본으로 사용했다.
총 active time은 75분 안이지만, writer 15분 초과가 즉시 중단 조건이었고 독립검수
2회도 각 10분을 초과했다. 초과 뒤 실행을 계속했으므로 시간 판정은 `FAIL`이다.

R3 반려 시점에는 보정 2회를 모두 썼다. R4에서 APPROVE를 받아도 연속 승인 횟수는
1뿐이어서 통과가 수학적으로 불가능했다. 운용서의 중단 규칙에 따라 R4를 만들지 않은
것은 누락이 아니라 정상 종료다.

## 4. 반려와 수리의 흐름

### R1 — 정방향 qualification polarity

최초 후보의 GENERAL 서비스자격 guard는 `NOT EXISTS(... AND NOT coverage)` 형태여서
완전 coverage를 거부하고 gap을 통과시키는 반대 극성이었다. R1은 이를 P1으로
반려했고, repair 1은 한 줄의 `NOT EXISTS`를 `EXISTS`로 바꿨다.

### R2 — downgrade와 정적 false pass

repair 1 후보의 downgrade는 공유
`fn_staff_employment_child_periods_reverse_guard()`를 position과 operational-role만
포함한 더 오래된 상태로 복원했다. 0011에 이미 있던
`staff_service_qualification_period` branch를 잃는 P1이었다. repair 2는 해당 branch
14줄을 복원했다.

R2는 동시에 현재 정적 계약이 trigger 이름은 확인하지만 target/event/function
결속의 일부를 충분히 공격하지 못한다는 P2 false-pass 위험도 기록했다. 실 PostgreSQL
gate가 꺼진 상태라 이 검증 공백은 runtime 증거로 상쇄되지 않았다.

### R3 — OLD key 전환과 PERIOD_FACT

repair 2 후보는 모든 정적 완료 명령을 통과했지만 R3가 다음을 찾았다.

1. **P1 qualification rekey:** migration 321~341의 역방향 guard가 `NEW.staff_id`,
   `NEW.employment_id`, `NEW.service_type_id`만 본다. HOME_CARE 자격 fact를 HOME_BATH로
   바꾸면 OLD HOME_CARE key에 의존한 활성 GENERAL 배정이 orphan 되어도 검사 대상에서
   사라진다. 기대 오류는 `CARE_ASSIGNMENT_QUALIFICATION_ORPHAN_FORBIDDEN`, SQLSTATE
   `23514`다.
2. **P1 position reparent:** migration 289~304도 NEW staff/employment만 본다.
   CARE_WORKER position fact를 다른 유효 staff/employment로 옮기면 OLD key의 배정이
   orphan 되어도 `CARE_ASSIGNMENT_POSITION_ORPHAN_FORBIDDEN`이 발생하지 않는다.
3. **P1 contract service-type transition:** migration 219~227의 계약 역방향 guard는
   무효화와 기간 포함만 검사한다. 계약의 `service_type_id` 변경으로 기존 GENERAL
   배정의 qualification coverage가 사라지는 경우를 거부하지 않는다.
4. **P2 PERIOD_FACT enforcement:** replacement self-FK의 존재와 정상 old-to-new 흐름은
   확인하지만 self-link, 활성 old-row link, 새 행의 non-NULL replacement를 DB가
   금지한다는 음성 증거가 없다. runtime test 1779~1824도 정상 흐름만 검사한다.

앞의 P1 3건은 ORM 사용 여부와 무관하게 direct SQL UPDATE로 무결성을 깨뜨릴 수 있는
실제 제품 결함이다. P2는 설계 문구가 DB constraint까지 요구하는지 해석 여지가 있어
P1으로 올리지는 않았지만, 다음 RED에서 명시적으로 결정하고 공격해야 한다.

## 5. Regina 최종 정적 증거

최종 제품 후보 `db5516b`에서 Regina가 다시 확인한 결과다.

- `test_w1e_contract.py`: 4 passed, exit 0, 약 3.97s
- W1E collect: 10 collected, exit 0
- `SSWCENTER_W1E_REAL_PG` unset: 6 skipped, exit 0
- Alembic sole head: `20260801_0012_w1e_care_assignment`
- Ruff: exit 0
- source `compile()` read-only syntax gate: exit 0
- `git diff --check`: exit 0
- process-scoped dummy URL의 offline upgrade: exit 0, 2,410 lines, table/revision/W1D-to-W1E marker 확인
- offline downgrade `0012:0011`: exit 0, 101 lines
- downgrade 공유 guard count: position 1, operational-role 1, qualification 1,
  care-assignment 0
- 제품 candidate와 worktree seal: 일치·clean
- 실 PostgreSQL: `NOT_RUN`

이 결과는 정적 harness가 요구한 형태를 충족한다는 뜻이지, R3가 재현한 의미 결함을
무효화하지 않는다. 즉 “정적 gate PASS”와 “제품 승인”을 분리한다.

## 6. 품질 판정

`QUALITY_FAIL`이다.

좋았던 점은 분명하다. 독립검수 3회가 각각 polarity, downgrade 회귀, OLD-key mutation
누락을 찾아 같은 작업방의 자기검수보다 높은 탐지력을 보였다. 특히 R3는 모든 기존
정적 gate가 통과한 뒤에도 서로 다른 direct-SQL integrity gap 세 개를 찾아 반복
독립검수의 실질적 가치를 입증했다.

그러나 품질 성공 조건은 “결함을 많이 찾음”이 아니라 “actionable P0/P1이 없고 같은
SHA에서 2회 연속 승인”이다. 최종 승인 0회, 연속 승인 0회, unresolved P1 3건이므로
완성도 유지·향상을 달성했다고 판정할 수 없다.

## 7. 시간·비용 판정

### 시간

총 Luna active time 49m 40.736s는 1차 파일럿의 2h 29m 55.023s보다 크게 줄었다.
하지만 2차의 단계별 hard cap은 실제 분할 강제 장치였고 writer·R1·R3가 이를 넘었다.
특히 601-line migration에 8개 function target과 7개 trigger target을 함께 맡긴 것이
순증 숫자에 비해 의미 밀도가 높았다. 따라서 `TIME_FAIL`이다.

### 비용

Luna는 총 6 turns였다. 사용자가 확인한 동일 추론강도·속도의 25:1 가격 비율을 단순
호출 proxy로 적용하면 `6/25 = 0.24 Sol-call` 상당이다. 운용서 최대 경로 7 turns의
`0.28`보다도 낮다.

그러나 task API가 billable input, cached input, output, reasoning token과 실제 청구액을
노출하지 않았다. 긴 migration을 매 검수자가 다시 읽은 비용도 호출 수 proxy에는
반영되지 않는다. 따라서 비용은 `PROVISIONAL`이며 실제 절감 성공으로 확정하지 않는다.

## 8. 독립성 판정

R1~R3는 모두 writer와 다른 사용자 표시 작업방, 새 context, 별도 clean worktree,
exact candidate SHA에서 read-only로 수행했다. 이 의미에서는 독립검수다.

다만 R3는 프롬프트가 prior review context를 주지 않았음에도 공유 project memory를
읽었고, 그 내용을 후보 omission 가능성으로만 사용한 뒤 현재 byte에서 다시
도출했다고 밝혔다. finding 자체는 Regina가 현재 migration과 계약에서 독립 재검증해
유효하지만, **별도 작업방이 strict blind를 자동 보장하지는 않는다**. R3는
`INDEPENDENT_SEPARATE_ROOM_NONBLIND_DISCLOSED`로 기록한다.

Fast는 작업 생성 설정에서 상속한 의도였으나 API가 실제 적용 필드를 노출하지 않아
`FAST_INHERITED_NOT_INDEPENDENTLY_VERIFIABLE`이다.

## 9. trouble 원장

다음 문제는 제품 finding과 분리하되 파일럿 시간·운용 평가에는 포함한다.

### 준비·조정

- 준비 증거를 읽는 첫 PowerShell 명령에서 `Math.Min` 인자형 오류가 났고 marker 중심
  읽기로 재수집했다.
- Windows에서 Unix-style `*.py` wildcard를 `rg`에 넘겨 OS error 123이 났고 정확한
  디렉터리 경로로 재실행했다.
- `list_projects`, `list_threads`, `wait_threads` handler가 없어 project ID는 앱의
  global-state에서 read-only로 회수했고, 생성된 작업은 task/session index와
  `read_thread`로 추적했다.
- `send_message_to_thread`가 `No handler registered`를 반환했지만 `read_thread`로
  실제 전달과 repair 시작을 확인해 중복 dispatch하지 않았다.
- `read_thread` handler가 한 번 일시 실패했고 재시도에서 성공했다. 한 번은
  `maxOutputCharsPerItem=24000`이 허용 최대 20000을 넘어 입력 검증에서 거절됐다.
- R2 생성은 먼저 queued `clientThreadId`로 돌아왔고 session index에서 실제 작업을
  찾아 계속 추적했다.

### writer·review observer

- 최초 writer에서 PowerShell line-continuation parse, 큰 patch anchor mismatch,
  Ruff I001, SQLAlchemy naming-convention double prefix, identity NOT NULL 정적 parser
  충돌, Alembic wrong-cwd가 발생했다. writer가 raw SQL table DDL과 정정 명령으로
  수렴시켰다.
- R1 observer에는 한글 encoding garble, `py_compile` NUL 문제, SHA typo가 있었다.
- R2 첫 pytest는 경로가 중복돼 exit 4였고, 첫 offline downgrade는 revision range를
  생략해 exit -1이었다. `.env*` 검색 exit 1은 기대한 “없음” 결과였다.
- repair 1의 polarity observer는 regex escaping 오류, repair 2의 trigger observer는
  JavaScript string escaping 오류가 있었고 성공한 재관측만 판정에 사용했다.

### 통합·최종화

- 첫 cherry-pick은 추정한 full SHA로 `bad object`가 났다. writer task에서 exact commit
  SHA를 다시 읽은 뒤 성공했다.
- 최초 offline Alembic은 패킷에 `SSWCENTER_DATABASE_URL` 준비가 없어 실패했다.
  process-scoped dummy URL을 설정해 실제 DB 접속 없이 재실행했고 원래 값을 복원했다.
- PowerShell이 인용하지 않은 `@{u}`를 hash literal로 해석한 parse 오류가 통합 및
  최종 문서화 상태 확인에서 재발했다. 두 경우 모두 read-only였고 `'@{u}'`로
  재실행했다.
- 작업방 자기보고 시간과 API duration이 달랐다. 모든 판정은 API 값을 사용했다.
- token·실제 비용 필드는 `NOT_EXPOSED`였다.

위 observer·handler 문제는 제품 바이트를 바꾸지 않았고, 재실행 여부를 숨기지 않았다.

## 10. 방법을 다듬는 규칙

다음 파일럿은 호출 횟수를 늘리기 전에 입력과 슬라이스를 바꾼다.

1. **RED 먼저 강화:** OLD-key reparent/rekey, contract service-type transition,
   PERIOD_FACT self/active/new-link 음성 사례를 executable RED에 먼저 추가한다.
2. **invariant family 분할:** table/ORM, forward guards, reverse guards·downgrade를 한
   writer에게 동시에 주지 않는다. 한 후보는 순증 300줄 안팎을 목표로 한다.
3. **false-pass repair 순서:** reviewer가 새 false pass를 찾으면 별도 RED owner가
   재현 test를 먼저 봉인한다. 그 다음 기존 writer가 제품만 고치고 새 SHA를 만든다.
4. **기계적 timebox:** API active duration을 정본으로 삼고 dispatcher가 hard cap에서
   작업을 실제 종료한다. 사람·모델 자기보고로 cap을 완화하지 않는다.
5. **strict blind 명시:** 새 reviewer에는 공유 memory 비사용을 명시하고, 사용 시
   nonblind로 공개한다. 별도 작업방과 strict blind를 같은 말로 취급하지 않는다.
6. **검수 책임 유지:** 홀수는 계약/evidence, 짝수는 mutation/regression을 우선하되
   매회 전체 후보 승인 책임은 유지한다. APPROVE 다수결은 사용하지 않는다.
7. **안전한 완료 명령:** process-scoped dummy URL, offline upgrade+downgrade count,
   read-only `compile()`를 다음 패킷의 기본 명령으로 둔다.
8. **비용 증거:** provider 청구 export나 token/cache/output가 없으면 가격 비교 결론을
   내리지 않는다.

핵심 학습은 “저렴한 독립검수를 여러 번 돌리면 결함 발견은 늘어난다”이다. 그러나
review 횟수 자체가 완성도를 만들지는 않는다. 시작 RED의 공격력과 한 번에 맡기는
의미 범위가 수렴 시간과 실제 비용을 더 크게 좌우한다.

## 11. 다음 제품 gate

이 파일럿 안에서 세 번째 repair나 R4를 이어가지 않는다. 다음 작업은 새 봉인으로
진행한다.

1. R3 P1 3건과 PERIOD_FACT 해석을 executable RED/mutation으로 먼저 고정
2. 기존 writer 계열이 허용된 제품 경로만 보정
3. 새 후보 SHA에서 독립검수 2회 연속 APPROVE
4. 정적 승인 뒤 별도 실 PostgreSQL 슬라이스를 `workers=1`로 한 번 실행

그 전까지 `db5516b`의 상태는 `W1E_A1_STATIC_REJECT_UNRESOLVED_P1`이다.
