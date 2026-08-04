# SSWCenter v2.2-alpha

## 업무 시작 전 필수 절차

모든 작업자는 업무를 시작하기 전에 다음 순서를 지킨다.

1. 현재 작업 브랜치와 변경사항을 확인한다.
2. 현재 브랜치의 원격 변경사항을 `git pull --ff-only`로 가져온다.
3. 이 `README.md`를 읽는다.
4. Windows PC별 최초 1회 UTF-8 설정을 확인한다.
5. 활성 작업 패킷의 확정 역할-모델 배정과 기준 SHA를 확인한다.
6. 패킷이 지정한 정본의 최하위 절·anchor와 matrix ID만 읽는다.
7. 소유권이나 범위가 불명확할 때만 [정본 문서 목록](docs/00_정본_문서_목록.md)과
   [AI 개발·검수 운영체계 v3.7](docs/AI_업무분담_운영규정_v3.7.md)를 확인한다.

로컬 변경사항이나 Git 충돌이 있으면 임의로 폐기·덮어쓰기·병합하지 말고 먼저 사용자에게 보고한다.

## Windows UTF-8 최초 설정

이 저장소의 Markdown·Python·설정 파일은 UTF-8을 기준으로 한다. 집과 사무실 등 각 Windows 사용자 계정에서 저장소를 처음 사용할 때 다음 명령을 한 번 실행한다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-windows-utf8.ps1
```

실행 후 Codex와 터미널을 다시 시작한다. 이후 Python은 별도의 `-X utf8` 옵션 없이 UTF-8을 기본값으로 사용한다. 레거시 CP949 파일만 코드에서 `encoding="cp949"`를 명시하여 읽는다.

## AI 운영 원칙

역할·구현 책임·대체 호출·인계·검수·승격 규칙은
[AI 개발·검수 운영체계 v3.7](docs/AI_업무분담_운영규정_v3.7.md)만
소유한다. 작업자는 활성 패킷과 정본의 적용 시점을 확인하며, 이 README는
정본이 아닌 시작 포인터다.
