#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

[Setup]
AppName=Snoot
AppVersion={#MyAppVersion}
AppPublisher=brontoguana
AppPublisherURL=https://github.com/brontoguana/snoot
DefaultDirName={localappdata}\snoot
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=snoot-installer
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
WizardStyle=modern
DisableStartupPrompt=yes
SetupIconFile=compiler:SetupClassicIcon.ico
UninstallDisplayName=Snoot
DisableDirPage=yes
DisableReadyPage=yes

[Files]
Source: "dist\snoot-windows-x64.exe"; DestDir: "{app}"; DestName: "snoot.exe"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Messages]
FinishedLabelNoIcons=Snoot has been installed to %n%n  {localappdata}\snoot\snoot.exe%n%nOpen a new terminal and run:%n  snoot set-user <your-session-id>%n  cd C:\your\project%n  snoot MyChannel

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;
