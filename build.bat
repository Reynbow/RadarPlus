@echo off
rem Builds build\radarplus.dll with the VS 2022 Build Tools (x64, static CRT).
setlocal
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
rc /nologo /fo build\radarplus.res src\radarplus.rc || exit /b 1
cl /nologo /LD /O2 /MT /EHsc /std:c++17 /W3 /GS /guard:cf- /DUNICODE /D_UNICODE ^
   /Fo"build\\" /Fe"build\radarplus.dll" src\*.cpp build\radarplus.res ^
   /link /DLL /OPT:REF /OPT:ICF user32.lib kernel32.lib
exit /b %ERRORLEVEL%
