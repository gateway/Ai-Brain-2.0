# One Solid App

## What "one app" means here

Do not collapse the UI and the memory runtime into one tangled codebase module. Instead, make the product one app operationally:

- one repo root
- one root `package.json`
- one root `npm run dev`
- one root `npm run serve`
- one root quality gate path
- one product architecture document

That gives operators and developers one app experience without destroying the runtime boundary that protects the brain.

## Recommended End State

### Product boundary

- `brain-console` stays the operator shell
- `local-brain` stays the controlled brain/runtime service

### Operational boundary

- root scripts own orchestration
- shared env defaults live at the repo root
- CI/CD should run root commands, not package-by-package ad hoc flows

### Quality boundary

- repo-level typecheck, tests, lint, and guardrails
- browser smoke for graph/intake/operator-critical flows
- runtime truth-state tests for intake and model-run status

## Future consolidation path

If you want this to feel even more unified later:

1. move to a proper workspace toolchain at root
2. add a single env loader and config surface
3. add root CI that calls only root scripts
4. package the runtime + console together for local/prod deploys

Do not merge core brain mutations into Next.js route handlers just to make it "feel" like one app.
