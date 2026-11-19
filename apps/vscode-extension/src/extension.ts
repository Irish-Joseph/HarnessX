import * as vscode from 'vscode';
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('harnessx.showStatus', () => {
    void vscode.window.showInformationMessage('HarnessX starter is active. Model integrations are coming next.');
  }));
}
export function deactivate(): void {}
