# Instalator Windows (EXE)

Projekt wykorzystuje Electron oraz electron-builder (NSIS). W repozytorium istnieje skrypt `npm run dist:win`, który tworzy instalator dla Windows x64.

## Bez lokalnej kompilacji

1. Otwórz zakładkę **Actions** w GitHub.
2. Wybierz **Windows installer**.
3. Kliknij **Run workflow** (gałąź `main` po scaleniu zmian).
4. Poczekaj na zakończenie testów i budowania.
5. W szczegółach zakończonego uruchomienia pobierz artefakt **CS2-WebRadar-Windows-Installer**.
6. Rozpakuj pobrany artefakt ZIP i uruchom znajdujący się w nim instalator EXE.

Instalator tworzy skróty w menu Start i na pulpicie zgodnie z konfiguracją `package.json`. Na komputerze docelowym nie trzeba instalować Node.js.

## Kompilacja lokalna

Na Windows z Node.js 24+:

```powershell
npm ci
npm test
npm run dist:win
```

Instalator będzie w katalogu `dist/`.

## Zakres funkcji

Obecne repozytorium obsługuje CSTV, GSI i przechwytywanie minimapy. **Nie zawiera czytnika pamięci procesu CS2 ani funkcjonalności external-memory radar 1:1.** Instalator nie dodaje takich funkcji.

Budowanie w GitHub Actions weryfikuje testy i powodzenie pakowania, ale nie zastępuje testu działania programu z uruchomioną grą na Windows. W przypadku błędu testów artefakt nie powstanie.
