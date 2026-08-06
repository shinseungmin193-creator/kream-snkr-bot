# KREAM BOT 시스템 관리 운영 가이드

## 구성

시스템 관리 화면은 각 직원 PC의 로컬 KREAM BOT을 관리합니다. 중앙 서버 파일을 변경하지 않으며, 각 PC가 자신의 Git 저장소·KREAMBOT 서비스·Chrome CDP·SQLite DB를 관리합니다.

- 웹 서버: `app.js`, 기본 포트 `3000`
- 서비스: `KREAMBOT` (NSSM, 자동 시작)
- Chrome CDP: `127.0.0.1:9222`
- DB: `data\kream-bot.db`
- 로그: `logs\`
- DB 백업: `backups\`
- 자동 업데이트 작업: `KREAMBOT-AutoUpdate`

## 신규 직원 PC 설치

1. GitHub 저장소를 원하는 로컬 경로에 clone합니다.
2. Node.js를 설치한 뒤 프로젝트 폴더에서 의존성을 설치합니다.

   ```powershell
   npm.cmd ci
   ```

3. NSSM 경로가 기본 검색 위치에 없다면 `config\system-config.example.json`을 `data\system-config.json`으로 복사하고 `nssmPath`를 수정하거나, 시스템 환경변수 `KREAM_NSSM_PATH`를 설정합니다.
4. 관리자 PowerShell에서 서비스를 등록합니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\install-service.ps1'
   ```

5. 로그인용 Chrome을 `--remote-debugging-port=9222` 옵션으로 실행하고 KREAM에 로그인합니다.
6. 아래 점검 스크립트로 서비스, API, Git, Chrome을 확인합니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\system-check.ps1'
   ```

## 관리자 PIN 설정

업데이트, 서비스 재시작, 로그·백업 삭제, 자동 업데이트 변경은 `KREAM_SYSTEM_ADMIN_PIN`이 설정돼야 실행됩니다. PIN이 없으면 읽기 전용 시스템 정보와 DB 백업 생성만 사용할 수 있고 위험 작업은 서버에서 차단됩니다.

PIN은 소스, JSON 설정, 브라우저 저장소에 기록하지 마십시오. 다음 중 하나를 사용합니다.

- Windows **시스템 환경 변수**에 `KREAM_SYSTEM_ADMIN_PIN`을 추가한 뒤 KREAMBOT 서비스를 재시작합니다.
- `nssm edit KREAMBOT`의 Environment 탭에서 서비스 전용 환경변수로 추가합니다.

PIN은 요청 헤더로만 서버에 전달되고 로그에 기록되지 않습니다. 15분 안에 5회 실패하면 해당 접속 주소의 관리자 인증을 15분간 잠급니다.

## GitHub 업데이트 준비

먼저 `origin`이 실제 저장소를 가리키는지 확인합니다.

```powershell
git remote -v
git branch --show-current
git fetch origin
```

서비스가 `LocalSystem`으로 실행되면 일반 Windows 사용자의 Git Credential Manager 자격 증명을 사용할 수 없습니다.

- 공개 저장소는 별도 인증 없이 사용할 수 있습니다.
- 비공개 저장소는 PC 전용 SSH deploy key를 사용하고 해당 키를 `LocalSystem`만 읽을 수 있게 ACL로 보호하는 방식을 권장합니다.
- 또는 NSSM 서비스의 Log on 계정을 Git 자격 증명이 설정된 전용 Windows 서비스 계정으로 변경합니다.

개인 액세스 토큰을 remote URL, 소스, 설정 JSON에 포함하지 마십시오. 인증이 준비되지 않으면 시스템 화면은 실제 `git fetch` 오류를 표시하고 현재 서버는 계속 실행됩니다.

## 수동 업데이트 동작

시스템 화면의 **업데이트 확인**은 `git fetch` 후 현재 브랜치와 같은 이름의 remote 브랜치를 비교합니다. 최대 20개의 새 커밋 제목만 화면에 표시하며 remote URL과 자격 증명은 반환하지 않습니다.

**최신 업데이트**는 다음 순서로 동작합니다.

1. 중복 업데이트와 Playwright 작업 여부 확인
2. 추적 중인 로컬 변경사항 확인
3. SQLite 무결성 검사 및 `VACUUM INTO` 백업
4. `.env`, 시스템 설정 등 중요 로컬 파일 별도 백업
5. `git fetch` 및 `git merge --ff-only`
6. 패키지 파일이 바뀐 경우에만 `npm ci`
7. 필수 파일과 JavaScript 구문 검사
8. detached 업데이트 프로세스에서 `KREAMBOT` 서비스 재시작
9. 실패 시 이전 commit으로 `git reset --hard` 롤백, 의존성 복구 및 기록 저장

로컬 변경사항이 있으면 자동으로 버리지 않고 업데이트를 차단합니다. 먼저 변경사항을 검토하고 커밋해야 합니다.

## 자동 업데이트

기본값은 OFF, 기본 확인 시간은 04:00입니다. 시스템 화면에서 저장하면 Windows 작업 스케줄러에 `KREAMBOT-AutoUpdate` 작업이 하나만 등록됩니다.

- 자동 적용 OFF: fetch와 새 버전 확인만 수행
- 자동 적용 ON: 수동 업데이트와 같은 백업·검증·롤백 절차 수행
- 자동화 작업 진행 중: 다음 예약 시간까지 연기
- KREAMBOT 서비스가 중지돼도 예약 작업은 SYSTEM 계정으로 독립 실행

수동 등록과 해제:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\register-auto-update.ps1' -Time '04:00' -AutoApply 'False'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\remove-auto-update.ps1'
```

## 로그와 DB 백업

로그는 `app.log`, `error.log`, `update.log`, `inventory.log`, `compare.log`로 분리됩니다. 각 파일은 10MB에서 회전하며 최근 5개 보관본을 유지합니다.

DB 백업은 `backups\kream_yyyy-MM-dd_HHmmss.db` 형식입니다. 기본 30개를 보관하며 최근 백업은 자동 정리나 수동 삭제 대상에서 제외됩니다. 생성 전후 모두 SQLite 무결성 검사를 수행합니다.

## 서비스와 복구 명령

```powershell
# 재시작
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\restart-service.ps1'

# 서비스 상태
Get-Service KREAMBOT

# 업데이트 로그
Get-Content '.\logs\update.log' -Tail 200

# 현재 commit으로 소스 복구 후 의존성 재설치
git reset --hard HEAD
npm.cmd ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\restart-service.ps1'

# 서비스 제거(확인 문자열 필수)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\uninstall-service.ps1' -ConfirmRemoval KREAMBOT
```

Windows 재설치 후에는 저장소 clone, Node.js·NSSM 설치, `data\kream-bot.db`와 필요한 로컬 설정 복원, 관리자 PIN 및 Git 인증 재설정, 서비스 등록, Chrome 로그인 순서로 복구합니다.
