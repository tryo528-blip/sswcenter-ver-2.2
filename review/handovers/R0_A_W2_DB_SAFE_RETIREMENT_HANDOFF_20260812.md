# R0-A W2 급여계획서 DB 안전폐기 — 세션 핸드오프

- 작성일: 2026-08-12 (KST)
- 저장소: `C:\sswcenter\2.2`
- 이어받기 worktree: `C:\Users\USER\.codex\worktrees\r0-a-portable-20260812\2.2`
- 브랜치: `codex/r0-a-work-20260812`
- 현재 HEAD: `d54fb2f5ea1eb8d303f6f493524f120be019538f`
- 원격: `origin/codex/r0-a-work-20260812` (local/origin SHA 일치, 작업트리 clean)
- 운영 기준: `C:\sswcenter\00-오케스트레이션-작업지침.md`
- 운영 기준 SHA-256: `9D060B8ED123FCFF0422A48A511949DBCBAC95F009D91F1869EC13163BED3648`

## 0. 한눈에 보는 상태

R0-A의 제품 수정과 독립 테스트 1~3번방까지 완료했다. W2 급여계획서 이력·테이블·함수는 보존하고, 새 0019 forward migration에서 기존 쓰기 권한과 5개 업무 가드만 제거하는 방향이다.

현재 상태는 **R0-A 기술 하위단위 PASS**지만, 독립 검수 4~6번방과 Claude 최종검수가 아직 남아 있어 **전체 봉인은 아직 아니다**.

## 1. 확정된 제품 범위

- 기존 migration `20260809_0018_w2_service_plan_notice.py`는 수정하지 않는다.
- 새 migration `20260812_0019_r0_w2_read_only.py`는 0018의 직속 forward child다.
- 0019에서 제거하는 것은 정확히 5개 W2 guard trigger다.
- W2 함수 7개, immutable trigger 2개, 테이블·행·PK/FK/CHECK·identity sequence·audit 이력은 보존한다.
- `erp_app`은 0019에서 W2 table SELECT만 허용한다. INSERT/UPDATE/DELETE/TRUNCATE와 sequence USAGE/UPDATE는 거부한다.
- `erp_backup`은 read-only를 유지한다.
- 0019 `downgrade()`는 split-brain 방지를 위해 즉시 실패한다. 되돌림은 0018 백업을 별도 새 DB에 복원하는 방식만 사용한다.
- W1C 검증기는 자기 소유 trigger/table 두 쌍만 검사한다. W2가 추가한 무관 trigger는 W1C에서 무시하고, W2 trigger lifecycle은 별도 검증한다.
- W2 구조 제약조건 catalog query는 `contype IN ('p','f','c')`만 구조 제약으로 세며, PostgreSQL의 constraint trigger(`contype='t'`)는 별도 trigger 검증으로 남긴다.

## 2. 공용 브랜치에 반영된 커밋

최근 R0-A 관련 커밋은 다음과 같다.

| 커밋 | 내용 |
|---|---|
| `c6dd478` | W1C postcheck를 소유 trigger/table 쌍으로 제한 |
| `e3b0843` | W2 구조 제약조건에서 constraint trigger 제외 |
| `1c7bfa4` | Room1 W1C·현재 postcheck 계약 테스트 |
| `c28c6e1` | Room2 PostgreSQL read-only migration 테스트 |
| `d54fb2f` | Room3 lifecycle·backup·restore 테스트 |

이 다섯 커밋은 모두 현재 공용 브랜치에 들어가 있고 원격에도 push되어 있다.

## 3. 현재 핵심 파일과 해시

해시는 현재 checkout의 raw SHA-256이다. 0019와 postcheck는 CRLF checkout일 수 있으므로 LF 정규화 값도 함께 기록한다.

| 파일 | raw SHA-256 | LF 정규화 SHA-256 |
|---|---|---|
| `backend/alembic/versions/20260809_0018_w2_service_plan_notice.py` | `15826458DD5DDBBB8881CA451C82D79DCCADA2D83CC3EEC09863947B96D80E8C` | 동일 기준 파일 |
| `backend/alembic/versions/20260812_0019_r0_w2_read_only.py` | `6674D45530D65930BB3D6CDCDA74C0776DB103C7F53DB43F4DCA8645E75B8C51` | `EF7FC4917015A265D4633EFAE372314B760F193C4CFC2C98240C158CFDFB21AA` |
| `backend/app/db/postcheck_w1a_vs1.py` | `255608C4D171B7DC72C507358644CC7D7AEF7B5C57229B079B989A700DD2F94D` | `CCEF1E15CB50A97940115AE4B9993848909F4987090D0D5C4783AEF8E169E8C1` |
| `backend/tests/test_r0_w2_read_only_contract.py` | `7F5F271D3EC6FB751E06A99F5ABD86B714229A3878440AF5ED48F23CC9E3B682` | checkout 기준 |
| `backend/tests/test_r0_w2_read_only_postgres.py` | `CCFC46FA075376A51E47E21FCBE4FD05B84A3D3DF840C6729E6D78C571099AFF` | checkout 기준 |
| `scripts/test-r0-w2-read-only-postgres.ps1` | `9A6DF0F22492BFE425D056A232881FCE1180751ACEBC02CCBB65EFD5181FCCD7` | checkout 기준 |
| `backend/tests/test_r0_w2_read_only_lifecycle.py` | `D3B84E4D047A560D2E3195F3BAA4560730E2AC83A834A7E66407403880AA581A` | checkout 기준 |
| `scripts/test-r0-w2-read-only-lifecycle.ps1` | `3A50C92C27365E4CD03DDCE031429E76BD366B8A8305503AF514C6D7638E638F` | checkout 기준 |

## 4. 독립 테스트 결과

### Room1 — Test Grade 1~2, Spark xhigh

- R0 계약 테스트와 기존 W2 계약 테스트: `14 passed`.
- AST, 대상 파일 Ruff, Alembic heads/history, diff-check: PASS.
- W1C 누락·잘못된 table·deferrable flag 변조는 실패하고, 무관 W2 trigger 공존은 통과하는 의미 테스트 포함.
- 기존 W2 계약 파일의 Ruff 경고 5건(F401×4, E501×1)은 기존 경고로 별도 기록했으며 이번 파일의 Ruff는 PASS.

### Room2 — Test Grade 3~4, Luna max

- isolated PostgreSQL 17 runtime: `4 passed`.
- 0018 marker, 0019 marker, fresh 0019 marker 모두 확인.
- 실제 role denial: `24/24`.
- row/PK/full-row fingerprint, catalog/ACL/identity/trigger/function 검증 PASS.
- cleanup: `listener=0 process=0 temp=0 artifact=0 git=0`.

### Room3 — Test Grade 5, Sol max

- isolated PostgreSQL 17 lifecycle: `1 passed`.
- 0018→0019 forward migration, 0019 fail-closed downgrade, backup 2건, 분리 restore 2건, snapshot/ACL/function/trigger/sentinel/marker 검증 PASS.
- cleanup: `listener=0 process=0 temp=0 artifact=0 git=0`.

공통 사항: create_thread가 fast 토글을 제공하지 않아 실제 fast 적용 여부는 모두 `UNVERIFIED`다.

## 5. 이어받는 사람이 바로 할 일

1. 현재 공용 브랜치 `codex/r0-a-work-20260812`를 fetch하고 HEAD가 `d54fb2f...`인지 확인한다.
2. 제품·migration·테스트 파일을 임의로 다시 고치지 않는다. 특히 0018은 불변이다.
3. 새 독립 Review Room 4~6을 만든다.
   - Room4: Review Grade 1~2, Luna max
   - Room5: Review Grade 3~4, Sol xhigh
   - Room6: Review Grade 5, Sol ultra
4. Room4~6은 read-only 기술검수만 하며, current SHA의 정적·catalog·ACL·복원 증거를 대조한다.
5. Room4~6이 모두 PASS한 뒤 Claude 최종검수를 실행한다.
6. Claude PASS 직후에만 R0-A 봉인 여부를 결정·기록한다. 실제 signing, 실계정, device/intranet acceptance는 별도다.

## 6. 실행 환경과 안전선

- 검증 Python: `C:\sswcenter\2.2\backend\.venv\Scripts\python.exe` (Python 3.11.9).
- PostgreSQL 17 bin: `C:\Program Files\PostgreSQL\17\bin`.
- Room2 port `55447`, Room3 port `55448`의 임시 cluster/DB/restore root는 모두 정리됐다.
- shared/current 운영 DB에 migration downgrade·restore·seed를 실행하지 않는다.
- 실패한 독립 방의 임시 cluster만 소유 범위로 정리하고, 별도 PostgreSQL Windows 서비스는 건드리지 않는다.
- 테스트 하니스가 문제를 발견하면 먼저 제품 결함인지 하니스 결함인지 분리한다. 제품 결함은 Grok 단일 파일 Writer 작업으로만 수정하고, 같은 실패를 자동 재호출하지 않는다.

## 7. 남은 미검증/주의사항

- Review Room 4~6과 Claude 최종검수는 아직 실행하지 않았다.
- 전체 W2 봉인과 제품 운영 acceptance는 아직 선언하지 않았다.
- 실제 fast 적용 여부는 미검증이다.
- 기존 W2 계약 테스트의 Ruff 경고 5건은 이번 R0-A 변경으로 새로 생긴 것이 아니다.
- signing·실계정·device/intranet production acceptance는 기술 PASS와 별도다.

## 8. 이어받기용 한 줄 명령

`집-코덱스-그록` 또는 `사무실-코덱스-그록`으로 호출하고, 공용 브랜치 `codex/r0-a-work-20260812`를 기준으로 Review Room 4~6부터 계속한다.
