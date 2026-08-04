# W1E-A1 reverse-guard RED hardening 패킷

> 상태: `READY_FOR_DISPATCH`
> 작성일: 2026-08-01 KST
> 위험등급: `HIGH` — 직접 SQL 갱신으로 활성 배정 무결성이 깨지는 경계
> 제품 기준 후보: `db5516be1487f84ebd870ccb9e45f4ae0b8745d8`
> 평가 근거: `review/reports/W1E_A1_LUNA_PILOT_R2_EVALUATION_db5516b.md`

## 1. 목표

R3가 찾은 세 P1을 제품 수정 전에 실행형 RED로 고정한다.

1. CARE_WORKER position fact의 staff/employment reparent가 OLD key의 활성 GENERAL
   배정을 orphan으로 만들면 거부
2. qualification fact의 staff/employment/service-type rekey가 OLD key의 활성 GENERAL
   배정을 orphan으로 만들면 거부
3. recipient contract의 service-type 전환으로 기존 GENERAL 배정의 qualification
   coverage가 사라지면 거부

현재 제품 후보에서 이 세 경계가 **제품 결함 때문에** 실패하고, 기존 W1E 계약은
약화되지 않아야 한다. 이 패킷은 RED/harness만 만든다. 제품 migration/model을 함께
고치지 않는다.

## 2. 이번 슬라이스의 비범위

- `care_assignment` PERIOD_FACT self-link/active-old/new-link 정책 결정과 구현
- 제품 migration 또는 ORM 수정
- 실 PostgreSQL 실행
- service/API/UI/FAMILY/monthly/care-change
- 기존 migration 0001~0012 수정
- dependency 설치, 전역 환경 변경

PERIOD_FACT P2는 설계 문구가 DB 강제까지 요구하는지 먼저 판정해야 하므로 다음 별도
설계·RED 슬라이스로 남긴다. 세 P1과 섞어 범위를 다시 키우지 않는다.

## 3. 실행 봉인

dispatch prompt가 다음 값을 정확히 제공한다.

```text
DISPATCH_BASE_SHA=<packet commit exact SHA>
PRODUCT_CANDIDATE_SHA=db5516be1487f84ebd870ccb9e45f4ae0b8745d8
BRANCH=codex/w1e-assignment
WRITER_PROVIDER=Claude Code / Opus
WRITER_EFFORT=high
WRITER_TIMEBOX=15m
LIVE_POSTGRES=NOT_RUN
```

writer는 별도 clean detached worktree에서 시작한다. 실제 cwd, HEAD, branch/ref,
staged·unstaged·untracked 상태와 아래 두 제품 blob이 제품 후보와 같은지 먼저
확인한다.

- `backend/alembic/versions/20260801_0012_w1e_care_assignment.py`
- `backend/app/db/models.py`

## 4. 역할과 허용 경로

### 단일 RED writer

- 허용 write path:
  - `backend/tests/test_w1e_contract.py`
  - `backend/tests/test_w1e_postgres.py`
- 새 작업·하위 에이전트·병렬 writer를 만들지 않는다.
- stage, commit, push를 하지 않는다.
- 기존 제품 결함을 test에서 흉내 내거나 expected marker를 약화하지 않는다.
- 15분이면 현재 상태와 blocker를 인계하고 중단한다.

### Regina

- 범위·SHA·시간·diff를 봉인하고 patch를 기계적으로 통합한다.
- RED 의미를 직접 작성·수정하지 않는다.
- writer 결과를 독립 승인으로 세지 않는다.

### 독립검수자

- writer와 다른 사용자 표시 작업방·새 context·clean worktree·exact candidate SHA에서
  read-only로 검수한다.
- 공유 project memory를 읽지 않는 strict-blind 조건을 사용한다.
- 수정, stage, commit, push, 하위 에이전트, 실 PostgreSQL을 금지한다.

## 5. 현재 기준 증거

packet 작성 직전 `C:\sswcenter\2.1`에서 확인한 값이다.

```text
HEAD=34acbe8180b37e924b7510954b147112531fbbde
LOCAL_UPSTREAM_REMOTE=MATCH
WORKTREE=CLEAN
CONTRACT=4 passed, exit 0
COLLECT=10 tests, exit 0
PG_GATE_UNSET=6 skipped, exit 0
LIVE_POSTGRES=NOT_RUN
```

정적 PASS는 제품 승인 근거가 아니다. 아래 새 RED가 없는 현재 harness가 세 P1을 놓치는
baseline이다.

## 6. 정적 RED 계약

`backend/tests/test_w1e_contract.py`에 세 경계를 각각 독립 test로 추가한다. 기존 네
test를 합치거나 삭제하지 않는다.

권장 test ID와 exact failure marker는 다음과 같다.

| test ID | 현재 후보 expected marker |
|---|---|
| `test_w1e_04_position_reverse_guard_preserves_old_key` | `W1E_REVERSE_POSITION_OLD_KEY_UNSEALED` |
| `test_w1e_05_qualification_reverse_guard_preserves_old_key` | `W1E_REVERSE_QUALIFICATION_OLD_KEY_UNSEALED` |
| `test_w1e_06_contract_service_transition_rechecks_qualification` | `W1E_REVERSE_CONTRACT_SERVICE_TYPE_UNSEALED` |

검사는 migration source의 임의 문자열 검색이 아니라 offline SQL에서 이미 결속된 정확한
top-level function body를 사용한다. comment, single-quoted literal, 다른 동명 함수,
unreachable decoy의 `OLD` 토큰으로 통과하지 않아야 한다.

최소 의미는 다음과 같다.

1. position reverse guard는 reparent/update 뒤 사라질 수 있는 OLD
   `staff_id`·`employment_id` key의 활성 GENERAL 배정을 재검사한다.
2. qualification reverse guard는 OLD `staff_id`·`employment_id`·`service_type_id`
   key의 활성 GENERAL 배정을 재검사한다.
3. contract reverse guard는 `service_type_id` 전환을 인식하고 NEW 계약 service에 대한
   `staff_service_qualification_period` 연속 coverage를 다시 검사한다.

test가 특정 공백이나 변수명만 강제하지 않도록 semantic token group과 bound body를
사용한다. 반대로 단순히 `OLD`라는 문자열 하나만 요구해서도 안 된다.

## 7. gated PostgreSQL RED

`backend/tests/test_w1e_postgres.py`에는 세 독립 runtime test를 추가한다. module gate는
그대로 유지하고 import/collection에서 engine이나 connection을 만들지 않는다.

1. `test_w1e_pg_position_reparent_rejects_old_key_orphan`
   - A의 유효 GENERAL 배정을 만든다.
   - position row를 DB상 유효한 다른 staff/employment key로 옮긴다.
   - deferred constraint flush에서
     `CARE_ASSIGNMENT_POSITION_ORPHAN_FORBIDDEN`, SQLSTATE `23514`를 기대한다.
2. `test_w1e_pg_qualification_rekey_rejects_old_key_orphan`
   - A의 유효 GENERAL 배정을 만든다.
   - qualification row의 service type을 다른 유효 service로 바꾼다.
   - `CARE_ASSIGNMENT_QUALIFICATION_ORPHAN_FORBIDDEN`, SQLSTATE `23514`를 기대한다.
3. `test_w1e_pg_contract_service_transition_rechecks_qualification`
   - A의 HOME_CARE GENERAL 배정과 HOME_CARE qualification을 만든다.
   - contract를 HOME_BATH로 바꾸되 A에게 HOME_BATH coverage를 주지 않는다.
   - `CARE_ASSIGNMENT_CONTRACT_ORPHAN_FORBIDDEN`, SQLSTATE `23514`를 기대한다.

각 음성 사례는 savepoint/기존 `_expect_violation()` 경계를 사용해 뒤 test state를
오염시키지 않는다. unrelated FK·exclusion·W1A guard가 먼저 발생한 것을 W1E marker로
오인하지 않는다.

## 8. RED 완료조건

현재 제품 후보에서 다음을 모두 만족해야 writer `READY`다.

1. 변경 경로가 두 test 파일뿐이다.
2. `test_w1e_contract.py -q`가 **정확히 3 failed, 4 passed**이며 세 exact marker가
   각각 한 번 나타난다.
3. 두 test 파일 collect가 **16 tests**, exit 0이다.
4. `SSWCENTER_W1E_REAL_PG` unset에서 PostgreSQL 파일이 **9 skipped**, exit 0이다.
5. 새 runtime test source에 세 direct-SQL mutation과 exact message/SQLSTATE가 존재한다.
6. Ruff와 read-only `compile()`이 exit 0이다.
7. `git diff --check`가 exit 0이다.
8. 제품 두 blob은 시작값과 동일하다.
9. 실 PostgreSQL을 실행하거나 GREEN으로 주장하지 않는다.

contract command의 nonzero는 세 expected RED에 한해서만 성공 증거다. collection,
syntax, import, helper 오류나 기존 네 test 실패는 harness failure다.

## 9. 완료 명령

검증 interpreter는 설치 없이 다음 절대 경로를 사용한다.

```text
C:\sswcenter\2.1\backend\.venv\Scripts\python.exe
```

```powershell
Remove-Item Env:SSWCENTER_W1E_REAL_PG -ErrorAction SilentlyContinue
& 'C:\sswcenter\2.1\backend\.venv\Scripts\python.exe' -m pytest backend/tests/test_w1e_contract.py -q
# expected product RED: 3 failed, 4 passed; exact three W1E_REVERSE_* markers

& 'C:\sswcenter\2.1\backend\.venv\Scripts\python.exe' -m pytest backend/tests/test_w1e_contract.py backend/tests/test_w1e_postgres.py --collect-only -q
# expected: 16 collected, exit 0

& 'C:\sswcenter\2.1\backend\.venv\Scripts\python.exe' -m pytest backend/tests/test_w1e_postgres.py -q
# expected with gate unset: 9 skipped, exit 0

& 'C:\sswcenter\2.1\backend\.venv\Scripts\python.exe' -m ruff check backend/tests/test_w1e_contract.py backend/tests/test_w1e_postgres.py

@'
from pathlib import Path

for path in (
    "backend/tests/test_w1e_contract.py",
    "backend/tests/test_w1e_postgres.py",
):
    compile(Path(path).read_text(encoding="utf-8"), path, "exec")
'@ | & 'C:\sswcenter\2.1\backend\.venv\Scripts\python.exe' -

git diff --check
```

## 10. 인계 marker

```text
W1E_A1_REVERSE_RED_WRITER_RESULT=READY|TIMEBOX_STOP|BLOCKED
W1E_A1_REVERSE_RED_BASE_SHA=<sha>
W1E_A1_REVERSE_RED_CONTRACT_RESULT=3_FAILED_4_PASSED|HARNESS_FAIL
W1E_A1_REVERSE_RED_COLLECT=16
W1E_A1_REVERSE_RED_PG_GATE_UNSET=9_SKIPPED
W1E_A1_REVERSE_RED_CHANGED_PATHS=<exact list>
W1E_A1_REVERSE_RED_PRODUCT_BLOBS=UNCHANGED|MISMATCH
LIVE_POSTGRES=NOT_RUN
```

시작·종료 KST, API/관측 가능 시간, 명령별 cwd·exit·count, expected RED marker,
자기발견 trouble, 남은 위험을 함께 보고한다. `READY`는 writer 완료일 뿐 독립 승인이나
제품 GREEN이 아니다.
