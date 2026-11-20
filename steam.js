'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const configName = 'gamestate_integration_webradar.cfg';
const template = readFileSync(path.join(__dirname, configName), 'utf8');
const previousTemplate = template.slice(0, template.indexOf('    "player_match_stats"')) + '  }\n}\n';
const legacy = previousTemplate.replace('"heartbeat" "8.0"', '"heartbeat" "30.0"').replace('    "round" "1"\n', '');
const exec = promisify(execFile);
const gameName = 'Counter-Strike Global Offensive';

function renderGsiConfig(port, token = '', source = template) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Nieprawidłowy port GSI.');
  if (typeof token !== 'string' || token.length > 512 || /["\\\x00-\x1f\x7f]/.test(token)) {
    throw new Error('Token GSI musi być ciągiem bez cudzysłowów, ukośników odwrotnych i znaków sterujących.');
  }
  const config = source.replace('127.0.0.1:3000', `127.0.0.1:${port}`);
  return token ? config.replace('  "data"', `  "auth"\n  {\n    "token" "${token}"\n  }\n  "data"`) : config;
}

function normalize(content) {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

function readManagedConfig(content) {
  const oldPort = Number(content.match(/"uri"\s+"http:\/\/127\.0\.0\.1:(\d{1,5})\/gsi"/)?.[1]);
  if (!Number.isInteger(oldPort) || oldPort < 1 || oldPort > 65_535) return null;
  const oldToken = content.match(/"token"\s+"([^"\r\n]*)"/)?.[1] ?? '';
  try {
    const managed = [template, previousTemplate, legacy]
      .some(source => normalize(content) === normalize(renderGsiConfig(oldPort, oldToken, source)));
    return managed ? { port: oldPort, token: oldToken } : null;
  } catch {
    return null;
  }
}

function vdfStrings(content, key) {
  const pattern = new RegExp(`"${key}"\\s+"((?:\\\\.|[^"\\\\])*)"`, 'gi');
  return [...content.matchAll(pattern)].map(match => match[1].replace(/\\([\\"])/g, '$1'));
}

function vdfLibraryFolders(content) {
  const legacyPaths = vdfStrings(content, '\\d+').filter(folder => /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(folder));
  return [...vdfStrings(content, 'path'), ...legacyPaths];
}

async function steamRegistryRoots() {
  if (process.platform !== 'win32') return [];
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath",
    "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath",
    "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath",
  ].join('; ');
  try {
    const { stdout } = await exec(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 4000, maxBuffer: 32_768, encoding: 'utf8',
    });
    return stdout.split(/\r?\n/).map(folder => folder.trim()).filter(folder => path.isAbsolute(folder));
  } catch {
    return [];
  }
}

async function resolveConfigDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) return null;
  const candidates = [
    input,
    path.join(input, 'cfg'),
    path.join(input, 'csgo', 'cfg'),
    path.join(input, 'game', 'csgo', 'cfg'),
  ];
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() !== 'cfg') continue;
    try {
      const [directory, gameinfo] = await Promise.all([
        fs.stat(candidate),
        fs.stat(path.join(candidate, '..', 'gameinfo.gi')),
      ]);
      if (directory.isDirectory() && gameinfo.isFile()) return await fs.realpath(candidate);
    } catch {
      // Try the next directory layout.
    }
  }
  return null;
}

async function findConfigDirectory(preferred, explicitRoots) {
  const previous = await resolveConfigDirectory(preferred);
  if (previous) return previous;

  const env = process.env;
  const defaultRoots = [
    env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA,
  ].filter(Boolean).map(folder => path.join(folder, 'Steam'));
  if (env.SystemDrive) defaultRoots.push(`${env.SystemDrive}\\Steam`, `${env.SystemDrive}\\SteamLibrary`);
  if (process.platform === 'win32') {
    for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      defaultRoots.push(`${drive}:\\SteamLibrary`, `${drive}:\\Steam`);
    }
  }
  if (process.platform === 'linux') {
    defaultRoots.push(path.join(env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'Steam'),
      path.join(homedir(), '.steam', 'steam'), path.join(homedir(), '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'));
  }
  if (process.platform === 'darwin') defaultRoots.push(path.join(homedir(), 'Library', 'Application Support', 'Steam'));
  const roots = explicitRoots ?? [...await steamRegistryRoots(), ...defaultRoots];
  const libraries = new Set(roots.filter(root => path.isAbsolute(root)).map(root => path.normalize(root)));
  const libraryFiles = [...libraries].map(root => path.join(root, 'steamapps', 'libraryfolders.vdf'));
  const lists = await Promise.all(libraryFiles.map(file => fs.readFile(file, 'utf8').catch(() => '')));
  for (const content of lists) {
    for (const library of vdfLibraryFolders(content)) {
      if (path.isAbsolute(library)) libraries.add(path.normalize(library));
    }
  }

  const candidates = await Promise.all([...libraries].map(async library => {
    const apps = path.join(library, 'steamapps');
    const manifest = await fs.readFile(path.join(apps, 'appmanifest_730.acf'), 'utf8').catch(() => '');
    const folder = vdfStrings(manifest, 'installdir')[0];
    const installDir = folder && !/[\\/:]/.test(folder) && folder !== '..' && folder !== '.' ? folder : gameName;
    const directory = await resolveConfigDirectory(path.join(apps, 'common', installDir));
    return { directory, installed: vdfStrings(manifest, 'appid')[0] === '730' };
  }));
  return (candidates.find(candidate => candidate.directory && candidate.installed)
    ?? candidates.find(candidate => candidate.directory))?.directory ?? null;
}

async function installGsiConfig(directory, port, token, { replace = false, preserveToken = false } = {}) {
  const target = path.join(directory, configName);
  let existing;
  try {
    existing = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(target, renderGsiConfig(port, token), { flag: 'wx' });
    return { state: 'restart', path: target };
  }

  const managed = readManagedConfig(existing);
  const effectiveToken = preserveToken && !token && managed ? managed.token : token;
  const config = renderGsiConfig(port, effectiveToken);
  if (normalize(existing) === normalize(config)) return { state: 'ready', path: target };
  if (!replace && !managed) return { state: 'conflict', path: target };

  const suffix = randomUUID().slice(0, 8);
  const backup = `${target}.${Date.now()}-${suffix}.bak`;
  const temporary = `${target}.${suffix}.tmp`;
  await fs.writeFile(backup, existing, { flag: 'wx' });
  try {
    await fs.writeFile(temporary, config, { flag: 'wx' });
    if (await fs.readFile(target, 'utf8') !== existing) return { state: 'conflict', path: target };
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { state: 'restart', path: target, backup };
}

module.exports = { configName, findConfigDirectory, installGsiConfig, renderGsiConfig, resolveConfigDirectory };
