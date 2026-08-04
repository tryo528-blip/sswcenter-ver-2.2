# W1E-A1 Luna Max/Fast 업무분담 파일럿 평가

- 평가일: 2026-08-01 KST
- 제품 RED 후보: `afccd06025f859640b82015f456cec558d90cf0f`
- 기준 SHA: `122f428f088a739abca4abe6a388049739de8cb8`
- 브랜치: `codex/w1e-assignment`
- 평가 범위: W1E-A1 GENERAL `care_assignment` 설계 패킷과 Phase-1 실행형 RED
- 실 PostgreSQL: `NOT_RUN`

## 1. 결론

두 결과를 분리한다.

1. 제품 RED 후보는 독립 작업방 R7에서 승인됐다. 실제 최상위 SQL 결속,
   제약조건, 함수 본문, ORM exclusion 변이를 독립 재현했고 후보 SHA와
   작업공간이 끝까지 일치했다.
2. 업무분담 파일럿은 현재 형태 그대로 승격하지 않는다. 독립검수 덕분에 품질은
   높아졌지만, 최초 writer 이후 여섯 번 연속 반려됐고 Luna 활성 시간만
   `2h 29m 55.023s`가 들었다. 최초 1,685줄 패키지는 최종 3,409줄로
   1,724줄, 약 102.3% 커졌다.

따라서 기존 `docs/AI_업무분담_운영규정_v3.7.md`를 바꾸지 않는다. 이 파일럿은
그 문서의 10~15분 분할 규칙과 한 번의 수리 수렴 규칙이 필요한 이유를 재확인한
사례다.

```text
REGINA_W1E_A1_PRODUCT_RESULT=PHASE1_RED_APPROVED
REGINA_W1E_A1_ALLOCATION_PILOT_RESULT=NOT_PROMOTE_UNCHANGED
```

`PHASE1_RED_APPROVED`는 제품 구현 또는 runtime GREEN이 아니다. 0012 migration과
`CareAssignment` 모델이 의도적으로 없으므로 계약 실행은 `W1E_PRODUCT_ABSENT`
3건을 내는 상태가 정답이다.

## 2. 후보 봉인과 범위

후보는 다음 네 파일만 기준 SHA 위에 추가한다.

| 파일 | 최종 추가 줄 |
|---|---:|
| `backend/tests/test_w1e_contract.py` | 1,106 |
| `backend/tests/test_w1e_postgres.py` | 1,826 |
| `review/packets/W1E_ASSIGNMENT_PACKET_v1.0.md` | 162 |
| `review/plans/W1E_CARE_ASSIGNMENT_PLAN.md` | 315 |
| 합계 | 3,409 |

포함 범위는 GENERAL 배정, 수급자 계약 내부 기간, 복합 employment, CARE_WORKER
position, 계약 서비스에 대한 연속 자격, 동일 계약·동일 직원의 활성 기간 중복
금지, 부모 역방향 guard, 그리고 stable-id PERIOD_FACT 교정이다. 교정 방향은
`old.replacement_assignment_id -> new.id`이며 새 행의 replacement link는 `NULL`이다.

FAMILY 동작, ASG-03/ABS-11, 월별 전문인력, 방문·삭제·ABS-12, API/UI/service,
제품 migration/model 구현, 실DB GREEN은 제외했다.

## 3. 공급자 순서 실행 기록

사용자가 정한 순서대로 선행 공급자를 확인한 뒤 Luna fallback으로 전환했다.

| 순서 | 경로 | 관측 결과 |
|---:|---|---|
| 1 | Claude Code Opus | 첫 실행은 환경 전달 전에 실패했다. 명시적 stdin으로 재시도한 실행은 약 616.4초 뒤 429 session limit로 끝났고 변경은 없었다. runner 추정치는 `$5.1086075`, 28 turns였다. |
| 2 | OpenRouter | 현재 준비된 경로에 workspace-edit runner가 없어 호출하지 않았다. |
| 3 | direct DeepSeek `deepseek-chat` | 약 104.1초, 5 turns/11 tools, 104,236 tokens를 관측했지만 patch를 만들지 못했다. |
| 4 | Grok | 주간 한도 0% 상태여서 호출하지 않았다. |
| 5 | Luna Max | `gpt-5.6-luna`, reasoning `max`로 writer와 별도 독립 검수방을 실행했다. |

Claude와 DeepSeek 선행 시도만 약 12분이 추가됐다. 이 시간은 아래 Luna 활성 시간에
포함하지 않았다. Fast 의도는 앱 설정에서 상속됐지만 작업 생성 API가 별도 Fast
필드를 노출하지 않아 독립적으로 입증할 수 없었다.

## 4. Luna 작업과 수렴 비용

모든 검수는 제작 대화의 자기검수나 하위 에이전트가 아니라 새 사용자 표시 작업방,
새 context, 깨끗한 worktree에서 수행했다.

| 단계 | 작업 ID | 활성 시간 | 결과 |
|---|---|---:|---|
| 최초 writer와 같은 writer 방의 1차 보정 | `019fb8d7-0a5d-7c43-ab6c-8e6cdf406c9e` | 35m 48.174s | 네 파일 작성; 초기 결함 보정 |
| 독립 R1 | `019fb904-4ad0-7180-9639-ecdffef94d23` | 11m 55.486s | REJECT, 6 findings |
| 별도 repair writer | `019fb910-8adc-7533-8bc9-a6578a1b7b41` | 26m 10.122s | READY, `+957/-108` |
| 독립 R2 | `019fb92d-f033-75f2-bb67-7af10a89b5a0` | 14m 46.170s | REJECT |
| 독립 R3 | `019fb947-7a63-7821-9e26-8ae19305830b` | 9m 48.787s | REJECT |
| 독립 R4 | `019fb95f-d84a-7760-aa6f-f58169c2feff` | 11m 50.288s | REJECT |
| 독립 R5 | `019fb96d-dab1-75d0-884c-cb230a0c557b` | 11m 52.717s | REJECT |
| 독립 R6 | `019fb97b-151e-7fd3-88ef-5fbfc458d4c8` | 16m 53.114s | REJECT |
| 독립 R7 | `019fb990-4467-7381-a344-f516aac3839a` | 10m 50.165s | APPROVE |
| 합계 | 9개 작업, 10 turns | **2h 29m 55.023s** | 최종 수렴 |

이 시간은 Regina의 patch 통합·수정·재검증 시간과 공급자 선행 시도를 제외한 값이다.
비교 기준인 W1D Luna 파일럿의 기록은 40m 45s였으므로 W1E의 Luna 활성 시간은
약 3.68배다. 두 슬라이스의 난이도가 같지는 않지만, 이번 목표였던 시간 단축을
입증하기에는 반대 방향의 결과다.

최초 후보 `6484315`는 1,685줄이었다. 최종 후보는 3,409줄이며, 중간 후보는
2,534 -> 2,979 -> 3,239 -> 3,280 -> 3,325줄로 커졌다. 반복 검수마다 전체
패키지를 다시 읽는 비용도 함께 증가했다.

## 5. 독립검수가 실제로 막은 결함

독립방은 형식적 절차가 아니라 실제 false pass를 차단했다.

- R1은 계약 경계 fixture가 exclusion에 먼저 걸리는 문제, employment guard의
  비독립 증명, 복합 FK·PERIOD_FACT·역방향 guard·제외 범위 누락을 찾았다.
- R2는 dead/no-op employment decoy, 허용된 `ALTER TABLE` 범위 우회, catalog와
  ORM의 비정확 검증, 부분 문자열 error 판정을 찾았다.
- R3는 trigger OID가 아닌 동명 최신 함수 본문을 읽는 문제, quoted/dynamic SQL과
  unnamed constraint 우회, extra trigger, ORM default/computed/identity 누락,
  다중 qualification fact의 연속 양성 사례 누락을 찾았다.
- R4는 허용된 추가 single-quoted `DO`, 중복·변형 version `UPDATE`, `COMMIT`
  문장이 통과하는 문제를 찾았다.
- R5는 실제 최상위 version update가 틀려도 함수 문자열 속 canonical update를
  정답으로 세는 우회를 재현했다.
- R6는 함수 문자열 속 canonical table body를 실제 table보다 먼저 선택하는
  우회와 ORM exclusion deferrability 누락을 재현했다.
- R7은 실제 최상위 table/constraint/function과 ORM exclusion에 결속된 최종
  수정을 독립 변이로 승인했다.

품질은 독립검수 때문에 유지·향상됐다. 반대로 같은 제작방의 자기검수로 끝냈다면
초기 후보 또는 중간 후보의 P1 false pass가 그대로 정본이 됐을 가능성이 높다.

## 6. 비용 판정

사용자가 제공한 동일 추론강도·속도 기준 25:1 가격 비율은 요금 전제로 인정한다.
단순 호출 수 proxy로는 10 Luna turns가 `10/25 = 0.40` Sol-call 상당이므로 가격
이점이 있을 가능성은 높다.

그러나 이번 작업 API는 Luna 각 turn의 billable input/cache/output과 실제 청구액을
노출하지 않았다. 패키지가 두 배로 커졌고 매 라운드 전체 재독이 발생했으며,
R2 이후 여러 수리는 Regina가 직접 수행했다. 따라서 실제 월 5만원 운전 가능성이나
Sol 1회 대비 절감률은 이 기록만으로 확정할 수 없다.

결론은 `COST_LIKELY_LOWER_BUT_NOT_PROVEN`이다. 가격표 배수만으로 파일럿 성공을
선언하지 않는다.

## 7. 실행·문제 기록

다음 문제를 숨기지 않고 파일럿 비용에 포함해 판단한다.

- 최초 Luna worktree에는 `.venv`/pytest/Ruff가 없어 writer의 첫 collect가
  실행되지 않았다. 이후 본 checkout의 검증된 interpreter를 명시했다.
- writer 초안은 날짜, CARE_WORKER guard, replacement 방향, domain error 경계를
  보정해야 했다.
- repair patch 통합 중 한 번 hunk context가 맞지 않아 적용되지 않았고, 실제
  변경 0건을 확인한 뒤 다시 적용했다.
- R4 작업 생성 첫 시도는 `projectId` 위치가 잘못돼 인자 검증에서 거절됐고 새
  작업은 만들어지지 않았다. 올바른 인자로 한 번만 다시 생성했다.
- 일부 PowerShell 묶음 명령은 의도된 nonzero exit가 뒤 observer 출력을 가렸고,
  root-relative probe path와 inline Python quoting 오류가 있었다. 각각 명령을
  분리하거나 절대 경로를 사용해 재실행했다.
- R6/R7 mutation fixture 작성 중 observer-only 문법·quoting 실패가 있었지만
  제품 파일은 바뀌지 않았고, 최종 판정은 성공한 독립 출력만 사용했다.
- Fast는 명시적 의도였지만 API에서 독립 검증할 수 없었다.
- 실 PostgreSQL은 이 Phase-1 범위에서 실행하지 않았다.
- 최초 push는 성공해 원격 SHA가 만들어졌지만 저장소의 좁은
  `remote.origin.fetch`에 W1E refspec이 없어 첫 `@{u}` 검증이 실패했다. nullable
  upstream 값이 섞인 첫 product-diff 명령도 잘못 조합돼 Git usage와 exit 129를
  냈으며 제품 변경은 없었다. W1E 브랜치 한 줄만 fetch refspec에 추가하고 fetch한
  뒤 local/upstream/remote 검증을 다시 수행했다. fetch가 기존 W1C remote-tracking
  ref도 갱신했지만 현재 branch와 worktree bytes는 바뀌지 않았다.

## 8. 최종 증거

Regina와 R7이 각각 확인한 현재 증거는 다음과 같다.

- exact candidate SHA: `afccd06025f859640b82015f456cec558d90cf0f`;
- W1E collect: 10 tests, exit 0;
- W1E contract: 1 pass + 정확히 3 `W1E_PRODUCT_ABSENT`, exit 1;
- W1E PostgreSQL gate unset: 6 skipped, exit 0, no connection;
- canonical synthetic offline SQL: PASS;
- quoted canonical table decoy + 실제 `assignment_kind VARCHAR`: REJECT;
- 실제 FK/check/exclusion 및 함수 결속 변이: REJECT;
- canonical synthetic ORM: PASS;
- deferrable/deferred ORM exclusion: `W1E_ORM_EXCLUSION_DEFERRABILITY_MISMATCH`;
- Ruff와 `git diff --check`: exit 0;
- 기존 W1D 정적/비접속 gate: 10 passed, 20 skipped, exit 0;
- frontend 전체: 18 files, 111 passed, exit 0;
- `frontend/dist`, `frontend/test-results`, `frontend/playwright-report`: 없음;
- R7 worktree와 Regina checkout: 제품 후보 검증 시 clean;
- `LIVE_POSTGRES=NOT_RUN`.

R7의 최종 문구는 다음과 같다.

```text
JOSEPH_W1E_A1_R7_RESULT=APPROVE
```

## 9. 다음 파일럿 운전 규칙

다음 작은 슬라이스에서만 보정된 방식을 다시 시험한다.

1. 공급자 호출 전에 quota와 workspace-edit 가능 여부를 1분 안에 preflight한다.
   실패가 확정된 공급자에 10분 이상 쓰지 않는다.
2. 슬라이스는 계약 경계 하나, 최초 추가량 600~900줄 이하로 제한한다.
3. writer는 10~15분 hard cap을 둔다. 넘으면 미완료 증거를 남기고 더 작은
   슬라이스로 분할한다.
4. writer 1명과 새 독립 작업방 reviewer 1명만 기본으로 둔다.
5. 한 번 수리한 뒤 새 독립방에서 다시 반려되면 반복 호출하지 않는다. 범위를
   줄이거나 다음 공급자로 escalation한다.
6. mutation corpus와 evidence index를 writer에게 처음부터 준다. SQL literal decoy,
   top-level statement binding, exact catalog/ORM metadata, positive multi-fact 사례를
   사후에 한 개씩 추가하지 않는다.
7. Regina는 범위 봉인·분배·patch 통합·최종 확인을 맡는다. R2 이후처럼 Regina가
   반복 repair writer가 되면 파일럿 실패로 기록하고 중단한다.
8. 검수는 계속 별도 사용자 표시 작업방·새 context·깨끗한 worktree·exact SHA의
   read-only 방식만 인정한다. 하위 에이전트와 같은 제작방 자기검수는 독립검수로
   세지 않는다.
9. 비용 성공 판정에는 실제 billable token/cache/output 또는 청구 export가
   필요하다. 없으면 `PROVISIONAL`을 넘지 않는다.

W1E-A1의 다음 제품 구현은 migration/ORM, 정적 mutation closure, 실 PostgreSQL
runtime을 한 작업으로 묶지 않는다. 각각 별도 슬라이스와 gate로 진행한다.
