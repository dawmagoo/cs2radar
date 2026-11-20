# CS2 WebRadar na Windows

W sklonowanym repozytorium uruchom `npm ci`, a potem `npm run desktop` albo `npm start`. Wersję przeglądarkową otwórz w Chrome lub Edge pod adresem z terminala.

Wybierz **Transmisja CSTV** i wklej adres przekaźnika HTTP od organizatora, aby zobaczyć mapę i pozycje drużyn z transmisji obserwatora. Osobny przycisk **Przechwyć okno** pozwala zaznaczyć fragment minimapy wyświetlanej w grze. [Instrukcja projektu](README.md)

## Lokalna kompilacja

Do pracy z kodem potrzebujesz Node.js 24 lub nowszego. Polecenie `npm test` uruchamia testy. `npm run dist:win` pozwala samodzielnie zbudować instalator Windows x64 do katalogu `dist`.
