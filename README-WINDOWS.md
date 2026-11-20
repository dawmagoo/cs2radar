# CS2 WebRadar na Windows

W sklonowanym repozytorium uruchom `npm ci`, a potem `npm run desktop` albo `npm start`. Wersję przeglądarkową otwórz w Chrome lub Edge pod adresem z terminala.

Włącz CS2, użyj **Przechwyć okno**, wskaż grę i zatwierdź obszar minimapy. W aplikacji możesz zmienić kadr albo zamknąć przechwytywanie. Więcej o kadrowaniu, podglądzie LAN i usunięciu starego pliku WebRadar znajdziesz w [instrukcji projektu](README.md).

## Lokalna kompilacja

Do pracy z kodem potrzebujesz Node.js 24 lub nowszego. Polecenie `npm test` uruchamia testy. `npm run dist:win` pozwala samodzielnie zbudować instalator Windows x64 do katalogu `dist`.
