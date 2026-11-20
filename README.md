# CS2 WebRadar

Radar meczu Counter-Strike 2 z transmisji obserwatora CSTV, telemetrią GSI i podglądem minimapy. Aplikacja działa bez zapisywania konfiguracji w katalogu gry.

## Uruchomienie

W katalogu sklonowanego repozytorium użyj Node.js 24 lub nowszego.

```sh
npm ci
npm start
```

Otwórz adres z terminala w Chrome lub Edge na komputerze z grą. Polecenie `npm run desktop` otwiera ten sam interfejs w osobnym oknie.

## Mapa i pozycje z CSTV

1. Weź od organizatora adres przekaźnika meczu w formacie **CSTV HTTP**.
2. Wybierz **Transmisja CSTV**, wklej adres i kliknij **Połącz z transmisją**.
3. Po nadejściu danych radar wybierze mapę z transmisji, narysuje odebrane pozycje CT i T i pokaże skład drużyn, wynik, zdrowie, pancerz, gotówkę oraz aktywną broń, jeśli są dostępne.

Pozycje X, Y i Z pochodzą z klatek obserwatora. Aplikacja przekłada X i Y na znaczniki względem kalibracji mapy, a Z służy do wyboru poziomu mapy. Pasek nad radarem pokazuje liczbę odebranych pozycji żywych graczy w obu drużynach. Czas i uprawnienia widza zależą od transmisji organizatora.

Adres CSTV wskazuje przekaźnik HTTP(S) dostarczający transmisję w formacie Valve. Do odczytu aplikacja używa [cs2parser](https://github.com/osztenkurden/cs2parser/blob/master/docs/http-broadcast.md).

## Podgląd minimapy z okna

1. Włącz CS2 i wejdź do widoku, w którym widać minimapę.
2. W radarze wybierz **Przechwyć okno** i wskaż okno gry.
3. Przesuń kwadrat na minimapę, w razie potrzeby dostosuj jego rozmiar i kliknij **Użyj kadru**.
4. Użyj **Zmień kadr**, gdy zmienisz rozdzielczość lub układ interfejsu gry. **Zakończ** zamyka przechwytywanie.

Kadr pokazuje wyłącznie piksele z zaznaczonego fragmentu okna. Nazwa mapy, pozycje, zdrowie i pozostałe statystyki wymagają źródła telemetrii.

Gdy w wybranym oknie widać czarny obraz, spróbuj ustawić w CS2 tryb okna bez ramek i wybrać okno ponownie. W wersji przeglądarkowej karta radaru musi pozostać otwarta. [Dokumentacja przechwytywania ekranu](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

## Podgląd LAN

Wybierz **Udostępnij LAN** i otwórz link na urządzeniu w tej samej zaufanej sieci. Odbiorca widzi telemetrię z aktywnego źródła hosta. Aby dołączyć obraz minimapy, zaznacz **Przekazuj ten kadr do aktywnego podglądu LAN** przy zatwierdzaniu kadru. Do odbiorcy trafia tylko zatwierdzony kwadrat, bez dźwięku. Klatki są przekazywane w pamięci i wygasają po zakończeniu przechwytywania albo wyłączeniu podglądu.

## Telemetria i mapy

Istniejący zewnętrzny strumień GSI może przekazywać JSON do `POST /gsi`. Nazwa mapy pochodzi z `map.name`, a pozycje drużyn z `allplayers.*.position` w danych obserwatora. W trybie gracza GSI udostępnia dane lokalnego gracza i stan meczu. **Tryb demo** pokazuje przykładowe dane.

Obraz mapy do podglądu telemetrii dodasz w **Mapy**. Możesz również zaimportować wcześniejszy eksport PNG, JPG lub WebP z dopasowaną nazwą mapy.

```sh
npm run maps:import -- --from /sciezka/do/eksportu
```

Opcja `--viewer <ścieżka do Source2Viewer-CLI>` pozwala odczytać grafiki z lokalnego VPK. Parametr `--cs2` wskazuje katalog gry. Import zapisuje wynik w profilu radaru. [Source 2 Viewer CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html)

## Spójność plików CS2

Jeśli starszy WebRadar zapisał `gamestate_integration_webradar.cfg` w `game/csgo/cfg`, zamknij poprzednią wersję i przenieś ten konkretny plik poza katalog gry. Następnie w Steam otwórz **CS2 → Właściwości → Zainstalowane pliki → Sprawdź spójność plików gry**. [Pomoc Steam](https://help.steampowered.com/pl/faqs/view/0C48-FCBD-DA71-93EB)

Testy uruchomisz przez `npm test`.
