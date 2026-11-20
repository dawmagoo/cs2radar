# CS2 WebRadar

Podgląd minimapy z okna Counter-Strike 2 oraz panel telemetrii. Przechwytywanie działa przez standardowy wybór okna lub ekranu. Radar korzysta z obrazu widocznego w grze i nie zapisuje konfiguracji w jej katalogu.

## Uruchomienie

W katalogu sklonowanego repozytorium użyj Node.js 24 lub nowszego.

```sh
npm ci
npm start
```

Otwórz adres z terminala w Chrome lub Edge na komputerze z grą. Polecenie `npm run desktop` otwiera ten sam interfejs w osobnym oknie.

1. Włącz CS2 i wejdź do widoku, w którym widać minimapę.
2. W radarze wybierz **Przechwyć okno** i wskaż okno gry.
3. Przesuń kwadrat na minimapę, w razie potrzeby dostosuj jego rozmiar i kliknij **Użyj kadru**.
4. Użyj **Zmień kadr**, gdy zmienisz rozdzielczość lub układ interfejsu gry. **Zakończ** zamyka przechwytywanie.

Gdy w wybranym oknie widać czarny obraz, spróbuj ustawić w CS2 tryb okna bez ramek i wybrać okno ponownie. W wersji przeglądarkowej karta radaru musi pozostać otwarta. [Dokumentacja przechwytywania ekranu](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

## Podgląd LAN

Wybierz **Udostępnij LAN** i otwórz link na urządzeniu w tej samej zaufanej sieci. Aby dołączyć obraz minimapy, zaznacz **Przekazuj ten kadr do aktywnego podglądu LAN** przy zatwierdzaniu kadru. Do odbiorcy trafia tylko zatwierdzony kwadrat, bez dźwięku. Klatki są przekazywane w pamięci i wygasają po zakończeniu przechwytywania albo wyłączeniu podglądu.

## Telemetria i mapy

Istniejący zewnętrzny strumień GSI może przekazywać JSON do `POST /gsi`. Radar wyświetla pola udostępniane przez źródło, w tym pozycje drużyn dostępne w widoku obserwatora. Do sprawdzenia działania bez strumienia użyj **Tryb demo**.

Obraz mapy do podglądu telemetrii dodasz w **Mapy**. Możesz również zaimportować wcześniejszy eksport PNG, JPG lub WebP z dopasowaną nazwą mapy.

```sh
npm run maps:import -- --from /sciezka/do/eksportu
```

Opcja `--viewer <ścieżka do Source2Viewer-CLI>` pozwala odczytać grafiki z lokalnego VPK. Parametr `--cs2` wskazuje katalog gry. Import zapisuje wynik w profilu radaru. [Source 2 Viewer CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html)

## Spójność plików CS2

Jeśli starszy WebRadar zapisał `gamestate_integration_webradar.cfg` w `game/csgo/cfg`, zamknij poprzednią wersję i przenieś ten konkretny plik poza katalog gry. Następnie w Steam otwórz **CS2 → Właściwości → Zainstalowane pliki → Sprawdź spójność plików gry**. [Pomoc Steam](https://help.steampowered.com/pl/faqs/view/0C48-FCBD-DA71-93EB)

Testy uruchomisz przez `npm test`.
