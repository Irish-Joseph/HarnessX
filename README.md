# HarnessX

Provider-independent, budget-aware coding harness — **starter scaffold**, not yet a full autonomous agent.

## Included
- TypeScript core with deterministic model selection and a cost guard
- Unit tests using Node's built-in test runner
- VS Code extension with a `HarnessX: Show Status` command
- GitHub Actions CI and a containerized sandbox option

## Requirements
Node.js 22+, npm, VS Code 1.96+ (for extension testing).

## Quick start
```bash
npm install
npm test
code .
```
Press **F5** in VS Code to launch the Extension Development Host, then run `HarnessX: Show Status` from the command palette.

## Sandbox
Use the supplied `Dockerfile` or `.devcontainer/devcontainer.json` for an isolated Node environment. No model API key is required.

## Architecture
`packages/core` contains provider-agnostic budget and routing primitives. `apps/vscode-extension` is a minimal extension entry point. **No real LLM requests, file writes, or terminal execution are implemented yet.** These require permissions, sandboxing, and careful review.

## Repository
Source: https://github.com/Irish-Joseph/HarnessX

Do not commit credentials.

## License
MIT
