# W1D 작업 배정 패킷 v1.0

> 작업: 서비스계약·최초 계약 수급자번호 발급·계약서명자 snapshot·인정 전환
>
> 상태: `REGINA_SCOPE_SEALED / GROK_DESIGN_RED_AUTHORIZED`
>
> 위험도: `HIGH`
>
> 기준 branch: `codex/w1d-contract-transition`
>
> 기준 SHA: `266beeaa2d150371ccd1a0f26f69249eca86ba16`
>
> 직전 gate: `W1C_PASS`
>
> W1C 승인 후보: `a86567fe5c3b88bc9148c04b97f3626e0972ed75`
> (`MARCO_W1C_REVIEW_RESULT=APPROVE` → 레지나 `W1C_PASS`)
>
> 운영 정본: `docs/AI_업무분담_운영규정_v3.5.md`
>
> 작성·범위 봉인: 레지나
>
> 작성일: 2026-07-30 KST

## 1. 현재 단계와 역할

이 패킷은 W1D 전체 구현 승인이 아니다. 현재 승인 범위는 **설계·계약 초안과
실행 가능한 RED**까지다.

| 역할 | 담당 | 현재 권한 |
|---|---|---|
| 목표·범위·위험·수용기준 | 레지나 | 본 패킷 봉인, 설계감사 뒤 구현경계 재봉인 |
| 설계·계약·RED | 그록 | 단일 writer, §8의 Phase 1 파일만 수정 |
| 사전 설계감사 | 오푸스 | read-only, 신규 DB·동시성·이력·transaction 감사 |
| 감사 대체 | 요셉 | 오푸스 호출 불가 시 동일 범위 read-only 감사 |
| 구현 | 그록 | **아직 미승인** |
| 전체 회귀 | Spark | 최종 후보 SHA 이후 |
| 최종 반대검토 | 마르코 | Spark와 동일한 최종 후보 SHA |
| 최종 판정 | 레지나 | 코드를 수정하지 않고 `PASS` 또는 `BLOCK` |

- 제품·테스트 write 책임자는 현재 그록 1명이다.
- 레지나는 제품·테스트를 수정하지 않는다.
- 오푸스·요셉·마르코는 제품·테스트를 수정하지 않는다.
- 단일 writer 단계이므로 아리아를 호출하지 않는다.
- Grok 내부 agent/subagent 사용 여부는 Grok CLI가 스스로 결정한다. 다만 제품·테스트
  단일 write 책임과 본 패킷의 allowlist·완료기준 책임은 Grok 세션 하나에 유지한다.
- Opus와 요셉이 모두 불가하면 구현으로 넘어가지 않고 `BLOCKER`다.

## 2. 목표

W1C PASS 위에 다음 계약을 하나의 W1D 경계로 설계하고 RED로 고정한다.

1. 서비스별 독립 계약과 계약기간 불변조건
2. 최초 계약 확정 transaction 안의 수급자번호 1회 원자 발급
3. 계약 당시 독립 서명자 snapshot
4. 인정 전환 preview와 명시 확인
5. stale hash 재검산과 관련 행 잠금
6. 영향 서비스 multiset과 대체계약의 완전성
7. 기존 인정·등급·장기요양 계약 종료와 새 인정·등급·계약 생성의 단일 transaction
8. 성공·실패·rollback·감사·UI 상태의 일치

## 3. 정본 anchor와 matrix ID

### 필수 정본

| 영역 | 범위 |
|---|---|
| 업무 | `02#fr-certification-transition` §6, `02#fr-contract` §7 |
| W1B 승계 | `02` §4.1 수급자번호, §4.4 계약서명자 snapshot |
| UI·API | `03#ui-contract` §5 |
| 수급자 표시 | `03` §4.1~4.2의 최초 계약 전 번호 nullable 규칙 |
| DB | `04#db-contract` §8, `04` §10 인정 전환 transaction |
| W1B DB 승계 | `04` §4.1 수급자번호, §5 계약서명자 snapshot |
| 로드맵 | `06` §1·§2 W1D 행 |
| 운영 | AI 운영정본 v3.5 HIGH·exact SHA·독립검수 규칙 |

### 필수 matrix

```text
W1-REC-03
W1-SIG-01
W1-CON-01
W1-CON-02
W1-CON-03
W1-CON-04
W1-TRN-01
W1-TRN-02
W1-TRN-03
W1-TRN-04
W1-ABS-08
W1-ABS-09
W1-ABS-10
```

## 4. 봉인된 업무 계약

### 4.1 서비스계약

- 서비스종류와 시작일만 필수다.
- 종료일·급여개시일·서명자 이름/관계/전화·종료사유는 모두 선택이다.
- 같은 수급자·같은 서비스의 유효 계약기간은 겹치지 않는다.
- 같은 그룹의 서로 다른 서비스는 함께 이용할 수 있다.
- 서로 다른 그룹의 계약기간은 겹치지 않는다.
- 종료 계약은 재활성화하지 않고 재이용 시 새 계약을 만든다.
- 종료사유는 자유입력·NULL 허용이며 `사망`은 제안값일 수만 있다.
- 급여개시일 누락은 저장이나 후속 업무를 차단하지 않는다.

### 4.2 수급자번호와 서명자

- 수급자번호는 최초 계약 확정 transaction 안에서 counter를 잠그고 한 번만 발급한다.
- 계약 생성이 rollback되면 counter·수급자번호·계약도 모두 rollback한다.
- 경쟁 first-contract 요청은 중복번호를 만들 수 없다.
- 재계약과 서비스 추가는 기존 수급자번호를 바꾸지 않는다.
- 서명자 이름·관계·전화는 계약 당시 nullable snapshot이다.
- 서명자에 보호자·납부자 FK, 생년월일, 주소를 추가하지 않는다.
- 보호자·납부자 변경은 과거 계약의 서명자 snapshot을 바꾸지 않는다.

### 4.3 인정 전환

```text
preview
→ 영향 인정·등급·장기요양 계약·서비스 multiset 표시
→ new start - 1일 종료 제안
→ 사용자 명시 확인
→ 관련 행 SELECT ... FOR UPDATE
→ canonical projection과 stale hash 재계산
→ 서비스 multiset·대체계약 완전성 검사
→ 단일 transaction apply
→ 단일 상관 감사 event
```

- preview는 DB write 0건이어야 한다.
- preview 없이 apply할 수 없다.
- 확인하지 않은 apply는 422다.
- stale은 409이며 기존 preview·확인을 폐기한다.
- 누락·추가·중복·잘못된 대체 서비스는 422이고 변경은 0건이다.
- apply 어느 단계의 실패도 부분 성공을 남기지 않는다.

## 5. 명시적 금지

```text
contract_no
contract_sequence
signer_guardian_id
signer_payer_id
signer birth_date/address
end_reason_code enum/check/default/backfill
사망 기본값
discharge_date
service_start_date NOT NULL 또는 누락 차단
종료 계약 재활성화
preview write
확인 없는 apply
부분 transaction 성공
W1E 배정·Wave 2 일정/업무카드 선구현
W1C migration·제품 계약 약화
생성 OpenAPI TypeScript 수동 편집
실 개인정보·운영 DB·운영 자격증명
```

## 6. 설계 단계에서 확정할 항목

그록은 임의 구현하지 않고 계획에서 아래를 제안한다. 오푸스/요셉 감사와 레지나
재봉인 전에는 제품 코드에 반영하지 않는다.

1. W1D API resource path와 operation 이름
2. 계약 조회·생성·종료·대체 request/response schema
3. preview/apply token schema, canonical serialization version과 SHA-256 입력
4. 권한 코드 재사용 또는 신규 코드와 ADMIN 상속
5. 409·422 안정 오류코드의 최종 문자열
6. recipient contract period·다른 group overlap의 DB enforcement 방식
7. first-contract counter lock 순서와 경쟁 deadlock 회피
8. apply lock 순서, transaction isolation, fault-injection seam
9. 단일 감사 event의 action/resource/before/after/target/correlation 구조
10. 다음 단일 Alembic revision의 exact 파일명·revision ID

다음 migration은 현 single head
`20260730_0010_w1c_certification_ledgers`의 direct child 1개여야 한다. Phase 1에서는
migration을 생성하지 않는다.

## 7. RED 필수 계약

RED는 단순 문자열 존재검사가 아니라 구현 후 실제 DB/API/OpenAPI/UI 동작을 검증할
수 있는 구조여야 한다.

### DB·migration·동시성

- direct-child migration·upgrade/downgrade·offline SQL·catalog
- 최소 계약 nullable round trip
- same-service·cross-group conflict와 same-group 다른 서비스 허용
- same-day·next-day adjacency·open-ended·역순 기간
- ended→active 재활성화 거부와 새 계약 성공
- first-contract 두 connection 경쟁, 번호 unique·immutable
- fault injection 시 counter·번호·계약 원자 rollback
- signer 빈/부분 snapshot과 원본 변경 후 불변
- preview 전후 row count/hash/write 0
- stale 대상: 인정 날짜, 등급 코드/기간, 계약 기간, 서비스 multiset
- 동시 apply 하나만 성공
- apply 각 단계 fault injection과 전체 rollback
- 감사 event의 confirmer/time/target/correlation

### API·OpenAPI

- 미인증 401, 무권한 403, mutation CSRF
- 최소 계약 201과 nullable field round trip
- row version과 stale 409
- preview/apply 별도 named schema
- confirmation-required 422
- replacement multiset mismatch 422
- contract service/group conflict 409
- reactivation forbidden 409
- `contract_no`와 금지 signer/end/discharge 필드 부재
- 생성 타입은 승인 generator 결과와 일치하며 수동 수정하지 않음

### UI·브라우저

- 계약번호 입력/필수표시 없음
- 시작일만 필수, 나머지 선택
- 종료사유 초기값 없음
- 서명자 FK 선택 강제 없음
- 종료 계약은 “새 계약” 흐름
- preview 영향목록·서비스 multiset·제안 종료일 표시
- 명시 확인 전 apply disabled
- stale 시 preview·확인 폐기와 재실행 안내
- 실패 시 부분 성공처럼 보이는 상태 없음
- 실제 PostgreSQL/FastAPI와 3개 viewport 최종 E2E

### 보안·회귀

- 합성자료만 사용
- 오류·로그·artifact에 SQL/trace/PII canary 비노출
- W1A~W1C migration·API·frontend 핵심 회귀
- listener·process·temp cluster·Playwright artifact 잔여 0

## 8. Phase 1 파일 소유권

그록이 수정할 수 있는 파일은 아래 신규 경로뿐이다.

```text
review/plans/W1D_CONTRACT_TRANSITION_PLAN.md
review/evidence/w1d/RED.md
backend/tests/test_w1d_contract.py
backend/tests/test_w1d_postgres.py
frontend/src/test/W1DContractTransition.test.tsx
frontend/e2e/w1d-contract-transition.spec.ts
scripts/test-w1d-postgres.ps1
```

레지나는 제품·테스트 write 없이 다음 governance 기록만 작성·갱신할 수 있다.

```text
review/packets/W1D_ASSIGNMENT_PACKET_v1.0.md
review/environment/office/2026-07-30_W1D.md
review/reports/W1D_*_DESIGN_AUDIT_*.md
```

감사보고서는 감사자의 stdout을 사실대로 보존하며, Grok에게는 read-only다.

다음은 Phase 1에서 read-only다.

```text
docs/**
backend/alembic/**
backend/app/**
frontend/src/generated/**
frontend/src/pages/**
frontend/src/components/**
frontend/src/services/**
frontend/src/styles/**
기존 W1A/W1B/W1C tests 및 wrappers
```

소유권 변경은 write 전에 이 패킷을 레지나가 개정해야 한다. stage·commit·push·rebase·
stash·환경/의존성 변경은 승인하지 않는다.

## 9. Phase 1 완료 기준

1. 계획이 모든 필수 matrix ID를 DB/API/OA/UI/PG/E2E 검증에 매핑한다.
2. RED가 정확히 수집되고 구현 부재 때문에 의도한 stable marker로 실패한다.
3. 금지 구조 부재 검사는 별도 ABS PASS로 구분하며 제품 GREEN으로 주장하지 않는다.
4. wrapper는 product failure와 harness/environment failure를 구분한다.
5. 실행 명령·exit code·수집/실패/skip/error 수·첫 marker를 `RED.md`에 기록한다.
6. 테스트 종료 후 listener·process·temp/artifact 잔여를 기록한다.
7. `git diff --check`가 통과하고 변경은 §8 allowlist에만 존재한다.
8. 그록은 `RED_VALID_PENDING_DESIGN_AUDIT` 또는 `BLOCK`으로 반환한다.
9. 오푸스/요셉 감사와 레지나 재봉인 전 제품 구현을 시작하지 않는다.

## 10. 반환 형식

```text
담당/작업방:
기준 SHA:
판정: RED_VALID_PENDING_DESIGN_AUDIT | REQUIRED_CHANGES | BLOCK
변경 파일:
matrix ID → 테스트/marker:
명령·exit:
collected/passed/failed/skipped/errors:
환경/harness failure:
cleanup:
git status --short:
미실행·잔여위험:
다음 한 단계:
```
