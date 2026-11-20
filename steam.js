'use strict';

const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const gameName = 'Counter-Strike Global Offensive';

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

module.exports = { findConfigDirectory, resolveConfigDirectory };
