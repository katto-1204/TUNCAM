# TUNCAM

Offline-first Progressive Web App for standardized tuna sample capture, immediate expert grading, local session tallying, and dataset manifest export.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- `pnpm --filter @workspace/tuncam run typecheck` — check the TUNCAM frontend
- `PORT=18711 BASE_PATH=/ pnpm --filter @workspace/tuncam run build` — production build check

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/tuncam/src/App.tsx` — complete capture session experience and local workflow state
- `artifacts/tuncam/src/index.css` — TUNCAM visual language and responsive dashboard layout
- `artifacts/tuncam/public/manifest.webmanifest` — PWA metadata
- `artifacts/tuncam/public/sw.js` — offline shell cache
- `attached_assets/TUNCAM_PRD_(2)_1786979496947.md` — product requirements source

## Architecture decisions

- The first build is frontend-only and offline-first: session records persist in local browser storage instead of a cloud API.
- Camera capture uses browser media APIs, with explicit no-camera and permission-denied states rather than fake preview data.
- The capture-to-grade loop is blocking by design: every captured sample must receive Grade A, B, C, or Invalid before the next action.
- Browser capabilities such as folder access, wake lock, storage estimates, and install prompts are detected at runtime and get a graceful fallback when unavailable.

## Product

TUNCAM gives a field operator one tablet-friendly workspace for configuring a session, selecting a sample type, framing and capturing tuna samples, assigning an expert grade, reviewing/removing local captures, tracking progress toward the 800-image target, and exporting a local CSV or JSON manifest for dataset auditing.

## User preferences

- Light mode only with a soft blue-to-white gradient visual language.
- Prefer a cohesive, dense three-panel dashboard over a sprawling multi-page form.

## Gotchas

- Camera access requires a secure browser context and user permission; the UI must keep the no-camera state actionable.
- The browser can persist image metadata and thumbnails, but direct local-folder writes depend on File System Access API support.
- PWA install and offline caching are browser-dependent; verify the service worker after serving a production build.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
