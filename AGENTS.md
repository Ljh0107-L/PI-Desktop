# Pi Desktop

## Releases

- Use the lightweight `CI` workflow for routine releases. It builds the renderer and runs `npm run test:critical`. Run focused tests for the code you changed.
- Push `main` and its version tag together so packaging can run while CI checks the same commit. Publication requires that CI run and the packaged app smoke test to pass.
- Keep `Full regression CI` manual. Dispatch it only when the user explicitly asks for the full suite.
