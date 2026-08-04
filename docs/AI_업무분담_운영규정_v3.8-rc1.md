# AI 개발·검수 운영체계 v3.8-rc1

> 기준일: 2026-08-01 KST
> 지위: **Release Candidate 1 — 시범운전용, 운영 정본 아님**
> 현행 정본: `docs/AI_업무분담_운영규정_v3.7.md`
> 목표: 기존 완성도를 유지하거나 높이면서 총 경과시간·중복 문맥·실제 비용을 줄인다.

이 문서는 사용자 승인 전까지 README와 정본 목록에 연결하지 않는다. 승인 전 실제
업무에는 v3.7이 우선하며, 충돌하면 사용자의 최신 명시 지시가 최우선이다.

---

## 1. 핵심 운영 결정

운영 단위는 모델별 직책이 아니라 다음 세 슬롯이다. 세 슬롯은 프로젝트 전체에 제작자와
검수자를 각각 한 명만 둔다는 뜻이 아니라 **슬라이스별 책임 단위**다.

1. **전역 레지나 1명**: 분배·경계 봉인·통합·최종 확인
2. **활성 슬라이스마다 제작자 1명**: 설계부터 구현·자기점검까지 연속 소유
3. **candidate마다 독립검수자 1명**: 별도 사용자 표시 작업방에서 exact-SHA read-only
   반대심사

기본적으로 설계, 계약, RED, 구현, 보안 보정, 회귀를 여러 모델에게 잘게 나누지 않는다.
한 제작자가 같은 문맥에서 끝까지 수행하고, 의도적으로 분리하는 역할은 독립검수뿐이다.

Claude, OpenRouter, DeepSeek, Grok, Luna에 영구적인 업무별 직책을 부여하지 않는다.
마르코·요셉·writer 같은 고정 인명 역할표도 사용하지 않고, 매 슬라이스의 제작자 슬롯과
독립검수자 슬롯만 명시한다.

---

## 2. 책임과 권한

### 2.1 레지나

레지나는 메인 작업방에서 다음만 소유한다.

- 목표·비범위·위험등급 봉인
- 기준 branch·SHA·실제 작업 root 확인
- 단일 제작자와 exact 허용 경로 지정
- 완료조건·테스트·증거·금지행위 명세
- 공급자 순서와 clean checkpoint 관리
- 제작 결과와 독립검수 결과의 통합
- exact SHA·변경 경로·증거·잔여 위험 최종 확인
- 제한 경로 stage·commit·push와 local/upstream/remote 일치 확인
- 모든 trouble과 복구 이력 기록

레지나는 제품 설계, 계약 상세, RED 내용, 구현, 반대심사, 보안 분석, 회귀 설계를 직접
대체하지 않는다. 레지나가 수행하는 compile·lint·테스트·diff·blob 확인은 통합 게이트이며
독립검수 횟수로 세지 않는다.

레지나가 제작자의 결함 원인과 구현 구조를 상세히 대신 설계하기 시작하면 역할 초과로
기록하고, 제작자 또는 별도 설계 단계로 되돌린다.

### 2.2 제작자

활성 공급자의 제작자 한 명이 봉인된 한 슬라이스에서 다음을 연속 소유한다.

- 필요한 범위의 현행 바이트 조사
- 설계와 계약 구체화
- RED 또는 실패 재현 작성
- 제품·테스트·문서 구현
- 자기점검과 허용된 정적·runtime 실행
- 독립검수 finding의 표적 보정
- 변경 경로·검증 결과·잔여 위험 인계

한 파일 범위의 write 책임자는 항상 한 명이다. 제작자는 자기 작업방의 자기검수나 내부
에이전트 결과를 독립검수라고 주장할 수 없다.

### 2.3 독립검수자

독립검수자는 제작자와 분리된 별도 사용자 표시 작업방에서 후보를
`PASS|REQUIRED_CHANGES|BLOCK`으로 판정한다.
검수자는 수정까지 겸하지 않으며, 검수 중 하위 에이전트를 호출하지 않는다.

### 2.4 Spark

Spark는 사용자가 지정한 경우 `gpt-5.3-codex-spark`, reasoning `xhigh`로 다음과 같은
가벼운 보조 작업만 맡는다.

- 파일·marker·상태 검색
- 실행 결과와 token/cost 수치 정리
- 비의미적 포맷 확인
- evidence index 초안
- disjoint read-only 조사

Spark는 핵심 설계, 제품 구현, 보안 판정, 독립검수, 최종 PASS를 맡지 않는다.

### 2.5 하위 에이전트

- 레지나는 명시적으로 봉인된 제작·실행용 하위 에이전트를 호출할 수 있다.
- Grok은 **제작자 슬롯을 맡았을 때만** 자기 작업 범위 안에서 내부 에이전트를 사용할
  수 있다.
- 그 밖의 제작자는 사용자의 최신 명시 승인 없이 중첩 에이전트를 호출하지 않는다.
- Grok 내부 에이전트를 포함한 모든 하위 에이전트는 한 제작자의 내부 도구로 계산한다.
- 하위 에이전트, 제작방 자기검수, Direct API read-only 호출은 독립검수가 아니다.
- 독립검수자 슬롯의 하위 에이전트 금지는 Grok을 포함한 모든 공급자별 예외보다 우선한다.
- Spark는 세 슬롯 밖의 비권위 보조도구다. 슬라이스 소유권, 제품 write, 독립검수 판정,
  최종 PASS 권한을 갖지 않는다.

---

## 3. 공급자 사용 방식

### 3.1 전환기 소진 순서

공급자 순서를 적용하기 전에 슬라이스의 위험·필요도구·sandbox·쓰기·runtime 자격을
먼저 확인한다. 제작자 후보는 최소한 다음을 할 수 있어야 한다.

- 실제 저장소의 현행 바이트 조사
- 격리 worktree 또는 봉인된 root에서 제한 경로 write
- 해당 위험등급에 필요한 PostgreSQL·브라우저·build·test 실행 또는 명시적 인계
- exact diff·명령·종료코드·수치 반환
- API key·token·실데이터 비전달 준수
- 슬라이스를 감당할 충분한 context와 timeout

자격을 충족한 공급자 사이에서 현재 충전액·주간 한도를 소진하는 기본 순서는 다음과
같다.

1. Claude Code / Opus
2. OpenRouter / 작업 패킷 지정 모델
3. Direct DeepSeek API / `deepseek-v4-pro`
4. Grok
5. Luna / `gpt-5.6-luna` / Max + Fast

이 순서는 업무 종류별 역할표가 아니다. 잔액 소진은 **자격 있는 공급자 사이의
우선순위**이며, 부적합한 공급자를 HIGH 작업에 투입할 근거가 아니다. 현재 순번의
적격 공급자가 봉인된 다음 슬라이스를 설계부터 구현·회귀까지 맡는다. 사용자의 최신
순서 변경이 항상 우선한다.

잔액을 빨리 소모하기 위해 같은 슬라이스를 여러 공급자에게 중복 제작시키지 않는다.
잔액은 **연속된 다음 슬라이스를 순서대로 배정**해 소모한다.

### 3.2 지속 운전 모드

사용자가 전환기 종료와 Luna 중심 운전을 승인하면 기본 구조는 다음과 같다.

```text
Luna Max + Fast 제작방 1개
→ clean exact-SHA 후보
→ 별도 Luna Max + Fast 독립검수방 1개
→ 레지나 통합
```

같은 모델이어도 별도 방·새 문맥·clean verification worktree·read-only exact SHA를
지키면 **절차적·문맥적 독립성**은 성립한다. 다만 동일 모델의 공통 학습 편향과
체계적 맹점까지 제거되는 모델 다양성은 성립하지 않는다.

LOW·MEDIUM은 Luna 제작방과 별도 Luna 검수방을 허용한다. HIGH는 다른 공급자를
독립검수자로 우선한다. 사용할 수 없으면 새 cold-review Luna 방에서 반대가설 중심으로
검수하고 `MODEL_DIVERSITY_DEFICIT`를 기록한다. 비가역적 데이터 유실·권한 우회·사용자
정책 불명확성이 남으면 동일 모델끼리 임의 PASS하지 않고 `OWNER_DECISION_REQUIRED`
또는 `BLOCK`으로 종료한다.

### 3.3 공급자 교체

한 공급자가 시작한 슬라이스는 clean checkpoint까지 마치는 것이 원칙이다. 다음 경우에만
중간 교체한다.

- 한도 소진 또는 명시적인 429
- 반복되는 provider/API 장애
- 사용자의 전환 지시
- 두 차례 무패치·동일 원인 실패
- 제작자가 명시적으로 안전한 완료가 불가능하다고 보고

교체 전 다음을 봉인한다.

- 기준 SHA와 현재 diff
- 완료·미완료 항목
- exact 허용 경로
- 마지막 성공·실패 gate
- 다음 제작자가 처음 확인할 최소 evidence index

같은 파일 범위를 두 공급자가 동시에 쓰지 않는다. 실패한 전달이 이미 실행됐는지 먼저
확인하고, 중복 dispatch하지 않는다.

한도·인증·환경 문제는 동일 명령을 최대 한 번 제한 재시도한다. 계속 불가하면 현재
diff·기준 SHA·실행 결과·미실행 항목·잔여 위험을 봉인한다. 레지나가 새 제작자를
지정하는 즉시 기존 제작자의 write 권한은 종료된다.

AGY는 사용하지 않는다. `deepseek-v4-flash`는 제작 경로에 넣지 않는다.

---

## 4. 슬라이스 봉인

### 4.1 슬롯과 병렬 후보 상한

슬롯은 프로젝트 전체가 아니라 **슬라이스별**로 배정한다. 레지나는 전역 1명이고, 동시에
진행하는 각 슬라이스에는 제작자 1명, 각 candidate에는 독립검수자 1명만 둔다.

병렬 진행은 invariant, rollback, public API, migration lineage가 서로 완전히 독립인
슬라이스에만 허용한다. 다음 상한을 넘지 않는다.

- 같은 dependency lineage의 미검증 candidate: `1`개
- 서로 독립인 lineage를 합친 전체 미검증 candidate: `2`개
- `MIGRATION` tag가 붙은 미검증 candidate: 전체 `1`개

여기서 미검증 candidate는 `CANDIDATE`, `REVIEWING`, `REWORK_REQUIRED`, `BLOCKED` 상태로
아직 폐기·대체·승격되지 않은 후보를 뜻한다. 같은 lineage의 후보가 남아 있으면 그 결과에
의존하는 다음 제품 변경을 시작하지 않는다.

다음 중 하나라도 다르면 별도 슬라이스와 별도 candidate lineage로 나눈다.

- 지켜야 할 핵심 invariant
- 실패 시 rollback 또는 복구 단위
- 외부에 노출되는 public API·schema·generated contract
- migration의 upgrade/downgrade/reupgrade 계보

### 4.2 호출 전 패킷

레지나는 제작 호출 전에 최소한 다음을 한 패킷으로 봉인한다.

- 목표와 사용자 가치
- 명시적 비범위
- LOW / MEDIUM / HIGH 위험등급
- 적용 impact tag와 tag별 필수 gate
- 기준 branch·SHA·작업 root
- 단일 제작자와 exact 허용 경로
- 제품·테스트·문서별 write 권한
- 완료조건과 expected failure/success
- 실행 가능한 테스트·수치·marker
- dependency·환경·Git·live 실행 금지 또는 허용 범위
- timeout·turn·read budget과 인계 조건
- 독립검수 방식과 최종 상태 marker

권장 크기는 한 계약 경계, 한 완료조건 묶음, 약 `1~4`개 write path다. 목표 수행시간은
`10~15`분이며, `20`분을 넘길 것으로 보이면 checkpoint 기준으로 분할한다.

긴 작업을 한 번에 맡기기보다 다음처럼 나눈다.

```text
계약·RED 봉인
→ 제품 구현
→ 정적 회귀
→ runtime gate
→ closeout
```

각 단계의 완료와 다음 단계 권한을 구분한다. RED 승인 전 제품 구현, static 승인만으로
runtime GREEN, writer READY만으로 PASS를 주장하지 않는다.

### 4.3 위험등급별 최소 gate

| 등급 | 제작·검증 최소조건 | 후보 규칙 |
|---|---|---|
| LOW | 관련 static check 또는 focused smoke와 자기점검 | 같은 계약의 관련 LOW 2~3개까지 한 슬라이스로 묶을 수 있음 |
| MEDIUM | 동작·버그·계약 변경이면 실제 RED, 제작자 GREEN, focused regression | 독립 candidate로 봉인 |
| HIGH | 제품 구현 전 형식적으로 봉인된 RED, 제작자 GREEN, 적용 impact-tag runtime gate | 다른 변경과 묶지 않는 standalone candidate |

모든 등급은 clean exact-SHA candidate와 별도 작업방 독립검수 `PASS`가 있어야 한다.
문서·비동작 변경처럼 RED가 성립하지 않으면 `RED_NOT_APPLICABLE` 사유와 대체 검증을
패킷에 미리 봉인한다. 편의를 위해 가짜 RED를 만들거나 구현 뒤 RED를 소급 작성하지 않는다.

위험등급에 더해 실제 영향면을 tag로 표시하고, **붙은 tag의 gate만** 필수로 추가한다.
모든 슬라이스에 아래 전체를 일괄 실행하지 않는다.

| Impact tag | 추가 필수 gate |
|---|---|
| `MIGRATION` | 실제 PostgreSQL upgrade → downgrade → reupgrade, offline contract 검사, postcheck |
| `DB` | 관련 constraint·transaction·lock·concurrency·rollback 검사 |
| `AUTH/PII` | ACL·CSRF·audit trail·권한우회·정보누출 검사 |
| `API_CONTRACT` | OpenAPI와 generated client/schema drift 검사 |
| `UI/E2E` | 실제 FastAPI·PostgreSQL·browser 경로와 지정 viewport 검사 |
| `DATA_LOSS` | 격리 데이터의 backup·restore와 복구 후 invariant 검사 |

실행할 수 없는 필수 gate가 하나라도 있으면 PASS로 낮추지 않고 `BLOCK` 사유와 필요한
환경·권한을 기록한다.

### 4.4 RED 무결성

MEDIUM/HIGH의 실제 RED 증거에는 제품 구현 전에 실행한 command, exit code, test count,
expected failure와 actual failure를 남긴다. HIGH에서는 레지나가 이 증거와 RED test blob을
봉인하기 전 제품 write를 허용하지 않는다.

제품 구현 뒤 test·fixture·selector·assertion·skip 조건을 바꾸면 변경 이유와 이전 RED를
약화하지 않았다는 diff 근거를 남긴다. 독립검수자는 최소한 다음을 반대심사한다.

- RED가 요구사항 위반 때문에 실패했는지
- skip·xfail·조건부 bypass·환경 분기로 통과한 것은 아닌지
- assertion·fixture·selector가 구현에 맞춰 약해지지 않았는지
- failure count·marker가 다른 오류를 성공으로 오인하지 않는지

---

## 5. 제작과 통합의 기본 경로

```text
레지나 패킷 봉인
→ 제작자 1명: 현행 조사·설계·계약·RED 증거·구현·자기점검
→ 레지나: 허용경로·RED 무결성·compile·lint·test·blob 기계 gate
→ clean candidate commit / exact SHA / CANDIDATE
→ 별도 작업방 독립검수자 1명: PASS | REQUIRED_CHANGES | BLOCK
→ 레지나: VERIFIED_PASS exact-SHA 통합·최종 확인
→ 제한 경로 Git 마감
```

설계자와 구현자를 기본적으로 분리하지 않는다. 분리 인계는 두 차례 구조적 반려, 장기
architecture 결정, 또는 사용자의 명시 지시가 있을 때만 사용한다. 분리 시 설계계약을
파일 또는 bounded evidence로 봉인하고 새 제작자가 원문 전체를 다시 탐색하지 않게 한다.

제작자의 설명문만으로 완료를 인정하지 않는다. 실제 changed paths, diff, test exit,
marker, cleanup과 현재 Git 상태를 확인한다.

---

## 6. 독립검수와 재수렴

### 6.1 최초 독립검수

독립검수는 다음을 모두 만족해야 한다.

1. 사용자가 사이드바에서 직접 볼 수 있는 별도 작업방
2. 제작자 대화와 분리된 문맥
3. 별도 clean worktree
4. exact candidate SHA
5. read-only
6. 파일 수정·stage·commit·push·dependency 변경 금지
7. 하위 에이전트 금지
8. 후보 바이트와 원시 증거를 직접 확인
9. 시작·종료 Git 상태와 `PASS|REQUIRED_CHANGES|BLOCK` marker 보고

최초 검수는 strict-blind가 원칙이다. 작업 패킷, candidate SHA, 허용된 source/diff와
요구 gate만 받고, 제작자의 결론문·office trouble log·이전 reviewer 결론은 근거로
선행 주입하지 않는다. 검수자가 필요한 증거를 후보 바이트에서 스스로 만든다.

Direct OpenRouter/DeepSeek runner 결과는 사용자 표시 별도 작업방이 아니므로 독립검수로
세지 않는다. 별도 작업방 생성·읽기가 불가능하면 독립검수 결과는 `BLOCK`이고 candidate
상태는 `BLOCKED`다.

일반 LOW/MEDIUM 작업에서 첫 독립검수가 `PASS`면 같은 질문과 같은 증거를 다른 방에
자동 반복하지 않는다. HIGH 경계의 fresh 2차 검수만 6.4 조건으로 별도 판단한다.

### 6.2 첫 반려 뒤 표적 보정

```text
독립검수 REQUIRED_CHANGES
→ 기존 제작자에게 exact finding만 반환
→ 기존 제작자 1회 표적 보정
→ 기존 candidate STALE / 새 candidate SHA
→ 제작자와 분리된 독립검수방에서 finding + 인접 회귀 재검수
→ 레지나 통합
```

첫 검수는 strict-blind를 원칙으로 한다. 보정 뒤 재검수는 이전 finding을 숨기지 않고
표적 검증하되, 해당 결함의 인접 회귀와 변경 diff 전체를 함께 본다. 동일 원시 로그와
변경 없는 파일을 매번 처음부터 전량 재감사하지 않는다.

재검수는 제작방이 아니라 **최초 독립검수방을 그대로 재개**하는 것이 기본이다. 이전
finding 문맥을 보존해 중복 읽기를 줄이되 write 권한과 하위 에이전트 금지는 유지한다.
fresh 새 검수자는 6.4의 고위험 2차 독립검수 또는 사용자 명시 지시 때만 추가한다.

### 6.3 두 번째 서로 다른 반려

같은 추상화에서 서로 다른 HIGH/BLOCKER가 두 차례 연속 나오면 자동 세 번째 땜질을
중지한다.

```text
두 번째 구조적 REQUIRED_CHANGES
→ 현재 candidate와 trouble 봉인
→ 하네스·계약·아키텍처 재설계 여부 결정
→ 사용자 승인 뒤 새 슬라이스로 재개
```

세 번째 이상 독립검수는 다음 중 하나일 때만 허용한다.

- 사용자의 명시 승인
- 아직 닫히지 않은 HIGH/BLOCKER
- 보안·개인정보·권한·동시성·parser·migration 같은 별도 공격면
- live PostgreSQL 또는 실제 브라우저 같은 별도 runtime gate

가격이 저렴하다는 이유만으로 같은 프롬프트를 세 번·네 번 반복하지 않는다.

### 6.4 고위험 2차 독립검수

다음 HIGH 경계는 첫 독립검수 `PASS` 뒤 fresh 별도 작업방 1회를 추가할 수 있다.

- 인증·인가·개인정보·비밀정보
- 금전·급여·청구·법정 계산
- migration·rollback·동시성·lock
- parser·코드 생성·명령 실행 경계
- 실제 DB·외부 API·브라우저 runtime closeout

두 번째 검수자는 다른 모델을 우선 검토하되, 사용할 수 없으면 별도 clean Luna 방을
사용할 수 있다.

### 6.5 독립검수 환경 격리

독립검수는 제작 환경의 우연한 상태를 물려받지 않도록 다음을 기본값으로 한다.

- candidate exact SHA에서 만든 fresh worktree와 read-only source 권한
- 실제 Git root·detached HEAD 또는 고정 ref 확인, 검수 중 branch 이동 금지
- 실제 PostgreSQL이 필요하면 run별 전용 port·data directory·database·임시 credential
- run별 전용 `TEMP`·artifact·evidence root
- 운영 DB·운영 파일·실제 PII 접근 금지와 synthetic fixture 사용
- `.env` 본문, API token, SSH key, 개인 credential의 검수 문맥·증거 반입 금지
- generated file과 대용량 로그는 제품 worktree 밖에 저장
- 종료 시 process·listener·database·temp root·worktree와 잔존 artifact 상태 기록

검수자가 필요한 gate를 이 격리 조건에서 실행할 수 없으면 결과를 추정하지 않고
`BLOCK`으로 보고한다. 제작자의 runtime 결과는 참고 evidence일 뿐 독립 실행을 대체하지
않는다.

---

## 7. 시간·문맥·재시도 규칙

- 한 작업방에는 한 계약 경계만 둔다.
- 동일 파일과 로그를 반복 전량 읽지 않고 line·marker·evidence index를 제공한다.
- context compaction이 발생하면 새 범위를 추가하지 않고 현재 gate를 봉인한다.
- timeout, output length, max-turn, tool error, zero edit를 서로 다른 실패로 기록한다.
- timeout 또는 output length 뒤 자동 재시도하지 않는다. changed path와 과금부터 확인한다.
- 동일 원인 재시도는 최대 `1`회다. 두 번째 실패 뒤 공급자 교체 또는 슬라이스 재설계를
  선택한다.
- 무패치 호출은 token을 사용했더라도 writer 성과로 계산하지 않는다.
- `PARTIAL`은 실제 changed path와 오류를 확인한 뒤 남은 범위만 재봉인한다.
- 병렬화는 disjoint write path 또는 read-only sidecar에만 허용한다.

전체 slice timebox의 목표는 `10~15`분이다. hard cap은 hang 방지를 위해 유지하지만,
정상 고추론 요청이 잘리지 않도록 provider별 request timeout을 사용한다.

---

## 8. Direct provider runner 목표 규칙

현재 runner는 `scripts/invoke-deepseek-workspace.ps1`이다. v3.8 정본 승격 시 runner와 아래
초안 값을 일치시키고 PowerShell 5.1 pre-network·smoke 검증을 먼저 수행한다.

### OpenRouter

- 모델: `anthropic/claude-opus-5` normal speed
- reasoning: `high`
- `provider.require_parameters=true`
- `provider.data_collection=deny`
- request timeout 초안: `420`초
- Opus Fast는 privacy/data guardrail을 완화하지 않고 사용하지 않는다.

### DeepSeek

- 모델: `deepseek-v4-pro`
- thinking/reasoning: `high`
- request timeout 초안: `300`초
- API cost 누락은 실제 비용 `0`이 아니라 `uninstrumented`로 기록한다.

### 공통

- Writer에는 exact `AllowPath`가 필수다.
- 중앙 `.env.ai.local`의 절대경로만 전달하고 파일 본문·API key를 문맥에 넣지 않는다.
- 기본 read/search 합산 예산은 `12`회다. 임의로 축소할 때 필요한 line span을 먼저
  계산하며, corpus나 구현부를 읽기 전에 예산이 끝나지 않게 한다.
- 기본 max turns는 `16`, 명시 상한은 `24`다.
- 기본 output 상한은 `16384`; 한 번의 length 실패 뒤 슬라이스가 충분히 좁다면
  `32768`까지 한 번 올릴 수 있다.
- stage·commit·push, dependency 설치, 비밀파일 접근, 임의 명령, 에이전트 호출을
  provider writer에 허용하지 않는다.
- 모델 final text가 아니라 edit count·changed path·현재 bytes로 성공을 판정한다.

runner의 실제 기본값이 이 문서와 다르면 실행 결과에 override를 명시한다. 문서 초안만
수정하고 runner가 아직 바뀌지 않은 상태를 완료로 보고하지 않는다.

---

## 9. 상태와 증거

### 9.1 Candidate 상태기계

```text
DRAFT → SELF_GREEN → CANDIDATE → REVIEWING → VERIFIED_PASS → PROMOTED
                                      ├→ REWORK_REQUIRED
                                      └→ BLOCKED

REWORK_REQUIRED → 기존 후보 STALE + 새 DRAFT (보정 시작)
BLOCKED → REVIEWING (같은 SHA의 환경 차단 해소)
BLOCKED → 기존 후보 STALE + 새 DRAFT (후보 변경)
어느 상태에서든 후보 정체성이 바뀌면 기존 후보 → STALE
```

- `DRAFT`: 제작 중이며 검수 대상으로 봉인되지 않음
- `SELF_GREEN`: 제작자가 자기 gate를 통과했으나 독립검수 전임
- `CANDIDATE`: clean commit과 full SHA가 봉인됨
- `REVIEWING`: 별도 독립검수방이 그 exact SHA를 검사 중임
- `REWORK_REQUIRED`: 독립검수 `REQUIRED_CHANGES`가 재현됨
- `BLOCKED`: 필요한 독립 증거·환경·권한을 얻지 못함
- `VERIFIED_PASS`: 패킷이 요구한 모든 독립검수 `PASS`와 필수 gate가 같은 exact SHA에 결합됨
- `PROMOTED`: 레지나가 `VERIFIED_PASS` exact SHA를 승인된 branch에 통합·확인함
- `STALE`: 후보 정체성 또는 검증 대상 바이트·계약이 바뀌어 이전 결과를 적용할 수 없음

독립검수 결과 marker는 `PASS`, `REQUIRED_CHANGES`, `BLOCK` 세 가지다. 기술 gate의
`GREEN`, 제작자의 `SELF_GREEN`, 독립검수 `PASS`, 레지나의 `PROMOTED`를 서로 대신해
부르지 않는다. 실행하지 않은 live gate는 예를 들어 `LIVE_POSTGRES=NOT_RUN`처럼
명시한다.

### 9.2 불변 candidate와 무효화

검수에 들어간 candidate SHA는 불변이다. candidate SHA, 제품, test, fixture, migration,
schema, generated contract, lockfile 중 하나라도 바뀌면 기존 candidate를 `STALE`로
닫고 새 full SHA를 만든다. 같은 candidate tag를 다른 바이트에 다시 붙이지 않는다.

보정은 기존 후보를 수정하는 것이 아니라 새 후보를 만드는 일이다. 이전 `PASS`, GREEN,
test count, cleanup 결과는 새 후보에 자동 상속하지 않는다. 새 diff의 영향 gate와 모든
candidate 필수 gate를 다시 실행한다. evidence를 재사용하려면 입력 blob·명령·의존성·DB
상태·환경 fingerprint가 동일하다는 근거가 있어야 하며, 재사용 여부 자체를 기록한다.

오직 현재 exact SHA의 `VERIFIED_PASS`만 `PROMOTED`로 갈 수 있다. `STALE`,
`REWORK_REQUIRED`, `BLOCKED`, 설명문상의 writer READY는 승격 근거가 아니다.

### 9.3 최소 evidence ledger

증거에는 최소한 다음을 남긴다.

- 실제 cwd·branch·HEAD·candidate SHA
- 시작·종료 staged/unstaged/untracked 상태
- exact changed paths와 blob/hash
- command·exit·count·marker·timestamp
- live process·listener·temp·artifact cleanup
- provider/model·turn·read·tool·edit·token·cost
- timeout·무패치·잘못된 명령·복구·관측 한계
- semantic candidate SHA와 evidence-only commit SHA의 구분

---

## 10. Git과 trouble 마감

### 10.1 Clean candidate 최소조건

candidate 봉인 전 레지나는 다음을 확인한다.

- 실제 Git root와 branch 또는 detached HEAD
- base/parent full SHA와 candidate full SHA
- base 대비 exact allowlist diff와 changed-path 목록의 일치
- 허용경로 밖 staged/unstaged 변경이 candidate에 섞이지 않았는지
- untracked secret·`.env`·database dump·실데이터·대용량 artifact가 없는지
- semantic commit 뒤 제품 worktree가 clean인지
- review log·screenshot·generated artifact가 제품 tree와 분리됐는지
- push를 수행했다면 local·upstream·remote SHA가 모두 같은지

unrelated dirty work는 보존하고 stage하지 않는다. 깨끗한 격리 worktree를 만들 수 없으면
기존 사용자 WIP를 임의 정리하지 않고 candidate 봉인을 `BLOCKED`로 보고한다.

### 10.2 Git 권한과 금지행위

- 제작자는 기본적으로 main branch의 stage·commit·push·merge를 하지 않는다.
- 레지나만 검토된 exact 경로를 명시적으로 stage하고 Git 마감을 수행한다.
- `git add -A`, `git add .`, 광범위 glob stage를 사용하지 않는다.
- 독립검수자는 commit·tag·push·merge를 하지 않는다.
- 사용자 승인 없는 merge·rebase·reset·stash·force push·branch 삭제를 하지 않는다.
- 검수 중인 branch/ref를 이동하거나 같은 candidate 이름·tag에 다른 SHA를 다시 붙이지
  않는다.
- semantic candidate와 evidence-only commit을 구분한다. evidence-only commit은 제품
  candidate SHA를 바꾸거나 검수 결과를 상속시키는 수단이 아니다.
- 삭제·광범위 cleanup은 정확한 target 확인과 사용자 권한 없이 수행하지 않는다.

모든 중간 실패, 잘못된 명령, timeout, 환경 결함, 부분 복구와 cleanup 결과를 해당
날짜·단계의 office trouble log에 남긴다. trouble을 숨긴 채 다음 단계로 이동하지 않고,
패킷의 repair gate가 끝난 뒤 새 candidate를 만든다.

---

## 11. 파일럿 성과평가

각 슬라이스에서 다음을 기록한다.

- 총 wall-clock, 순수 제작시간, 독립검수시간, 레지나 통합시간
- provider별 호출 수·실행시간·retry 수·무패치 호출 수
- input·cached input·output·reasoning·total tokens
- 실제 결제액, 구독 allowance 소모량 또는 `uninstrumented`
- 제작자 자기점검, 레지나 통합 gate, 독립검수에서 각각 새로 발견한 결함
- 독립검수 finding의 severity와 재현 여부
- 보정 round 수, provider handoff 수와 사람 개입
- timeout·output length·중복 읽기·환경 blocker에 소비한 시간
- 최종 테스트·cleanup·Git 상태
- 승격 뒤 발견된 회귀 누락과 원래 어느 gate가 잡았어야 했는지

새 체제의 성공 조건은 다음 세 가지를 함께 만족하는 것이다.

1. 기존 방식과 같거나 더 높은 완성도
2. 더 짧은 총 경과시간
3. 더 낮은 실제 총비용

가격 배수만으로 성공을 선언하지 않는다. 품질은 독립검수로 지키고, 시간과 비용은
한 제작자의 문맥 연속성, 작은 슬라이스, 표적 재검수, 중복 dispatch 제거로 줄인다.

### 11.1 v3.8-rc1 파일럿 범위

- 이미 시작한 슬라이스는 v3.7 규칙으로 clean checkpoint까지 닫는다.
- 그 checkpoint 뒤 새로 시작하는 슬라이스부터 v3.8-rc1을 적용한다.
- 정본 승격 전에 최소 `MEDIUM 1개 + HIGH 1개`를 끝까지 운전한다.
- 각 파일럿은 시작 전에 비교할 v3.7 유사 작업, 측정항목, 필수 gate, 평가 시점을 봉인한다.
- 필수 gate 누락, 독립성 위반, 미해결 HIGH/BLOCKER, 관찰된 후속 회귀가 하나라도 있으면
  시간·비용이 줄어도 승격하지 않는다.
- 품질이 유지되거나 높아진 상태에서 wall-clock과 실제 비용이 모두 기준선보다 낮을 때만
  정본 승격 후보가 된다. 비용이 `uninstrumented`면 비용 개선은 입증되지 않은 상태다.
- 품질이 나빠지면 모델별 고정 직책으로 되돌아가는 대신 위험 gate, 슬라이스 크기,
  병렬 candidate 상한부터 조정하고 다시 측정한다.

---

## 12. v3.7 대비 v3.8-rc1 주요 변경

1. 모델별 영구 직책 대신 슬라이스별 레지나·제작자·독립검수자 슬롯을 명시했다.
2. 설계부터 구현·자기점검까지 한 제작자의 문맥 연속 소유를 기본으로 확정했다.
3. 공급자 자격을 잔액 소진 순서보다 먼저 확인하고, 다음 적격 슬라이스에 순차 배정한다.
4. lineage별 병렬 candidate 상한과 위험등급·impact-tag별 최소 gate를 추가했다.
5. RED 선행 증거와 test 약화 반대심사를 명시했다.
6. 불변 exact-SHA candidate 상태기계와 `STALE` 무효화 규칙을 추가했다.
7. 첫 `REQUIRED_CHANGES`는 기존 제작자 표적 보정, 두 번째 구조적 반려는 자동 반복
   중지로 정했다.
8. 독립검수의 별도 사용자 작업방, fresh worktree, DB·TEMP·secret 격리를 의무화했다.
9. 동일 모델 검수는 절차적 독립성만 제공한다고 한정하고 HIGH의 모델 다양성 부족을
   `MODEL_DIVERSITY_DEFICIT`로 기록하게 했다.
10. Direct API와 하위 에이전트 결과는 독립검수가 아님을 명시하고 reviewer의 하위
    에이전트 금지를 공급자 예외보다 우선시했다.
11. clean candidate의 Git 요건과 광범위 stage·ref 이동·결과 상속 금지를 추가했다.
12. 전환기 소진 모드와 Luna 중심 지속 운전을 분리하고 MEDIUM·HIGH 파일럿 승격 기준을
    수치화했다.

---

## 13. rc1 채택과 정본 승격 게이트

v3.8-rc1은 새 clean checkpoint 뒤의 파일럿에만 적용한다. 진행 중인 W1E를 포함해 이미
시작한 슬라이스는 v3.7로 닫으며, 중간에 규칙을 섞어 과거 증거의 의미를 바꾸지 않는다.

이 rc1을 정본으로 승격하려면 다음을 순서대로 수행한다.

1. 사용자 문구·공급자 순서·검수 횟수 최종 승인
2. Direct runner timeout·예산 기본값 구현 및 pre-network/smoke 검증
3. v3.7로 시작한 슬라이스의 clean checkpoint와 충돌 여부 확인
4. MEDIUM 1개와 HIGH 1개 파일럿의 evidence ledger 및 기준선 비교 승인
5. 필수 gate 누락·후속 회귀·미해결 blocker가 없음을 확인
6. 기존 v3.7에서 유지할 규칙과 폐기할 규칙 diff 검토
7. README와 `docs/00_정본_문서_목록.md`를 v3.8로 전환
8. 문서·runner·trouble log 제한 경로 commit/push

승격 전까지 운영 정본은 v3.7이다.
