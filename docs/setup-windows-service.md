# KREAM BOT Windows 서비스 설정

이 문서는 KREAM BOT의 Node.js 서버를 NSSM(Non-Sucking Service Manager)으로 Windows 서비스에 등록하는 방법을 설명합니다.

## 기본 정보

- 서비스 이름: `KREAMBOT`
- Node.js 실행 파일: `C:\Program Files\nodejs\node.exe`
- 애플리케이션 파일: `C:\KREAMBOT\app.js`
- 작업 디렉터리: `C:\KREAMBOT`
- 웹 주소: `http://localhost:3000`
- Chrome CDP 주소: `http://localhost:9222`

아래 명령은 모두 **관리자 권한 PowerShell 또는 명령 프롬프트**에서 실행합니다.

## 1. NSSM 설치

1. [NSSM 공식 사이트](https://nssm.cc/download)에서 Windows용 ZIP 파일을 내려받습니다.
2. 압축을 풀고 운영체제에 맞는 `win64\nssm.exe`를 다음 위치에 복사합니다.

   ```text
   C:\Tools\nssm\nssm.exe
   ```

3. 설치 여부를 확인합니다.

   ```powershell
   C:\Tools\nssm\nssm.exe version
   ```

필요하면 `C:\Tools\nssm`을 시스템 `PATH`에 추가할 수 있습니다. 이 문서에서는 PATH 설정 여부와 관계없이 NSSM의 절대경로를 사용합니다.

## 2. 사전 준비

프로젝트 의존성을 설치하고 서비스 로그 디렉터리를 만듭니다.

```powershell
Set-Location 'C:\KREAMBOT'
npm.cmd ci
New-Item -ItemType Directory -Force 'C:\KREAMBOT\logs'
```

Node.js와 서버 파일 경로를 확인합니다.

```powershell
Test-Path 'C:\Program Files\nodejs\node.exe'
Test-Path 'C:\KREAMBOT\app.js'
& 'C:\Program Files\nodejs\node.exe' --version
```

두 `Test-Path` 명령이 모두 `True`여야 합니다.

## 3. 서비스 등록

다음 명령으로 `KREAMBOT` 서비스를 등록합니다.

```powershell
& 'C:\Tools\nssm\nssm.exe' install KREAMBOT 'C:\Program Files\nodejs\node.exe' 'C:\KREAMBOT\app.js'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppDirectory 'C:\KREAMBOT'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT DisplayName 'KREAM BOT'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT Description 'KREAM BOT inventory and price management server'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT Start SERVICE_AUTO_START
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppExit Default Restart
```

### 로그 파일 설정

```powershell
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppStdout 'C:\KREAMBOT\logs\service-out.log'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppStderr 'C:\KREAMBOT\logs\service-error.log'
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppRotateFiles 1
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppRotateOnline 1
& 'C:\Tools\nssm\nssm.exe' set KREAMBOT AppRotateBytes 10485760
```

`AppRotateBytes`의 `10485760`은 로그 파일당 약 10MB를 의미합니다.

등록 내용을 확인합니다.

```powershell
& 'C:\Tools\nssm\nssm.exe' get KREAMBOT Application
& 'C:\Tools\nssm\nssm.exe' get KREAMBOT AppParameters
& 'C:\Tools\nssm\nssm.exe' get KREAMBOT AppDirectory
Get-Service KREAMBOT
```

정상 설정값은 다음과 같습니다.

```text
Application:   C:\Program Files\nodejs\node.exe
AppParameters: C:\KREAMBOT\app.js
AppDirectory:  C:\KREAMBOT
```

## 4. 서비스 시작과 중지

### 시작

```powershell
Start-Service KREAMBOT
```

또는:

```powershell
& 'C:\Tools\nssm\nssm.exe' start KREAMBOT
```

### 상태 확인

```powershell
Get-Service KREAMBOT
Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/dashboard/summary'
```

### 중지

```powershell
Stop-Service KREAMBOT
```

또는:

```powershell
& 'C:\Tools\nssm\nssm.exe' stop KREAMBOT
```

### 재시작

```powershell
Restart-Service KREAMBOT
```

## 5. 로그 확인

표준 출력 로그:

```powershell
Get-Content 'C:\KREAMBOT\logs\service-out.log' -Tail 100
```

오류 로그:

```powershell
Get-Content 'C:\KREAMBOT\logs\service-error.log' -Tail 100
```

실시간으로 확인하려면 `-Wait`를 추가합니다.

```powershell
Get-Content 'C:\KREAMBOT\logs\service-out.log' -Tail 50 -Wait
```

Windows 서비스 이벤트는 이벤트 뷰어의 다음 위치에서도 확인할 수 있습니다.

```text
이벤트 뷰어 → Windows 로그 → 응용 프로그램
이벤트 뷰어 → Windows 로그 → 시스템
```

## 6. 서비스 삭제

먼저 서비스를 중지한 다음 삭제합니다.

```powershell
Stop-Service KREAMBOT -ErrorAction SilentlyContinue
& 'C:\Tools\nssm\nssm.exe' remove KREAMBOT confirm
```

삭제 여부를 확인합니다.

```powershell
Get-Service KREAMBOT -ErrorAction SilentlyContinue
```

서비스를 삭제해도 프로젝트 파일, SQLite DB, 로그 파일은 자동으로 삭제되지 않습니다.

## 7. Chrome CDP 주의사항

NSSM 서비스는 `app.js` 서버만 실행합니다. KREAM 자동화에는 로그인된 Chrome이 별도로 다음 옵션으로 실행돼 있어야 합니다.

```text
--remote-debugging-port=9222
```

Windows 서비스는 일반 사용자 데스크톱 세션과 분리돼 있으므로 Chrome GUI를 서비스에서 직접 실행하지 않는 것이 안전합니다. Windows 로그인 후 프로젝트의 `start.bat`을 사용하거나, 기존 방식으로 로그인된 Chrome을 먼저 실행하십시오.

확인 명령:

```powershell
Invoke-WebRequest -UseBasicParsing 'http://localhost:9222/json/version'
```

응답이 없으면 판매목록 동기화, 가격 비교, 자동수정은 실행되지 않지만 KREAM BOT 웹 서버와 DB 조회 화면은 사용할 수 있습니다.

## 8. Windows 재설치 후 복구

1. 프로젝트와 DB를 백업에서 원래 위치로 복원합니다.

   ```text
   C:\KREAMBOT
   C:\KREAMBOT\data\kream-bot.db
   ```

2. Node.js를 설치하고 `C:\Program Files\nodejs\node.exe`가 존재하는지 확인합니다.
3. 프로젝트에서 의존성을 다시 설치합니다.

   ```powershell
   Set-Location 'C:\KREAMBOT'
   npm.cmd ci
   ```

4. NSSM을 `C:\Tools\nssm\nssm.exe`에 다시 설치합니다.
5. 이 문서의 **서비스 등록**과 **로그 파일 설정** 명령을 다시 실행합니다.
6. 서비스를 시작하고 서버 응답을 확인합니다.

   ```powershell
   Start-Service KREAMBOT
   Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/dashboard/summary'
   ```

7. Chrome을 9222 디버깅 포트로 실행하고 KREAM 로그인을 확인합니다.
8. 대시보드에서 판매목록 동기화를 한 번 실행해 DB와 브라우저 연결을 최종 확인합니다.

### 권장 백업 대상

- 프로젝트 전체 소스
- `data\kream-bot.db`
- `package.json`
- `package-lock.json`
- Chrome 자동화에 사용하는 사용자 프로필과 로그인 복구 정보

로그 파일과 `node_modules`는 복구 후 다시 생성할 수 있으므로 필수 백업 대상은 아닙니다.

시스템 관리 화면, GitHub 업데이트, 자동 업데이트 작업 스케줄러의 상세 운영 방법은 `docs\system-management.md`를 참고하십시오. 신규 설치에서는 수동 NSSM 명령 대신 `scripts\install-service.ps1`을 사용할 수 있습니다.
