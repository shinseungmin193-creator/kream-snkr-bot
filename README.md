# KREAM BOT

## 직원 PC 설치

직원은 소스 ZIP이나 BAT 파일을 받을 필요가 없습니다.

1. GitHub Releases에서 `KREAMBOT_Setup.exe`를 다운로드합니다.
2. 파일을 더블클릭하고 설치를 완료합니다.
3. 바탕 화면의 **KREAM 로그인**을 실행해 전용 Chrome에서 직접 로그인합니다.
4. 바탕 화면의 **KREAM BOT**을 실행합니다.

설치 경로는 `C:\KREAMBOT`, 접속 주소는 `http://localhost:3000`입니다. 로그인 정보, 쿠키와 비밀번호는 설치 프로그램이 수집하지 않습니다.

업데이트는 KREAM BOT의 **시스템 관리 → 최신 업데이트**에서 적용합니다.

## 개발 PC에서 설치 파일 만들기

프로젝트 루트의 `설치파일_만들기.bat`을 더블클릭합니다. Inno Setup 6가 없으면 공식 설치 파일을 사용해 최초 한 번 자동 설치합니다.

생성물:

- `dist\KREAMBOT_Setup.exe`
- `dist\KREAMBOT_Setup_v<package.json version>.exe`

직원에게는 `KREAMBOT_Setup.exe` 하나만 전달합니다. GitHub 저장은 기존 `GitHub_저장.bat`을 사용합니다.

