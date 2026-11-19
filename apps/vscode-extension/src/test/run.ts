import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('harnessx-dev.harnessx-vscode');
  assert.ok(extension, 'HarnessX development extension was not loaded');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('harnessx.openChat'), 'Open Chat command missing');
  assert.ok(commands.includes('harnessx.rollback'), 'Rollback command missing');
  await vscode.commands.executeCommand('harnessx.openChat');
  assert.ok(vscode.workspace.workspaceFolders?.length, 'Test workspace was not opened');
  console.log('HarnessX extension host smoke test passed');
}
