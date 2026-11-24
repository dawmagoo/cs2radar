#define AppName "CS2 Radar Desktop"
#define AppVersion "0.1.0"
[Setup]
AppId={{CB12943A-ED39-4DF1-A57A-4B2D23CBAE41}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\CS2 Radar Desktop
DefaultGroupName={#AppName}
OutputDir=dist
OutputBaseFilename=CS2-Radar-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
[Files]
Source: "launcher.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autodesktop}\CS2 Radar Desktop"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launcher.ps1"""; WorkingDir: "{app}"
Name: "{group}\CS2 Radar Desktop"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launcher.ps1"""; WorkingDir: "{app}"
[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launcher.ps1"""; Description: "Uruchom CS2 Radar Desktop"; Flags: postinstall nowait skipifsilent
