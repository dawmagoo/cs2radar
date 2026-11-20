'use strict';

const path = require('node:path');
const { configName, findConfigDirectory, installGsiConfig, resolveConfigDirectory } = require('./steam');

const messages = {
  checking: 'Szukam folderu Counter-Strike 2 w bibliotekach Steam.',
  ready: 'Plik GSI wskazuje ten radar. Jeśli CS2 było otwarte podczas konfiguracji, zamknij je całkowicie i uruchom ponownie.',
  restart: 'Zapisano plik GSI. Zamknij całkowicie CS2, uruchom ponownie i wejdź do meczu albo do trybu obserwatora.',
  conflict: 'Znaleziono zmieniony plik WebRadar. Użyj „Zastąp z kopią”, aby zapisać właściwy adres odbiornika.',
  missing: 'Nie znaleziono CS2 w bibliotekach Steam. Wskaż folder z plikami gry w sekcji „Konfiguracja GSI”.',
  invalid: 'Wskaż folder instalacji CS2 zawierający game/csgo/cfg albo sam folder cfg.',
  error: 'Zapis konfiguracji nie powiódł się. Sprawdź szczegóły albo pobierz plik GSI i skopiuj do game/csgo/cfg.',
};

function createGsiSetup({ port, token = '', preferred = '', preserveToken = false, remember = async () => {} }) {
  const result = (state, extra) => ({ state, port, message: messages[state], ...extra });
  let status = result('checking');
  let directory;
  let queue = Promise.resolve();

  function run(action) {
    const task = queue.then(async () => {
      try {
        status = await action();
      } catch (error) {
        const detail = ['EPERM', 'EACCES'].includes(error.code) ? 'System odmówił zapisu do folderu CS2.' : error.message;
        status = result('error', { detail, path: directory && path.join(directory, configName) });
      }
      return status;
    });
    queue = task;
    return task;
  }

  async function install(target, replace = false) {
    directory = target;
    const setup = await installGsiConfig(target, port, token, { replace, preserveToken });
    let detail;
    try {
      await remember(target);
    } catch {
      detail = 'Nie udało się zapamiętać folderu na kolejne uruchomienie.';
    }
    if (setup.state === 'ready' && status.state === 'restart' && status.path === setup.path) return status;
    return result(setup.state, { ...setup, detail });
  }

  return {
    status: () => status,
    detect: () => run(async () => {
      const candidate = await findConfigDirectory(directory || preferred);
      return candidate ? install(candidate) : result('missing');
    }),
    choose: input => run(async () => {
      const clean = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : '';
      const candidate = await resolveConfigDirectory(clean);
      return candidate ? install(candidate) : result('invalid');
    }),
    replace: () => run(async () => {
      if (status.state !== 'conflict' || !directory) return status;
      const candidate = await resolveConfigDirectory(directory);
      return candidate ? install(candidate, true) : result('missing');
    }),
  };
}

module.exports = { createGsiSetup };
