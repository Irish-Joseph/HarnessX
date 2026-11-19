# Contributing to HarnessX

HarnessX welcomes focused bug fixes, tests, documentation, and provider or tool integrations. Read the [README](README.md) for the current architecture and limits before proposing a change.

## Development setup

1. Install Node.js 22+, npm, and VS Code 1.96+.
2. Run `npm ci` and `npm test` from the repository root.
3. For command-execution work, start Docker and run the opt-in sandbox test documented in the README.
4. For extension work, run `npm run test:extension` and launch the extension with F5 in VS Code.
5. For live agent behavior, use a disposable repository with Ollama and Docker. `npm run test:live` exercises the Qwen-compatible local workflow when the model is installed.

## Pull requests

- Open an issue first for broad behavior changes so the intended workflow is clear.
- Keep changes scoped and explain the user-visible behavior, tests run, and any unverified paths.
- Add a meaningful regression test when fixing a bug or changing a safety boundary.
- Preserve explicit approval for host edits and Git mutations, and keep model-driven commands inside the Docker copy.
- Do not commit API keys, `.env` files, local session data, downloaded models, `node_modules`, `dist`, or `.vscode-test` contents.
- Run `git diff --check` and review the staged file list before submitting.

## Issues and security

For a bug, include the operating system, Node.js and VS Code versions, provider/model, steps to reproduce, expected behavior, and relevant redacted logs. Never post credentials or private repository content. If a report contains a security issue, avoid publishing exploit details or secrets in a public issue; contact the repository maintainer privately through GitHub first.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
