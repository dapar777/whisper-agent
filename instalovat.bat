@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Whisper Agent - instalace do VS Code
echo.
echo  ===== Whisper Agent - instalace rozsireni do VS Code =====
echo.

set "DIR=%~dp0"
set "VSIX="

rem --- 0) soubor pretazeny na bat nebo zadany jako parametr ---
if not "%~1"=="" (
    if /i "%~x1"==".vsix" if exist "%~1" set "VSIX=%~f1"
)

rem --- 1) hledani balicku: slozka batu, aktualni slozka, Stazene soubory ---
if not defined VSIX call :find "%DIR%"
if not defined VSIX call :find "%CD%\"
if not defined VSIX call :find "%USERPROFILE%\Downloads\"
if not defined VSIX call :find "%USERPROFILE%\Desktop\"

if not defined VSIX (
    echo  CHYBA: nenasel jsem zadny soubor *.vsix.
    echo.
    echo  Hledal jsem v:
    echo    - %DIR%
    echo    - %CD%\
    echo    - %USERPROFILE%\Downloads\
    echo    - %USERPROFILE%\Desktop\
    echo.
    echo  Obsah slozky batu ^(%DIR%^):
    dir /b /a-d "%DIR%" 2>nul
    echo.
    echo  Tipy:
    echo    - Pokud jste bat spustili primo z otevreneho ZIPu, Windows ho rozbalil sam do docasne
    echo      slozky bez VSIX. Nejdriv ZIP cely rozbalte ^(prave tlacitko ^> Extrahovat vse^).
    echo    - Soubor musi mit priponu .vsix ^(ne .zip ani .txt^); prohlizec ho nekdy prejmenuje.
    echo    - Nebo VSIX na tento bat pretahnete mysi, pripadne ho dejte do stejne slozky.
    echo    - Stazeni: https://github.com/dapar777/whisper-agent ^(whisper-agent-0.1.0.vsix^)
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
    echo  CHYBA: instalace selhala ^(kod %errorlevel%^). Zkuste zavrit VS Code a spustit bat znovu,
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

rem --- najde VSIX ve slozce %1 (nejdriv whisper-agent*.vsix, pak libovolny *.vsix); bere posledni podle nazvu = nejvyssi verze ---
:find
set "D=%~1"
if not exist "%D%" exit /b 0
for %%F in ("%D%whisper-agent*.vsix") do if exist "%%~fF" set "VSIX=%%~fF"
if not defined VSIX for %%F in ("%D%*.vsix") do if exist "%%~fF" set "VSIX=%%~fF"
exit /b 0

:fail
echo.
pause
exit /b 1
