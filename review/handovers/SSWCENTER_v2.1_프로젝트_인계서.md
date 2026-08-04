# SSWCenter v2.1 프로젝트 인계서

> 용도: 새 SSWCenter v2.1 프로젝트로 제품 정본·결정·착수 경계를 인계
> 작성일: 2026-07-26 KST
> 지위: 비정본 handoff 문서
> 제품 구현 권한: 이 문서 자체에는 없음

## 0. 인계 범위

이 문서는 기존 대화 전체를 옮기는 대신, 새 v2.1 프로젝트가 제품 맥락을
정확히 복원하는 데 필요한 내용만 전달한다.

인계 대상:

- 제품 목적·기능·UI·DB·기술·파일처리 경계·로드맵 정본
- Wave 1 Clean의 최신 확정 결정과 후속 미결 상태
- Clean rebuild 출처와 정본·검수 SHA
- 새 Git 저장소의 선별 반입·최초 commit 경계
- 제품 구현 전 금지사항과 최초 착수 절차

인계 제외:

- AI 업무분담·모델 배정·검토 라운드 운영규정
- 에이전트·검토자 스킬과 실행 설정
- 기존 프로젝트에 남아 있는 관련 문서·설정을 v2.1 권위로 복사하는 행위

제외 항목은 사용자가 새 v2.1 프로젝트에서 직접 제공한다. 별도 지시를 받기
전에는 과거 설정을 추정하거나 대신 확정하지 않는다.

## 1. 출처 Git 증거와 새 저장소 목표

```text
SOURCE_REPOSITORY=https://github.com/tryo528-blip/sswcenter-ver2.0.git
SOURCE_HANDOFF_BRANCH=rebuild/wave1-clean

CLEAN_REBUILD_BASE_SHA=6938573189fc7aede8a95f09934c3228e3745ebe
SOURCE_CANONICAL_DOC_SHA=e52db047a2324171b4d3e8c5d57b69e67a48206b
SOURCE_INDEPENDENT_REVIEW_RESULT_SHA=cd1fad7ebf392ce11d92ea10138eb2e568f665ca
PRODUCT_HANDOFF_SCOPE=docs/00~07

TARGET_GIT_REPOSITORY=NEW_REPOSITORY_TO_CREATE
TARGET_REMOTE_URL=TO_BE_ASSIGNED_IN_V2.1
TARGET_DEFAULT_BRANCH=TO_BE_CONFIRMED_IN_V2.1
TARGET_INITIAL_COMMIT_SHA=TO_BE_RECORDED_AFTER_IMPORT
GIT_HISTORY_RELATION=NEW_UNRELATED_HISTORY
```

출처 SHA의 역할:

- `CLEAN_REBUILD_BASE_SHA`: React Router 보안 보정까지 포함한 Clean 제품 기준
- `SOURCE_CANONICAL_DOC_SHA`: 최신 제품 결정이 반영된 정본 기준
- `SOURCE_INDEPENDENT_REVIEW_RESULT_SHA`: 위 정본의 독립검수 결과만 추가된 기준

`SOURCE_CANONICAL_DOC_SHA → SOURCE_INDEPENDENT_REVIEW_RESULT_SHA` 변경은
`review/reports/wave1-clean-final-coordination-independent-review.md` 한
파일뿐이다.

새 v2.1 저장소는 기존 저장소의 clone·fork·branch 연장이 아니다. 기존 `.git`,
branch, tag, remote를 반입하지 않고 필요한 파일만 선별해 새 최초 commit을
만든다. 따라서 위 출처 SHA는 새 저장소 commit의 ancestor가 아니라 provenance
증거다.

이 인계서의 출처 commit SHA는 자기참조 순환을 피하기 위해 본문에 넣지 않는다.
필요하면 출처 저장소의 파일 history에서 확인한다.

## 2. 현재 상태

```text
제품 정본 준비                 PASS
정본 exact-SHA 독립검수        PASS
검수 FAIL finding             0
검수 BLOCKED                  0
Wave 1 제품 구현              NOT_STARTED
실제 Wave 시작 위치           새 v2.1 프로젝트
새 v2.1 Git 저장소            TO_BE_CREATED
새 저장소 최초 commit SHA     NOT_ASSIGNED
실제 작업 branch/base         새 Git 생성 후 사용자 확인
```

- 현재 저장소에는 새 Wave 1 제품 code·migration·frontend·infra 변경이 없다.
- 위 PASS는 문서·검수통제 준비 PASS이며 제품 runtime PASS가 아니다.
- PostgreSQL·API·UI·E2E 제품 검증은 실제 구현 뒤 별도로 수행한다.
- 기존 저장소와 branch는 읽기 전용 출처이며 새 프로젝트의 작업 Git이 아니다.
- 이번 보정과 Wave 1 착수 전 추가 제품 정책결정은 없다.
- 후속 Wave 미결은 각 필요시점 전까지 임의로 확정하지 않는다.

## 3. 인계할 제품 정본 8개

`SOURCE_CANONICAL_DOC_SHA`에서 다음 파일만 제품 인계 범위로 읽는다.

1. `docs/00_정본_문서_목록.md`
2. `docs/01_새_프로젝트_목적_및_추진_방향_v1.4.md`
3. `docs/02_새프로젝트_기능요구사항_정리본_v1.0.md`
4. `docs/03_기존_UI와_기능요구사항_화면별_변경표_v1.1.md`
5. `docs/04_DB_업무구조_최종설계_v4.7_PostgreSQL.md`
6. `docs/05_기술아키텍처_및_개발기준_v1.4.md`
7. `docs/06_파일처리_영역_경계와_확정사항.md`
8. `docs/07_개발로드맵_및_결정현황_v1.0.md`

필수 추적·검수 증거:

- `review/WAVE1_CLEAN_TEST_MATRIX.md`
- `review/WAVE1_CLEAN_FINAL_COORDINATION_CROSSWALK.md`
- `review/reports/wave1-clean-final-coordination-independent-review.md`

`00_정본_문서_목록.md`에 표시된 기존 AI 운영 문서 항목은 이번 제품 인계
범위가 아니다. 새 v2.1 프로젝트에서는 사용자가 별도로 제공하는 운영규정을
따른다.

파일을 저장소에서 읽을 수 없다면 이 인계서와 함께 전달받는다. 누락된 내용을
기억이나 추측으로 채우지 말고 정확한 누락 파일명을 보고한다.

## 4. 사용자 최신 14개 방향 결정

1. 06은 파일함·입출력·OCR로 분리하지 않고
   `06_파일처리_영역_경계와_확정사항.md` 한 문서로 유지한다.
2. 06은 구현 상세정본이 아니다. 파일함·입출력은 `PARTIAL_DESIGN`, OCR은
   `CONCEPT_ONLY`, 파일처리 상세 DDL은 `DEFERRED`다.
3. 04의 실행 권위는 Wave 0 적용 schema, Wave 1 실행 가능한 상세 DDL,
   Wave 2 확정 업무계약·인터페이스·금지사항, Wave 3~5 책임·의존방향·
   보존원칙·금지사항으로 제한한다.
4. Wave 2 이후 실제 테이블명·컬럼·FK·revision 구조를 현재 미리 봉인하지 않는다.
5. 안정 인터페이스는 테이블명 목록이 아니라 `IDENTITY`·`PERIOD_FACT`·
   `REVISION`·`CURRENT_PROJECTION`, 정정 뒤 ID 지속 여부와 후속 참조대상으로
   정의한다. Wave 1 실제 DDL 매핑은 04가 소유한다.
6. Wave 1 핵심 원장에 `document_id`, `import_run_id`, `ocr_run_id` 같은 미래
   기능 역참조 FK를 추가하지 않는다.
7. 불변 물리 content와 source receipt를 분리한다. 같은 bytes를 재사용할 수
   있어도 별도 접수 사건은 별도 identity이며 hash만으로 접수를 동일시하지 않는다.
8. import는 filebox document/version을 필수 요구하지 않는다. filebox의
   삭제·ACL·노출과 import 감사원본의 보존·권한을 분리한다.
9. filebox 삭제가 import 근거를 cascade 삭제하지 않으며 import 원본을 일반
   파일함 사용자에게 자동 공개하지 않는다.
10. 문서 연결은 대상별 typed FK를 우선한다. 대형 nullable link와 FK 없는
    `target_type + target_id`는 현재 승인하지 않는다.
11. OCR은 typed application/domain command를 사용한다. 직접 SQL,
    service/repository 우회 commit과 애플리케이션 HTTP 자기호출을 금지한다.
12. OCR 원자성은 run 전체가 아니라 사용자가 승인한 적용묶음이다. 권한·CSRF
    경계·후보 version·대상 `row_version`·적용 멱등키를 재검증하고 업무변경과
    감사를 같은 짧은 transaction에 기록하며 실패 시 0건 변경한다.
13. Wave 1에는 미래 file/import/OCR 의존이 없다는 의미 기반 부재 테스트를
    유지한다.
14. exact SHA·clean tree·원격 SHA 일치·독립검수 PASS 전에는 제품 구현을
    시작하지 않는다.

## 5. 7개 기술보정

1. 06의 정확한 실제 파일명과 모든 활성 링크를 일치시킨다.
2. 06의 영역 성숙도와 07의 결정상태를 혼합하지 않는다.
3. 업무개념 의미표와 Wave 1 실제 DDL 매핑을 함께 유지한다.
4. 물리 content와 source receipt의 identity·ACL·보존 의미를 분리한다.
5. OCR 실행 멱등성과 승인 적용묶음 멱등성을 분리한다.
6. 부재검사는 문자열만 보지 않고 catalog/FK graph, ORM/migration,
   service/repository/worker, OpenAPI/생성 TypeScript/UI 의미를 검사한다.
7. 정본 SHA와 검수결과 SHA를 하나의 “최종 SHA”로 합치지 않는다.

Wave 0의 기존 `access_event.generated_document_id`는 nullable `BigInteger`
scalar이며 document FK가 없는 감사 placeholder다. 이름만으로 부재검사를
실패시키지 말고 새 미래 테이블·FK·필수 업무의존이 생겼는지를 판정한다.

## 6. 후속 결정상태

| ID/영역 | 상태 | 의미 |
|---|---|---|
| `W3-C06` | `CONFIRMED` | content/receipt와 import/filebox 경계원칙 |
| `W3-07` | `DESIGN_REQUIRED` | 실제 테이블·FK·저장소·GC·hold·publish/reconciliation·typed 연결 설계 |
| `W5-06` | `USER_DECISION_REQUIRED` | 원본·import·감사 실제 보존기간 |
| `W5-09` | `USER_DECISION_REQUIRED` | 일반 파일함·import 감사원본·OCR 근거의 역할별 열람권한 |
| `W5-01` | `SAMPLE_REQUIRED` | OCR 실제 문서와 기대 추출필드 |
| `W5-02` | `DESIGN_REQUIRED/SAMPLE_REQUIRED` | OCR 엔진·정확도·수동검토 기준 |

후속 Wave 미결은 현재 Wave 1 착수를 막지 않는다. 각 행의 필요시점 전에는
임의로 확정하지 말고 07 register에 따라 해결한다.

## 7. 새 v2.1 프로젝트에서 금지할 것

- 기존 저장소의 `.git`, branch, tag, remote, reflog를 새 저장소에 복사하지 않는다.
- 기존 저장소를 fork하거나 Git 이력을 이어 새 v2.1 작업 저장소로 삼지 않는다.
- 기존 CI secret·배포 credential·로컬 환경값을 새 저장소로 복사하지 않는다.
- 구 Wave 1·2 product code, migration, DTO, generated TypeScript, React
  component를 복사하거나 cherry-pick하지 않는다.
- 구 구현이 통과하도록 deprecated 호환필드를 만들지 않는다.
- 06을 파일함·입출력·OCR 구현완료 상세정본으로 오해하지 않는다.
- Wave 2+ 실제 DB object·API path·revision 이름을 현재 임의로 확정하지 않는다.
- Wave 1 핵심 테이블이 file/import/OCR을 역참조하게 만들지 않는다.
- 별도 SHA manifest나 10번째 제품 정본 결정문을 만들지 않는다.
- mock-only, SQLite, in-memory 결과로 PostgreSQL 불변조건 PASS를 선언하지 않는다.
- 아직 실행하지 않은 제품 runtime gate를 PASS라고 보고하지 않는다.
- 기존 Wave 1·2가 섞인 main을 일반 merge하여 구 구현을 되살리지 않는다.
- 이번 인계에서 제외한 AI 운영 문서·스킬·설정을 과거 저장소에서 복사하지 않는다.

## 8. 새 v2.1 프로젝트 최초 절차

1. 새 빈 Git 저장소를 생성한다.
2. 원격 URL·공개범위·기본 branch를 사용자와 확정한다.
3. 기존 Git 이력을 가져오지 않고 다음 출처별로 파일만 선별 반입한다.

   - 제품 runtime 기준(`CLEAN_REBUILD_BASE_SHA`):
     - `backend/`, `frontend/`, `infra/`
     - `.env.example`, `.gitignore`, `.nvmrc`, `.python-version`,
       `Caddyfile.example`
     - `scripts/PostgresTools.psm1`, `scripts/backup-postgres.ps1`,
       `scripts/build.ps1`, `scripts/create-test-db.ps1`, `scripts/dev.ps1`,
       `scripts/restore-drill.ps1`, `scripts/smoke-test.ps1`,
       `scripts/test-ephemeral-postgres.ps1`, `scripts/test.ps1`,
       `scripts/verify-wave0-db.ps1`
   - `README.md`와 제품 정본 `docs/00~07`:
     `SOURCE_CANONICAL_DOC_SHA`
   - test matrix·crosswalk·독립검수 보고서:
     `SOURCE_INDEPENDENT_REVIEW_RESULT_SHA`
   - 이 v2.1 인계서: 출처 저장소의 최신 handoff 파일

   위 allowlist 밖의 Clean base root 파일은 통째로 복사하지 않는다.

4. `.git`·AI 운영 문서·에이전트 스킬·구 Wave 1·2 제품 구현과 allowlist 밖
   파일이 반입되지 않았는지 검사한다.
5. 반입된 제품 정본 8개를 읽고 세 출처 SHA의 역할을 확인한다.
6. 새 저장소의 최초 commit을 만든 뒤 다음 값을 기록한다.

   ```text
   TARGET_INITIAL_COMMIT_SHA=<새 저장소의 40자리 SHA>
   SOURCE_CLEAN_REBUILD_BASE_SHA=6938573189fc7aede8a95f09934c3228e3745ebe
   SOURCE_CANONICAL_DOC_SHA=e52db047a2324171b4d3e8c5d57b69e67a48206b
   SOURCE_INDEPENDENT_REVIEW_RESULT_SHA=cd1fad7ebf392ce11d92ea10138eb2e568f665ca
   ```

7. 다음 상태를 기록한다.

   ```text
   DOCUMENT_PREPARATION=PASS
   WAVE1_PRODUCT_IMPLEMENTATION=NOT_STARTED
   RUNTIME_TEST_STATUS=NOT_RUN_IN_THIS_HANDOFF
   ```

8. AI 업무분담과 검토 운영규정은 사용자가 별도로 전달할 때까지 기다린다.
9. 새 최초 commit을 기준으로 실제 Wave 작업 branch를 사용자와 확인한다.
10. 07 §3과 test matrix §12~14를 기준으로 W1A 직원 vertical slice의 RED
   테스트부터 시작한다.
11. DB·API·OpenAPI·생성 TypeScript·UI·테스트를 같은 작업단위에서 동기화한다.
12. W1A~W1F 각 단계와 최종 implementation SHA에서 실제 PostgreSQL·API·UI
   runtime gate를 수행한다.

## 9. 인계 확인 체크리스트

- 새 저장소가 기존 Git과 무관한 빈 history로 생성됐는가
- 기존 `.git`·branch·tag·remote가 반입되지 않았는가
- 출처 SHA 3개를 provenance로 그대로 기록했는가
- 새 최초 commit의 40자리 SHA를 별도로 기록했는가
- 제품 정본 8개의 정확한 파일명과 실제 열람 여부를 기록했는가
- 누락 파일을 추측으로 대체하지 않았는가
- Wave 1 제품 구현이 아직 `NOT_STARTED`임을 확인했는가
- 새 원격·기본 branch·Wave 작업 branch를 사용자 확인 전 임의로 정하지 않았는가
- AI 운영규정·스킬이 이 인계 범위에서 제외됐음을 확인했는가
- 제품 runtime PASS를 문서 준비 PASS와 혼동하지 않았는가

## 10. 인계 결론

제품 정본 준비와 독립검수는 끝났고 Wave 1 제품 구현은 시작하지 않았다.

> 새 v2.1 프로젝트는 새 Git 저장소와 새 최초 commit을 만들고 제품 정본
> 00~07과 위 결정·상태를 복원한 뒤, 사용자가 별도로 제공하는 운영규정과
> 실제 Wave branch를 확인하고 Wave 1 Clean을 test-first로 시작한다.
