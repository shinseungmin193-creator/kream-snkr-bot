#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "KREAM BOT"
#define AppPublisher "KREAM BOT"
#define AppURL "https://github.com/shinseungmin193-creator/kream-snkr-bot"
#define RuntimeRoot "C:\KREAMBOT"

[Setup]
AppId={{D48D58D1-7CC5-4DAB-A02B-C5AD9EAFB540}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\KREAM BOT Installer
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=KREAMBOT_Setup_v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
Uninstallable=yes
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=KREAM BOT Windows Installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
CloseApplications=no
RestartIfNeededByRun=no
UsePreviousAppDir=no

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "..\scripts\install-worker-pc.ps1"; DestDir: "{app}\installer-assets"; Flags: ignoreversion
Source: "..\scripts\uninstall-worker-pc.ps1"; DestDir: "{app}\installer-assets"; Flags: ignoreversion
Source: "install-bootstrap.ps1"; DestDir: "{app}\installer-assets"; Flags: ignoreversion; AfterInstall: RunBootstrap

[Run]
Filename: "{#RuntimeRoot}\KREAM_로그인_Chrome.bat"; Description: "KREAM 로그인 Chrome 실행"; WorkingDir: "{#RuntimeRoot}"; Flags: postinstall shellexec skipifsilent nowait
Filename: "http://localhost:3000"; Description: "KREAM BOT 열기"; Flags: postinstall shellexec skipifsilent nowait

[Code]
var
  ExistingInstall: Boolean;
  ReinstallPage: TInputOptionWizardPage;
  InstallPathPage: TOutputMsgWizardPage;
  BootstrapExecuted: Boolean;
  UninstallWorkerExecuted: Boolean;

procedure InitializeWizard;
var
  AfterPageId: Integer;
begin
  ExistingInstall := DirExists('{#RuntimeRoot}\.git') or
    FileExists('{#RuntimeRoot}\data\worker-install.json') or
    FileExists('{#RuntimeRoot}\app.js');

  ReinstallPage := CreateInputOptionPage(
    wpWelcome,
    '기존 KREAM BOT 설치 발견',
    '수행할 작업을 선택하십시오.',
    '운영 데이터, 설정, 로그, 백업과 Chrome 로그인 프로필은 두 작업 모두 보존합니다.',
    True,
    False
  );
  ReinstallPage.Add('복구 - 현재 소스를 유지하고 의존성 및 서비스를 다시 구성');
  ReinstallPage.Add('최신 버전 재설치 - origin/main을 받은 뒤 다시 구성');
  ReinstallPage.SelectedValueIndex := 0;

  if ExistingInstall then
    AfterPageId := ReinstallPage.ID
  else
    AfterPageId := wpWelcome;

  InstallPathPage := CreateOutputMsgPage(
    AfterPageId,
    'KREAM BOT 설치 경로',
    '직원 PC의 고정 운영 경로를 사용합니다.',
    '프로그램: {#RuntimeRoot}' + #13#10 +
    '운영 데이터: {#RuntimeRoot}\data, logs, backups, config, chrome-profile' + #13#10#13#10 +
    'Git, Node.js LTS, Chrome, NSSM, 서비스와 방화벽을 자동으로 확인합니다.'
  );
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ReinstallPage.ID) and (not ExistingInstall);
end;

function SelectedInstallMode: String;
begin
  if ExistingInstall and (ReinstallPage.SelectedValueIndex = 0) then
    Result := 'Repair'
  else
    Result := 'Latest';
end;

procedure RunBootstrap;
var
  PowerShellPath: String;
  BootstrapPath: String;
  WorkerPath: String;
  Parameters: String;
  ResultCode: Integer;
begin
  if BootstrapExecuted then
    Exit;
  BootstrapExecuted := True;

  WizardForm.StatusLabel.Caption := 'Git, Node.js, Chrome 및 KREAM BOT을 설치하고 있습니다...';
  WizardForm.Refresh;
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  BootstrapPath := ExpandConstant('{app}\installer-assets\install-bootstrap.ps1');
  WorkerPath := ExpandConstant('{app}\installer-assets\install-worker-pc.ps1');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' + BootstrapPath +
    '" -InstallPath "{#RuntimeRoot}" -ReinstallMode "' + SelectedInstallMode +
    '" -WorkerScript "' + WorkerPath + '"';

  Log('KREAM BOT Bootstrap 시작: mode=' + SelectedInstallMode);
  if not Exec(PowerShellPath, Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('설치 엔진을 시작하지 못했습니다. C:\KREAMBOT\logs\installer.log를 확인하십시오.');
  if ResultCode <> 0 then
    RaiseException('KREAM BOT 설치가 완료되지 않았습니다.' + #13#10 +
      '실패 단계와 오류는 C:\KREAMBOT\logs\installer.log에서 확인하십시오.');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'KREAM BOT 설치가 완료되었습니다.';
    WizardForm.FinishedLabel.Caption :=
      'KREAM 로그인 전용 Chrome에서 직접 로그인한 뒤 KREAM BOT을 사용하십시오.';
  end;
end;

procedure RunUninstallWorker(DeleteAllData: Boolean);
var
  PowerShellPath: String;
  WorkerPath: String;
  Parameters: String;
  ResultCode: Integer;
begin
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  WorkerPath := ExpandConstant('{app}\installer-assets\uninstall-worker-pc.ps1');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' + WorkerPath +
    '" -InstallPath "{#RuntimeRoot}"';
  if DeleteAllData then
    Parameters := Parameters + ' -DeleteAllData -Confirmation "DELETE ALL DATA"';

  UninstallProgressForm.StatusLabel.Caption := 'KREAMBOT 서비스와 설치 항목을 제거하고 있습니다...';
  if not Exec(PowerShellPath, Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('KREAM BOT 제거 엔진을 시작하지 못했습니다.');
  if ResultCode <> 0 then
    RaiseException('KREAM BOT 제거가 안전하게 중단되었습니다. 운영 데이터는 삭제되지 않았습니다.');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DeleteAllData: Boolean;
begin
  if (CurUninstallStep = usUninstall) and (not UninstallWorkerExecuted) then
  begin
    UninstallWorkerExecuted := True;
    DeleteAllData := MsgBox(
      '기본 제거는 data, backups, logs, config와 Chrome 로그인 프로필을 보존합니다.' + #13#10#13#10 +
      '보존 데이터까지 완전히 삭제하시겠습니까?' + #13#10 +
      '삭제한 데이터는 복구할 수 없습니다.',
      mbConfirmation,
      MB_YESNO or MB_DEFBUTTON2
    ) = IDYES;
    RunUninstallWorker(DeleteAllData);
  end;
end;
