@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Whisper Agent - instalace do VS Code
echo.
echo  ===== Whisper Agent - instalace rozsireni do VS Code =====
echo.

rem --- 1) najit VSIX vedle tohoto souboru (nezalezi, odkud se bat spousti) ---
set "DIR=%~dp0"
set "VSIX="
for /f "delims=" %%F in ('dir /b /o-d "%DIR%whisper-agent-*.vsix" 2^>nul') do (
    if not defined VSIX set "VSIX=%DIR%%%F"
)
if not defined VSIX (
    echo  CHYBA: vedle tohoto souboru neni zadny soubor whisper-agent-*.vsix.
    echo  Stahnete ho z https://github.com/dapar777/whisper-agent ^(soubor whisper-agent-0.1.0.vsix^)
    echo  a dejte ho do stejne slozky jako tento bat: %DIR%
    goto :fail
)
echo  Balicek:  %VSIX%

rem --- 2) najit prikaz "code" (VS Code CLI) ---
set "CODE="
for %%C in (code.cmd code) do (
    if not defined CODE (
        for /f "delims=" %%P in ('where %%C 2^>nul') do if not defined CODE set "CODE=%%P"
    )
)
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
if not defined CODE (
    echo  CHYBA: nenasel jsem VS Code ^(prikaz "code"^).
    echo  Nainstalujte VS Code z https://code.visualstudio.com/ - pri instalaci nechte
    echo  zaskrtnute "Add to PATH" - nebo ho spustte a v paletce prikazu ^(Ctrl+Shift+P^)
    echo  dejte "Shell Command: Install 'code' command in PATH". Pak tento bat spustte znovu.
    goto :fail
)
echo  VS Code:  %CODE%
echo.

rem --- 3) instalace (--force = prepise starsi verzi) ---
echo  Instaluji...
call "%CODE%" --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo.
    echo  CHYBA: instalace selhala ^(kod !errorlevel!^). Zkuste zavrit VS Code a spustit bat znovu,
    echo  nebo ve VS Code: Extensions ^(Ctrl+Shift+X^) ^> menu "..." ^> "Install from VSIX..." a vyberte
    echo  %VSIX%
    goto :fail
)

rem --- 4) kontrola, ze je rozsireni videt ---
set "FOUND="
for /f "delims=" %%E in ('call "%CODE%" --list-extensions 2^>nul') do (
    if /i "%%E"=="dapar.whisper-agent" set "FOUND=1"
)
echo.
if defined FOUND (
    echo  HOTOVO: rozsireni dapar.whisper-agent je nainstalovane.
) else (
    echo  Instalace probehla, ale v seznamu rozsireni jeste neni videt - po restartu VS Code by melo byt.
)
echo.
echo  Co dal: restartujte VS Code ^(nebo Ctrl+Shift+P ^> "Developer: Reload Window"^).
echo  Panel Whisper je v pravem postrannim panelu; novy ukol: Ctrl+Alt+W.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
