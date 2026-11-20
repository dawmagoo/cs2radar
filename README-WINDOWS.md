# CS2 WebRadar na Windows

## Szybki start

1. Sklonuj repozytorium. W jego katalogu uruchom `npm ci`, a następnie `npm run desktop` na Windows x64 z Node.js 24 lub nowszym.
2. Otwórz **CS2 WebRadar**. Program wykrywa bibliotekę Steam i instaluje plik GSI w znalezionej grze. Stan konfiguracji znajdziesz pod przyciskiem **Konfiguracja GSI**.
3. Jeśli potrzebujesz wskazać inną instalację, wybierz **Wybierz folder CS2**. Przy folderze chronionym przed zapisem użyj **Zapisz plik GSI** i skopiuj plik do `game/csgo/cfg` w instalacji gry.
4. Uruchom lub zrestartuj CS2. Wybierz **Tryb demo**, aby wypróbować radar bez gry.

Po zajęciu domyślnego portu 3000 aplikacja używa wolnego portu do 3010 i aktualizuje konfigurację GSI. Przy aktualizacji zapisuje kopię zastępowanego pliku. Dla pliku edytowanego ręcznie udostępnia przycisk **Zastąp z kopią**.

## Podgląd na telefonie

W aplikacji kliknij **Udostępnij LAN**, wybierz adres komputera i włącz podgląd. Otwórz skopiowany link na urządzeniu w tej samej zaufanej sieci. Link działa do momentu wyłączenia podglądu lub zamknięcia aplikacji. Podgląd pobierze grafikę i kalibrację z komputera hosta. Przejdź do **Grafika i kalibracja mapy**, aby ustawić je na komputerze.

## Lokalna kompilacja

W katalogu projektu, w systemie Windows z Node.js 24, uruchom:

```powershell
npm ci
npm test
npm run dist:win
```

Instalator zostanie zapisany w `dist`. Polecenie `npm run dist:win:portable` tworzy również wersję przenośną.

Zbudowany instalator jest niesygnowany. Zainstalowaną wersję można odinstalować w **Ustawieniach Windows → Aplikacje**. Dane profilu radaru i plik GSI w katalogu Steam można usunąć osobno.
