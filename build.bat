@echo off
rem Builds build\radarplus.dll (x64, static CRT) with Visual Studio 2022 or later (C++ build tools).
setlocal
set "VCVARS="
rem Find Visual Studio's C++ tools with Microsoft's locator; fall back to the usual Build Tools path.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
    echo Visual Studio with the C++ build tools was not found.
    exit /b 1
)
call "%VCVARS%" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
rc /nologo /fo build\radarplus.res src\radarplus.rc || exit /b 1
cl /nologo /LD /O2 /MT /EHsc /std:c++17 /W3 /GS /guard:cf- /DUNICODE /D_UNICODE ^
   /Fo"build\\" /Fe"build\radarplus.dll" src\*.cpp build\radarplus.res ^
   /link /DLL /OPT:REF /OPT:ICF user32.lib kernel32.lib
exit /b %ERRORLEVEL%
