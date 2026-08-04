# AI 개발·검수 운영체계 v3.7

> 기준일: 2026-08-01 KST
> 지위: AI 수행방식의 유일한 운영 정본
> 목표: 기존 완성도를 유지하거나 높이면서 총 시간과 실제 비용을 줄인다.

---

## 1. 최우선 불변조건

> **제작한 대화방의 자기검수와 하위 에이전트 검수는 독립검수가 아니다.**

독립검수는 다음 조건을 모두 만족해야 한다.

1. 사용자가 사이드바에서 직접 볼 수 있는 **별도 작업방**이다.
2. 제작자 대화와 분리된 새 문맥에서 시작한다.
3. 별도 clean worktree에서 exact SHA를 read-only로 검수한다.
4. 제작자의 결론 문구를 증거로 채택하지 않고 후보 바이트와 원시 증거를 확인한다.
5. 검수자는 파일 수정, stage, commit, push와 하위 에이전트 호출을 하지 않는다.

같은 모델을 제작자와 검수자에 사용할 수는 있다. 독립성의 최소 조건은 모델명이
아니라 **별도 방·새 문맥·분리 worktree·read-only exact SHA**다. 다만 서로 다른
모델을 쓸 수 있으면 관점 다양성을 위해 우선 검토한다.

별도 작업방 생성이나 읽기가 불가능하면 독립검수는 `BLOCKED`다. 하위 에이전트,
제작방 자기검수, 레지나의 간단 확인으로 대체하지 않는다.

---

## 2. 책임과 에이전트 권한

### 레지나

레지나는 메인 작업방에서 다음만 소유한다.

- 목표·범위·위험등급·파일 소유권·완료조건·검증 명세 봉인
- 공급자 순서와 작업 슬라이스 배정
- 인계 경계와 동시 write 충돌 방지
- 제작 결과와 독립검수 결과 통합
- exact SHA·증거 일치·잔여 위험 최종 확인
- 최종 GREEN/PASS/BLOCKED 판정과 제한 경로 Git 마감

레지나는 제품 설계·계약·RED·구현·반대심사·보안·회귀 작업을 직접 대체하지
않는다. 다만 사용자가 명시한 작은 운영문서 통합과 증거 정리는 레지나 소유다.
레지나의 마지막 확인은 필수지만 독립검수 횟수로 세지 않는다.

### 제작자·실행자

활성 공급자의 작업자는 봉인된 한 슬라이스에서 설계, 계약, RED, 구현, 보정,
보안 점검 또는 회귀 실행을 맡는다. 업무 종류별로 특정 모델을 고정하지 않는다.
같은 파일 범위의 write 책임자는 항상 한 명이다.

### 독립검수자

독립검수자는 별도 작업방에서 후보를 승인·반려·차단한다. 구현자와 같은 대화방을
이어받지 않으며 수정까지 겸하지 않는다.

### 하위 에이전트

- 레지나는 제작·실행용 하위 에이전트와 독립검수용 별도 작업방을 호출할 수 있다.
- Grok은 자기 작업 범위 안에서 내부 에이전트 사용 여부를 스스로 결정할 수 있다.
- 그 밖의 작업자는 사용자의 최신 명시 승인 없이 중첩 에이전트를 호출하지 않는다.
- 어떤 하위 에이전트도 독립검수자가 될 수 없다.

---

## 3. 공급자 순차 사용

기본 소진 순서는 다음과 같다.

1. Claude Code / Opus
2. OpenRouter의 작업 패킷 지정 모델
3. Direct DeepSeek API / `deepseek-v4-pro`
4. Grok
5. Luna / `gpt-5.6-luna` / **Max + Fast**

이 순서는 업무 종류별 역할표가 아니다. 활성 공급자는 설계부터 구현·회귀까지
봉인된 다음 슬라이스를 순서대로 맡는다. 앞 공급자의 한도 소진, 호출 불가 또는
사용자 전환 지시가 있을 때 다음 공급자로 이동한다. 사용자의 최신 명시 순서가
항상 이 기본 순서보다 우선한다.

한 공급자가 시작한 슬라이스는 clean checkpoint까지 마치는 것이 원칙이다.
중간 교체가 필요하면 기준 SHA, 현재 diff, 완료·미완료 항목, 허용 경로, 다음
검증을 봉인한 뒤 한 명에게만 인계한다. 같은 범위를 두 공급자가 동시에 쓰지 않는다.

Luna는 앞 공급자가 모두 소진·불가일 때의 지속 운전 경로다. 비용·시간 파일럿처럼
사용자가 명시한 경우에는 순서를 앞당겨 사용할 수 있다.

AGY는 사용하지 않는다. `deepseek-v4-flash`는 제작 경로에 넣지 않는다.
Spark는 사용자가 지정한 가벼운 실행·검색·정리 작업에만 보조적으로 사용할 수 있다.

---

## 4. 표준 수렴 절차

### 4.1 작업 패킷

레지나는 시작 전에 최소한 다음을 봉인한다.

- 목표와 비범위
- LOW/MEDIUM/HIGH 위험등급
- 기준 branch·SHA와 실제 작업 root
- 단일 writer와 exact 허용 경로
- 완료조건과 테스트·증거 명세
- 금지 행위와 인계 조건

### 4.2 기본 경로

```text
레지나 봉인
→ 제작자 1명 구현·실행·자기 점검
→ clean exact-SHA 후보
→ 별도 작업방 독립검수자 1명
→ 레지나 통합·최종 확인
```

독립검수가 첫 후보를 승인하면 같은 증거를 동일 질문으로 반복 검수하지 않는다.

### 4.3 발견 후 재수렴

```text
독립검수 발견
→ 기존 제작자 1회 보정
→ 새 exact-SHA 후보
→ 별도 작업방 read-only 재검수
→ 레지나 통합
```

기본은 이 두 단계 수렴까지다. 자동 3라운드는 없다. 세 번째 이상 검수는 사용자의
명시 승인, 아직 닫히지 않은 HIGH/BLOCKER, 또는 보안·동시성처럼 서로 다른 공격면을
맡기는 경우에만 실시한다. 저렴하다는 이유만으로 같은 프롬프트를 네 번 반복하지 않는다.

이미 별도 방에서 승인된 live 하위 gate가 있고 후보 SHA가 그대로라면 최종 검수는
그 gate의 identity·marker·경계를 확인한다. 모순이나 누락이 없는데 같은 원시 로그를
처음부터 다시 전량 감사하지 않는다.

---

## 5. exact SHA와 증거 규칙

- **GREEN**은 제작자·실행자가 요구 기술 작업과 실행 증거를 끝낸 상태다.
- **PASS**는 독립검수 승인 후 레지나가 동일 후보 SHA와 증거를 통합 승인한 상태다.
- GREEN은 PASS를 대신하지 않는다.
- 제품·테스트·migration·lockfile이 바뀌면 이전 runtime GREEN과 독립검수는 무효다.
- 증거만 별도 commit이면 제품 후보 SHA와 증거 commit SHA를 구분해 기록한다.
- 검수 worktree는 시작과 종료에 staged·unstaged·untracked가 모두 0이어야 한다.
- live wrapper는 패킷이 요구한 횟수만 실행하고 parent/stage exit, 수치, GREEN marker,
  listener·process·temp root·artifact cleanup 순서를 원시 증거로 남긴다.
- 원시 로그 전체를 반복 전송하지 않고 command, exit, count, marker, timestamp,
  source path를 담은 bounded evidence index를 먼저 제공한다.
- 모든 중간 실패, 잘못된 명령, 복구, 환경 차이, 증거 한계를 trouble log에 남긴다.
- 승인 후에는 검토된 경로만 stage하고 local/upstream/remote SHA와 clean tree를 확인한다.

---

## 6. Luna Max + Fast 운전 규칙

Luna 작업은 `gpt-5.6-luna`, 추론강도 `max`, Fast/priority를 기본으로 한다.
별도 작업방 도구가 Fast 필드를 직접 노출하지 않고 앱 전역 Fast를 상속하는 경우에는
`FAST_INHERITED_NOT_INDEPENDENTLY_VERIFIABLE`로 기록한다. 확인할 수 없는 Fast 적용을
확정 사실처럼 보고하지 않는다.

Luna는 긴 단일 작업에서 문맥 비대화와 증거 재독 비용이 커질 수 있으므로 다음을 지킨다.

- 한 작업방에는 한 계약 경계와 한 완료조건 묶음만 배정한다.
- 10~15분을 넘길 것으로 보이거나 설계·구현·대규모 회귀가 한 방에 섞이면 분할한다.
- context compaction이 발생하면 새 범위를 추가하지 않고 현재 gate를 봉인한다.
- W1 전체처럼 긴 목표는 commit/checkpoint 단위의 작은 슬라이스로 나눈다.
- 같은 파일·로그의 반복 전량 읽기를 금지하고 line/marker 중심으로 제한한다.
- 병렬화는 서로 다른 read-only 분석 또는 disjoint 파일에만 허용한다.

저가 모델 반복의 목적은 관점 다양성과 결함 발견률을 높이는 것이다. 제작방 자기검수
횟수를 늘리는 것은 독립검수의 대체가 아니다.

---

## 7. Direct provider workspace runner

`scripts/invoke-deepseek-workspace.ps1`은 `-Provider` 파라미터로 `DeepSeek`(기본값) 또는
`OpenRouter`를 지원한다. Writer 기본값은 아래와 같으며, provider에 관계없이
`deepseek-chat` 별칭과 writer용 `deepseek-v4-flash`는 사용하지 않는다.

- **DeepSeek (기본)**: `deepseek-v4-pro`, thinking `enabled`, reasoning `high`.
- **OpenRouter**: `anthropic/claude-opus-5` normal speed, reasoning `high`,
  `provider.require_parameters=true`, `provider.data_collection=deny`.
  Opus 5 Fast는 기본값이 아니며, 단일 엔드포인트가 현재 유지 중인
  no-data-collection/privacy guardrail과 충돌하기 때문이다. 명시적 사용자 승인 없이
  정책을 완화하지 않는다.

Claude Code 구독 CLI는 위 Direct provider API runner와 별도 경로로 호출한다. 이 Windows
환경의 정본 실행 파일은 `C:\Users\USER\.local\bin\claude.exe`다. `Get-Command claude`가
결과를 반환하지 않더라도 미설치로 단정하지 않고 이 절대경로를 확인한다. 실제 호출 전
`& 'C:\Users\USER\.local\bin\claude.exe' --version`의 exit `0`을 확인하며, 실패하면
Claude 호출은 `BLOCKED`로 기록한다. 이 경로는 Claude Code 구독 호출용이며 OpenRouter의
Claude API 호출·키·과금과 동일한 것으로 취급하지 않는다.

두 provider에 공통으로 적용되는 운영 규칙:

- 작업마다 exact `AllowPath`가 필수다.
- 중앙 키 파일을 격리 worktree에 복제하지 않는다. 필요하면 `-EnvFile`에 기존
  `.env.ai.local`의 절대경로만 전달하며 키 값과 파일 본문은 모델 문맥에 넣지 않는다.
- Writer 기본 turn은 `16`, 명시 가능한 상한은 `24`다.
- `read_file`과 `search_text`의 합산 기본 예산은 성공 호출 `12`회다. 없는 경로나
  실패한 검색은 예산에서 차감하지 않는다.
- 기본 출력 상한은 `16384`, 운영 안전 상한은 `65536` tokens이고 요청별 timeout은
  기본 `180`초다. 긴 작업은 상한을 늘리기 전에 슬라이스를 줄인다.
- stage·commit·push, dependency 설치, 비밀파일 접근, 임의 명령, 에이전트 호출을 금지한다.
- unified diff hunk에는 변경되지 않는 context 줄을 최소 한 줄 포함한다.
- patch 적용이 거절되면 같은 stale patch를 반복하지 않고 실패 hunk를 한 번 재독한 뒤
  다시 만든다. 특히 `replace_text` 편집 경로는 현재 바이트를 읽은 후 정확한 unique
  span으로 재작성하는 것을 선호한다.
- empty final, tool error, Writer의 zero edit는 `PASS`가 될 수 없다.
- `PARTIAL`이면 레지나가 실제 changed paths, tool errors, token usage와 파일 바이트를
  먼저 확인한 뒤 남은 범위만 다시 봉인한다.
- 결과에는 provider/model, `finish_reasons`, token usage, edit/patch count, 오류,
  그리고 provider가 보고한 cost(존재할 경우)를 기록한다. DeepSeek의 cost 필드가
  누락된 경우 실제 비용이 0이 아니라 **uninstrumented**로 보고한다.
- 모델의 설명문만으로 PASS를 만들지 않는다.
- API key, 프롬프트 본문, 파일 본문은 진행 출력에 노출하지 않는다.

어떤 API 공급자도 exact 경로와 작업 패킷 없이 자동 인수하지 않는다.

---

## 8. 파일럿 평가와 지속 여부

새 분담 방식은 슬라이스마다 다음을 기록한다.

- wall-clock 시간과 가능하면 TTFT
- input·cached input·output·reasoning·total tokens
- 실제 결제액 또는 공급자 과금 근거
- 최초 제작에서 잡힌 결함과 독립검수에서 새로 잡힌 결함
- 잘못된 차단, 재실행, 중복 감사, 사람 개입 시간
- 최종 테스트·cleanup·Git 상태

성공 조건은 다음 세 가지를 함께 만족하는 것이다.

1. 기존 방식과 같거나 더 높은 완성도
2. 더 짧은 총 경과시간
3. 더 낮은 실제 총비용

가격 배수만으로 성공을 선언하지 않는다. 반복 호출이 긴 문맥과 중복 증거 감사를
만들면 작업 수를 줄이고 패킷·evidence index를 먼저 개선한다. 품질은 독립검수로
지키고, 비용과 시간은 중복 제거와 작은 슬라이스로 줄인다.
