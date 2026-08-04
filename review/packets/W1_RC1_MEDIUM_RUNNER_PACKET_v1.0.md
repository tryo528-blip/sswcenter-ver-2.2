# W1 rc1 MEDIUM Direct runner 기본값 정렬 패킷 v1.0

> 봉인 시각: 2026-08-01T21:57:25.371+09:00
> 상태: `SEALED_FOR_RED`
> 운영 규칙: `docs/AI_업무분담_운영규정_v3.8-rc1.md` 파일럿 전용
> 운영 정본: `docs/AI_업무분담_운영규정_v3.7.md` 유지

## 1. 기준과 목표

- 실제 root: `C:\sswcenter\2.1`
- branch: `codex/w1e-assignment`
- clean checkpoint: `64761f126cd395bb6057237a337fdd01ed511779`
- 위험등급: `MEDIUM`
- 영향면: 운영용 Direct provider runner 동작과 fail-close 증거 형식
- 제품·DB·migration·API·UI 영향: 없음

목표는 `scripts/invoke-deepseek-workspace.ps1`의 provider별 timeout과 공통 실행 예산을
v3.8-rc1 §7~§8의 초안값에 맞추고, PowerShell 5.1에서 네트워크 전에 재현 가능한
계약 RED와 focused GREEN을 만드는 것이다.

## 2. 단일 제작자와 write 경계

한 제작자가 RED 작성부터 구현·자기점검까지 연속 소유한다. 허용 write path는 정확히
다음 세 개다.

1. `scripts/invoke-deepseek-workspace.ps1`
2. `scripts/test-invoke-deepseek-workspace.ps1`
3. `review/environment/office/2026-08-01_W1_RC1_PILOTS.md`

그 밖의 파일은 읽기만 허용한다. 제작자는 stage, commit, push, dependency 설치,
`.env*`·API key·credential 접근, 외부 API 호출, PostgreSQL·브라우저 실행, 하위
에이전트 호출을 하지 않는다.

## 3. 동작 계약

다음 계약을 한 candidate에서 함께 만족해야 한다.

1. `RequestTimeoutSeconds`를 생략하면 DeepSeek는 `300`, OpenRouter는 `420`초를
   effective 값으로 사용한다.
2. 명시적 timeout override `30..600`은 그대로 보존한다. 범위 밖 값은 parameter
   binding 또는 body 진입 전 fail-close한다.
3. 성공한 `read_file`·`search_text` 합산 기본 예산은 `12`, 기본/최대 turn은
   `16/24`다.
4. output token 기본값은 `16384`, 허용 상한은 `32768`이다.
5. 기본 DeepSeek 모델은 ReadOnly와 Writer 모두 `deepseek-v4-pro`이며
   `deepseek-v4-flash` fallback을 사용하지 않는다.
6. API 요청이 한 번 이상 있었는데 provider usage에 실제 비용이 없으면 결과는 비용
   `0`이 아니라 `uninstrumented`로 구분한다. 요청 전 fail-close는 비용 발생 없음과
   구별한다.
7. JSON과 text summary는 같은 effective timeout·예산·비용 의미를 보고한다.
8. 기존 Writer exact `AllowPath`, safe workspace path, secret redaction, provider base URL,
   patch fail-close, `PASS|PARTIAL|FAIL` 계약은 약화하지 않는다.

구현 구조는 제작자가 정하되 PowerShell 5.1 호환성을 유지하고 테스트 전용 우회로
실제 네트워크 계약을 약화하지 않는다.

## 4. RED 무결성

제작자는 제품 runner를 수정하기 전에 `scripts/test-invoke-deepseek-workspace.ps1`을
먼저 작성하고 다음을 순서대로 남긴다.

1. test 파일만 바뀐 상태의 diff와 SHA-256
2. `powershell.exe` 5.1 AST parse 결과
3. 네트워크에 도달할 수 없는 missing-env 또는 동등한 pre-network 경로의 실행
4. command, exit code, assertion total과 failed assertion 이름
5. 예상 실패가 현행 `180`초 공통 timeout, `65536` token 상한, Flash fallback,
   비용 `0` 오인 중 무엇 때문인지 구분

다른 parse 오류, 경로 오류, secret/env 접근 실패를 요구사항 RED로 세지 않는다.
runner 수정 뒤 test selector·assertion·fixture를 약화하면 이유와 RED blob 대비 근거를
원장에 기록한다.

## 5. 필수 GREEN과 기계 gate

- Windows PowerShell 5.1에서 runner와 test AST error `0`
- pre-network focused test exit `0`, assertion total·passed·failed 수 보고
- DeepSeek/OpenRouter 생략 기본값과 explicit timeout override 검증
- read budget, turn, output token 기본/상한 검증
- DeepSeek ReadOnly/Writer 기본 모델과 Flash 부재 검증
- request-count와 비용 관측 여부의 `0|decimal|uninstrumented` 분리 검증
- missing env/key 경로에서 network invocation `0`, workspace change `0`
- `git diff --check` exit `0`
- 허용 path 밖 변경 `0`, secret·credential 출력 `0`
- 현재 tree의 별도 통합 재실행과 clean exact-SHA candidate commit

실제 provider API smoke는 이 MEDIUM candidate에서 금지한다. 정본 승격 직전 별도 owner
승인과 예산이 있는 경우에만 수행한다.

## 6. 독립검수

candidate commit 뒤 별도 사용자 표시 작업방의 fresh clean worktree에서 exact SHA를
read-only로 검수한다. 최초 검수에는 제작자의 결론을 선행 주입하지 않고 이 패킷,
candidate SHA, changed paths와 필수 gate만 제공한다. 검수자는 하위 에이전트, 수정,
stage, commit, push, 네트워크, secret 접근을 하지 않는다.

판정은 `PASS|REQUIRED_CHANGES|BLOCK`이다. `PASS` 한 번이면 MEDIUM 파일럿 품질 gate는
충족하며 같은 질문을 자동 반복하지 않는다.

## 7. 비교 기준과 측정

v3.7 유사 기준선은 Direct runner에 provider 경로와 bounded read를 보정한
`217acc3a321df5b9a22afdd5f8a6d10d53ffdffa`에서
`285c04b908d456793293a81b7adf00848e905051`까지다. commit 시각 차이는 `13m 13s`다.
연관된 결함 발견 실행은 `39.5s`, `16/16` turns, tool call `23`, total token `231399`,
변경 `0`, 비용 `uninstrumented`였다. commit 시각은 순수 제작시간이 아닌 wall-clock
proxy이고 비용 기준선이 계측되지 않았으므로 이 비교만으로 비용 절감을 입증하지 않는다.

이번 파일럿은 다음을 별도로 기록한다.

- 전체 wall-clock, 제작자 active time, 독립검수 time, 레지나 통합 time
- 호출·turn·retry·무패치·handoff 수
- 사용 가능한 token/cost와 계측 불가 항목의 `uninstrumented` 표시
- RED/GREEN assertion 수, 검수 finding 수, repair round 수
- 최종 changed paths, exact SHA, cleanup, local/upstream/remote 상태

평가 시점은 최초 독립검수 종료와 candidate Git 마감 직후다. 필수 gate 누락,
독립성 위반, 미해결 HIGH/BLOCKER, 후속 회귀가 있으면 시간과 무관하게 실패다.

## 8. 완료와 비범위

완료는 exact candidate의 focused GREEN, 독립검수 `PASS`, clean Git 마감까지다.
이 MEDIUM 통과는 다음 HIGH `W1F` 파일럿 시작만 허용한다. v3.8 정본 승격이나 README·
`docs/00_정본_문서_목록.md` 교체를 허용하지 않는다. 정본 교체는 MEDIUM과 HIGH 모두의
품질·시간·비용 평가가 끝난 뒤 별도 판정한다.

