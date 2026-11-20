# CS2 WebRadar

Lokalny radar do Counter-Strike 2 oparty na Game State Integration. Pokazuje pozycję, stan gracza i wynik meczu w zakresie danych wysyłanych przez grę. W widoku obserwatora może wyświetlić składy obu drużyn, granaty, bombę i zegar rundy.

## Pobieranie

Sklonuj repozytorium i uruchom aplikację w trybie desktopowym albo w przeglądarce. Konfiguracja Steam dla wersji desktopowej jest opisana w [instrukcji Windows](README-WINDOWS.md).

## Radar

- Mapa przełącza się na podstawie danych CS2. Dla Nuke, Vertigo i Train automatyczny wybór poziomu korzysta z wysokości wybranego gracza.
- Kliknij gracza na mapie lub na liście, aby zobaczyć jego telemetrię i wyśrodkować radar. W ustawieniach możesz włączyć śledzenie, zmienić rozmiar znaczników, filtrować drużyny oraz ukryć granaty i pseudonimy.
- Znaczniki płynnie przechodzą między kolejnymi pozycjami. Ślady granatów pokazują pozycje odebrane w GSI. Tryb demo pokazuje przykładowy mecz z dwiema drużynami, granatami i bombą.
- W sekcji **Grafika i kalibracja mapy** wczytaj PNG, JPG lub WebP. Obraz i granice mapy zapisują się na komputerze hosta dla danej mapy i poziomu.
- **Udostępnij LAN** działa także po zwykłym `npm start`. Telefon dostaje tę samą mapę, kalibrację i telemetrię. Odświeżenie karty zachowuje dostęp w tej karcie. Wyłączenie udostępniania unieważnia link.

Radar wyświetla dane obserwatora, które CS2 umieszcza w GSI. Dostępność pozycji, stanu bomby i pozostałych pól zależy od trybu gry. [Pola strumienia GSI](https://github.com/antonpup/CounterStrike2GSI/blob/master/CounterStrike2GSI/GameState.cs)

## Lokalna kompilacja

Do pracy ze źródłami potrzebujesz Node.js 24 lub nowszego.

```sh
npm ci
npm test
npm run desktop
```

Samą wersję przeglądarkową uruchomisz przez `npm start`. Wejdź na [http://127.0.0.1:3000](http://127.0.0.1:3000), pobierz konfigurację GSI z aplikacji, skopiuj ją do `game/csgo/cfg` w katalogu CS2 i uruchom grę ponownie.

### Widoki map

Radar zawiera siatkę współrzędnych i zakresy startowe dla Mirage, Dust II, Inferno, Nuke, Ancient, Anubis, Vertigo, Overpass, Train i Cache. Grafiki dodajesz przez aplikację lub jako PNG w [public/maps](public/maps/README.txt). Zakresy map są ustawione dla pełnego, niekadrowanego widoku 1024 × 1024, na podstawie pól `pos_x`, `pos_y` i `scale`. [Metadane widoków map CS2](https://github.com/SteamTracking/GameTracking-CS2/tree/master/game/csgo/pak01_dir/resource/overviews)

### Import grafik z CS2

Źródłem grafik może być lokalna instalacja gry. Zainstalowany [Source 2 Viewer CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html) odczyta grafiki radaru oraz zakresy współrzędnych z lokalnego `pak01_dir.vpk`. Parametr `--cs2` jest opcjonalny, gdy aplikacja wykrywa Steam.

```powershell
npm run maps:import -- --viewer "C:\ścieżka\Source2Viewer-CLI.exe" --cs2 "D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive"
```

Jeśli grafiki są już wyeksportowane, wskaż folder z plikami PNG, JPG lub WebP. Nazwy takie jak `de_mirage_radar_psd.png`, `de_nuke_lower_radar_psd.png` i `de_nuke_lower.png` są rozpoznawane automatycznie. Jeżeli w eksporcie są też pliki podglądu map `de_mirage.txt` itd., ich zakresy wczytają się wraz z grafikami.

```sh
npm run maps:import -- --from /sciezka/do/eksportu
```

Import zachowuje istniejące grafiki, chyba że podasz `--replace`. Serwer i aplikacja korzystają z tego samego katalogu map w profilu użytkownika. Możesz wskazać inny przez `RADAR_DATA_DIR`. Repozytorium zawiera kod i siatkę współrzędnych, a grafiki pozostają u hosta.

### Ręczna konfiguracja LAN

Jeśli potrzebujesz stałego portu i własnych tokenów, ustaw `HOST=0.0.0.0` i dwa różne losowe sekrety w `GSI_TOKEN` oraz `VIEW_TOKEN`. W pobranym pliku GSI, obok sekcji `data`, dodaj `"auth" { "token" "wartość_GSI_TOKEN" }`. Otwórz na drugim urządzeniu adres IP komputera z serwerem i podaj `VIEW_TOKEN` w sekcji **Dostęp LAN**. HTTP i WebSocket przesyłają w tym trybie dane bez szyfrowania. Korzystaj z zaufanej sieci lokalnej.
