import * as vscode from 'vscode';
import { ChatView } from './view';
export function activate(context: vscode.ExtensionContext): void {
  const chat = new ChatView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('harnessx.chat', chat));
  context.subscriptions.push(vscode.commands.registerCommand('harnessx.openChat', () => vscode.commands.executeCommand('harnessx.chat.focus')));
  context.subscriptions.push(vscode.commands.registerCommand('harnessx.rollback', () => chat.rollback()));
}
export function deactivate(): void {}
