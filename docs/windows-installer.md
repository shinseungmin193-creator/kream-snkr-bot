# KREAM BOT Windows 설치 프로그램

## 기술 선택

공식 직원 PC 설치 프로그램은 Inno Setup 6로 빌드합니다. Windows 설치 마법사, 관리자 권한 상승, 설치된 앱 등록, 완료 작업과 제거 프로그램을 하나의 EXE에서 안정적으로 제공하면서 개발 PC에서 GitHub Actions 없이 컴파일할 수 있기 때문입니다.

설치 프로그램 소스는 `installer\KREAMBOT.iss`, 필수 구성요소 Bootstrap은 `installer\install-bootstrap.ps1`입니다. 기존 `scripts\install-worker-pc.ps1`과 `scripts\uninstall-worker-pc.ps1`을 실제 설치·제거 엔진으로 재사용합니다.

## 빌드

프로젝트 루트에서 `설치파일_만들기.bat`을 실행합니다.

빌드 스크립트는 다음 순서로 동작합니다.

1. `package.json`의 version 확인
2. Inno Setup 6 ISCC 확인
3. 미설치 시 winget 또는 Inno Setup 공식 서명된 설치 파일로 현재 사용자에게 설치
4. `installer\KREAMBOT.iss` 컴파일
5. `dist\KREAMBOT_Setup_v<version>.exe` 생성
6. GitHub Release용 `dist\KREAMBOT_Setup.exe` 복사본 생성

## 직원 PC 설치 순서

설치 프로그램은 관리자 권한으로 다음을 수행합니다.

1. Git 확인, 없으면 winget 또는 Git for Windows 공식 GitHub Release 설치
2. Node.js 20 이상 확인, 없거나 오래되면 winget 또는 nodejs.org의 최신 LTS MSI 설치
3. npm 버전 확인
4. Chrome 확인, 없으면 winget 또는 Google 공식 Enterprise MSI 설치
5. `C:\KREAMBOT`에 공식 저장소 main 브랜치 git clone
6. `package-lock.json`이 있으면 `npm ci`, 없으면 `npm install`
7. NSSM 공식 ZIP 다운로드 및 SHA256 검증 후 `C:\KREAMBOT\tools\nssm`에 준비
8. KREAMBOT 서비스를 Automatic/Restart/5000ms로 등록하고 시작
9. `KREAM Local Server 3000` 방화벽 규칙 등록
10. Chrome CDP 9222 전용 프로필과 바탕 화면 바로가기 생성
11. 서비스 Running/Auto, localhost:3000 HTTP 200 확인

설치 로그는 `C:\KREAMBOT\logs\installer.log`에 기록합니다. 민감정보는 기록하지 않습니다.

## 재설치와 제거

기존 설치가 있으면 **복구** 또는 **최신 버전 재설치**를 선택합니다. 두 방식 모두 `data`, `logs`, `backups`, `config`, `chrome-profile`을 보존합니다.

Windows **설정 → 앱 → 설치된 앱 → KREAM BOT → 제거**에서 제거할 수 있습니다. 기본 제거는 서비스, 방화벽, 바로가기와 프로그램 파일을 제거하되 운영 데이터는 보존합니다. 제거 중 별도 확인에서 완전 삭제를 선택한 경우에만 보존 데이터도 삭제합니다.

## 업데이트

설치 후 업데이트는 기존 시스템 관리 화면에서 `origin/main`을 fetch/pull하고, 필요한 npm 설치와 KREAMBOT 서비스 재시작을 수행합니다. 직원 PC의 push URL과 pre-push hook은 계속 차단됩니다.
