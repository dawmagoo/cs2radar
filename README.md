# CS2 WebRadar

Lokalny radar do Counter-Strike 2 oparty na Game State Integration. Pokazuje pozycję, stan gracza i wynik meczu w zakresie danych wysyłanych przez grę. W widoku obserwatora może wyświetlić składy obu drużyn, granaty, bombę i zegar rundy.

## Pobieranie

ZIP ze źródłami jest dostępny w menu **Code → Download ZIP**. Instalator Windows i paczka do pobrania są opisane w [instrukcji Windows](README-WINDOWS.md).

## Radar

- Mapa przełącza się na podstawie danych CS2. Dla Nuke, Vertigo i Train automatyczny wybór poziomu korzysta z wysokości wybranego gracza.
- Kliknij gracza na mapie lub na liście, aby zobaczyć jego telemetrię i wyśrodkować radar. W ustawieniach możesz włączyć śledzenie, zmienić rozmiar znaczników, filtrować drużyny oraz ukryć granaty i pseudonimy.
- Tryb demo pokazuje przykładowy mecz z dwiema drużynami, granatami i bombą.
- W sekcji **Grafika i kalibracja mapy** wczytaj własny PNG, JPG lub WebP. Ustawienia zapisują się dla danej mapy i poziomu w aktualnym profilu.
- Aplikacja Windows pozwala udostępnić podgląd tylko do odczytu na urządzenia w zaufanej sieci lokalnej. Wyłączenie udostępniania zamyka wszystkie połączenia i unieważnia link.

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

### LAN w wersji serwerowej

Ustaw `HOST=0.0.0.0` i dwa różne losowe sekrety w `GSI_TOKEN` oraz `VIEW_TOKEN`. W pobranym pliku GSI, obok sekcji `data`, dodaj `"auth" { "token" "wartość_GSI_TOKEN" }`. Otwórz na drugim urządzeniu adres IP komputera z serwerem i podaj `VIEW_TOKEN` w sekcji **Dostęp LAN**. HTTP i WebSocket przesyłają w tym trybie dane bez szyfrowania. Korzystaj z zaufanej sieci lokalnej.
