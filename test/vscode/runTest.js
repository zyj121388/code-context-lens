'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const vscodeExecutablePath = findVSCodeExecutable();

  if (!vscodeExecutablePath) {
    throw new Error(
      '找不到 VS Code 可执行文件。请设置 VSCODE_EXECUTABLE 环境变量，例如：\n' +
        '  Windows: $env:VSCODE_EXECUTABLE="C:\\Program Files\\Microsoft VS Code\\Code.exe"\n' +
        '  macOS/Linux: export VSCODE_EXECUTABLE="/path/to/code"',
    );
  }

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exit(1);
  }
}

function findVSCodeExecutable() {
  const fromEnv = process.env.VSCODE_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      'D:\\software\\vscode\\Microsoft VS Code\\Code.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      path.join(process.env.HOME || '', 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
    );
  } else {
    candidates.push('/usr/share/code/code', '/usr/bin/code', '/snap/bin/code');
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

void main();
