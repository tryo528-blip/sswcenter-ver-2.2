# Wave 2 급여계획서(Service Plan Notice) 테스트 매트릭스

> 상태: Wave 2 슬라이스 중 **급여계획서 DB 계약 하나만** 등록. `WAVE1_CLEAN_TEST_MATRIX.md`와
> 같은 형식을 따르되, 범위는 이 슬라이스로 한정한다 — 일정·업무카드, 직원교체,
> 공단·RFID·실제근무, 수가·청구, OCR 등 다른 Wave 2 영역은 각자 설계가 나올 때
> 별도 매트릭스 항목으로 등록한다. 이 문서가 Wave 2 전체를 대표하지 않는다.
>
> 작성일: 2026-08-10 KST
>
> 기준 문서: [`review/plans/W2_SERVICE_PLAN_NOTICE_PLAN.md`](plans/W2_SERVICE_PLAN_NOTICE_PLAN.md)
> (§6 RED 테스트 범위 제안, 21개 항목)
>
> 기준 commit: `fe132f5` (RED 테스트 추가), 설계 기준 HEAD `d4d2ab2`/`b0dc1ee`
>
> 독립검수: 설계 문서는 Codex 정적 읽기전용 검수 PASS(findings 0, 2026-08-10).
> RED 테스트 코드 자체의 Codex 검수는 이 사무실 PC 환경 이슈
> (`CODEX_READ_ONLY_REPOSITORY_MUTATED` — freshly-copied `backend/.venv`
> 인덱싱으로 추정)로 완료하지 못해 보류. 대신 오케스트레이터가 pytest를
> 실제로 2회 실행해 검증했다(§3 참조).

## 1. 정본 anchor

| 영역 | 참조 |
|---|---|
| 업무 | `docs/02_업무규칙_계약_v1.1.md` §9.1 (line 390–403) |
| UI 오류 표시 | `docs/03_UI_API_상호작용_계약_v1.2.md` §7 (line 381–409) |
| DB 경계선언 | `docs/04_데이터_DB_불변조건_v4.8_PostgreSQL.md` §12 Wave 2·3 경계 (line 755–785) |
| 계약 FK 대상 | `04` §8.2 `recipient_contract` (line 592–605) |
| 인정기간 스키마 | `04` §6.2 `recipient_certification_period` (line 499–508) |
| orphan 금지·역방향 guard | `04` §3.5 (line 241–243, W1E `care_assignment` 사례) |
| 로드맵 | `docs/06_개발로드맵_결정현황_v1.2.md` §1 Wave 2 행 (line 27), §5 Wave 2 성숙도 (line 129) |
| 설계 초안 | `review/plans/W2_SERVICE_PLAN_NOTICE_PLAN.md` |

## 2. 테스트 층 표기

| 표기 | 의미 |
|---|---|
| `CONTRACT` | DB-free, offline alembic/ORM absence·shape 검사 (`test_w2_service_plan_notice_contract.py`) |
| `PG` | 실제 격리 PostgreSQL 제약·동시성 테스트, `SSWCENTER_W2_SVC_PLAN_NOTICE_REAL_PG` 게이트 (`test_w2_service_plan_notice_postgres.py`) |

## 3. 매트릭스

Phase 1(RED-only) 완료 상태: **오케스트레이터가 이 PC의 backend/.venv로 pytest 직접
실행해 확인** — `8 failed`(전부 `W2_PRODUCT_ABSENT` 계열 마커) + `1 passed`(harness
self-check) + `30 skipped`(live 게이트 꺼짐). 1차 산출물에서 날짜 계산 5개 항목이
아직 없어야 할 제품 로직을 테스트 파일 안에서 직접 구현해 자기 자신을 테스트하는
결함이 있었고(§6 pg-1/pg-16 위반), DeepSeek Writer에게 재작업을 지시해 실제 부재
모듈(`app.domains.recipient.service_plan_notice`) import 실패로 정정했다(RunId
`W2-01-SVC-PLAN-NOTICE-RED` → `W2-01B-SVC-PLAN-NOTICE-RED-FIX`).

| ID | 요구사항(§6 항목) | 테스트 층 | 테스트 함수 | 상태 |
|---|---|---|---|---|
| W2-SPN-C1 | migration/ORM 부재 시 안정적 RED (DB-free 1) | `CONTRACT` | `test_w2_svc_plan_notice_01_direct_child_revision_is_fixed`, `test_w2_svc_plan_notice_02_offline_sql_contract` | RED |
| W2-SPN-C2 | 정확한 컬럼 집합·타입·nullability, `recipient_certification_period_id` 부재 (DB-free 2, §2-4) | `CONTRACT` | `test_w2_svc_plan_notice_03_orm_contract_is_exact` | RED |
| W2-SPN-01 | 기본 종료일 계산(1~6월/7~12월) | `PG` | `test_default_end_date_jan_jun`, `test_default_end_date_jul_dec` | RED (모듈 부재) |
| W2-SPN-02 | 고정된 `applied_end_date`, 명시값 우선 | `PG` | `test_fixed_end_date_not_recalculated`, `test_explicit_end_date_overrides_default` | SKIP (live 게이트) |
| W2-SPN-03 | `recipient_contract_id` 필수 RESTRICT FK | `PG` | `test_missing_contract_rejected` | SKIP |
| W2-SPN-04 | 계약 무효화 시 거부, 자기무효화는 제외 | `PG` | `test_contract_invalidated_rejects_insert`, `test_contract_invalidated_plan_notice_self_invalidated_skips_check` | SKIP |
| W2-SPN-05 | 같은 트랜잭션 무효화+대체 원자적 정정 | `PG` | `test_atomic_correction_invalidate_and_replace` | SKIP |
| W2-SPN-06 | `applied_start_date` < 계약 `start_date` 거부 | `PG` | `test_start_date_before_contract_start_rejected` | SKIP |
| W2-SPN-07 | 계약 `start_date` 지연 역방향 guard | `PG` | `test_reverse_guard_contract_start_delayed_rejected` | SKIP |
| W2-SPN-08 | cap 3가지 조합(계약/인정/무기한) | `PG` | `test_cap_contract_shorter_than_certification`, `test_cap_certification_shorter_than_contract`, `test_cap_endless_contract_cert_only_cap` | SKIP |
| W2-SPN-09 | 인정기간 부재/부분 커버 거부 | `PG` | `test_no_certification_period_rejected`, `test_partial_certification_coverage_rejected` | SKIP |
| W2-SPN-10 | 다른 수급자 인정기간 미사용 | `PG` | `test_other_recipient_certification_not_used` | SKIP |
| W2-SPN-11 | `applied_end_date >= applied_start_date` CHECK | `PG` | `test_end_date_before_start_date_rejected` | SKIP |
| W2-SPN-12 | 역방향 guard: 단축·무효화·대체·DELETE | `PG` | `test_reverse_guard_contract_shorten_end_date_rejected`, `test_reverse_guard_contract_invalidate_rejected`, `test_reverse_guard_cert_period_delete_rejected`, `test_reverse_guard_contract_delete_blocked_by_fk`, `test_reverse_guard_invalidated_plan_excluded` | SKIP |
| W2-SPN-13 | DEFERRABLE 동일 트랜잭션 원자적 정정 | `PG` | `test_deferrable_atomic_contract_shorten_with_plan_correction` | SKIP |
| W2-SPN-14 | SERIALIZABLE write-skew 감지 | `PG` | `test_serializable_isolation_accepted`, `test_serializable_write_skew_detection_shape` | SKIP |
| W2-SPN-15 | `recipient_id` immutability + OLD-key orphan 감지 | `PG` | `test_recipient_contract_recipient_id_immutable`, `test_certification_period_recipient_id_immutable`, `test_reverse_guard_old_recipient_orphan_detection` | SKIP |
| W2-SPN-16 | 작성마감일 기준 D-100/D-45 순수함수 | `PG` | `test_d100_calculation`, `test_d45_calculation`, `test_d100_d45_edge_month_boundary` | RED (모듈 부재) |
| W2-SPN-17 | PERIOD_FACT 정정(무효화+신규+과거 ID 지속) | `PG` | `test_period_fact_correction_invalidate_new_persist_id` | SKIP |
| W2-SPN-18 | migration 단일 head | `PG` | `test_single_head_migration_chain` | SKIP |
| W2-SPN-19 | downgrade 완전 복원 | `PG` | `test_downgrade_restores_clean_state`, `test_downgrade_sequence_cleanup` | SKIP |

`SKIP` 항목은 `SSWCENTER_W2_SVC_PLAN_NOTICE_REAL_PG` 게이트가 꺼져 있어서 스킵된
것이며, 실패가 아니다 — 라이브 PostgreSQL 하네스가 준비되고 게이트가 켜지면
이 항목들도 migration 부재로 RED가 되어야 정상이다(아직 게이트를 켠 실행 증거
없음, §5 참조).

## 4. Wave 2 이상으로 남겨둔 것 (이 슬라이스에서 명시 제외)

- 공식 업무카드 엔진(`COMPLETE`/`INCOMPLETE`/`EXEMPT`/`WAITING`, 단계별 완료) — `02` §9.3
- 월간 일정·확정월 — `02` §9.4
- 실제 급여제공 기반 직원교체 — `W2-07`, `DESIGN_REQUIRED`로 차단
- API·UI·service 구현, 실 PostgreSQL GREEN, migration 적용 — 별도 승인 후 Phase 2
- ERP 업무카드/WorkCadence 연동 계약(`review/plans/W2_WORK_CARD_WORKCADENCE_CONTRACT_PLAN.md`,
  commit `cc434ec`) — 별도 슬라이스, 이 문서가 다루지 않음

## 5. 다음 단계

1. 라이브 PostgreSQL 하네스 준비 후 `SSWCENTER_W2_SVC_PLAN_NOTICE_REAL_PG=1`로
   켜서 W2-SPN-02~19가 (아직 migration이 없으므로) 올바르게 RED로 전환되는지
   확인 — 지금은 게이트가 꺼져서 SKIP일 뿐 RED 확인이 안 된 상태다.
2. RED 테스트 코드 자체의 Codex 독립검수 재시도(이 PC 환경 안정화 후).
3. 통과하면 migration + ORM 모델(`app.domains.recipient.service_plan_notice`
   포함) 구현은 별도 승인 후 Phase 2로 진행.
