const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;
runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '../apps/vscode-extension'),
  extensionTestsPath: path.resolve(__dirname, '../apps/vscode-extension/dist/test/run.js'),
  cachePath: path.resolve(__dirname, '../.vscode-test'),
  launchArgs: [path.resolve(__dirname, '..'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
  reuseMachineInstall: false
}).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
