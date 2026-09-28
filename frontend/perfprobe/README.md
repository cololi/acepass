# frontend/perfprobe — W3 first-screen bundle probe

Evidence for the W3 optimisation (route-level code splitting + on-demand KaTeX).
Nothing in here is imported by the app; `frontend/dist` and `frontend/src` are
the only things that ship.

## Files

| Path | What it is |
|---|---|
| `measure-assets.mjs` | The measuring tape. Reads `frontend/dist`, follows the static-import graph from the entry chunk and writes a JSON report. |
| `baseline.json` | Before-state, produced from the unmodified build (`886,357 B` entry). |
| `after.json` | After-state, produced by the same command on the optimised build. |
| `dist-before/index-*.js`, `dist-before/index-*.css` | The two before-build entry artefacts, kept so the numbers can be re-derived without rebuilding the old tree. KaTeX font files are **not** copied. |
| `dist-before/manifest.txt` | Full before-build `dist/assets` listing with byte + gzip sizes. |
| `run-acceptance.sh` | The browser acceptance run (p2-batch3 isolated resources, browser lock, lock released by trap). |
| `math-harness/`, `math-probe.mjs` | Real-browser probe for the on-demand KaTeX path. The acceptance fixture contains no maths blocks, so this is what proves `await import('katex')` still renders a formula — in dev **and** in a production build + `vite preview`. |
| `vitest-before-after.txt` | Evidence that `npm run test` was already broken before W3 (vitest was collecting the Playwright specs) and what changed. |
| `vite.config.before.ts` | Verbatim copy of the pre-W3 `vite.config.ts` (`git show HEAD:frontend/vite.config.ts`), used only to reproduce the vitest failure. |

## Reproduce

```bash
cd frontend
npm run build
node perfprobe/measure-assets.mjs --label after --out perfprobe/after.json
node perfprobe/math-probe.mjs          # needs a free 5199 and a real browser
```

The measured numbers are in the task report; `baseline.json`/`after.json` are the
raw source of truth.

## What the numbers mean

- `entryJson` — the `<script type="module">` in `dist/index.html`.
- `firstLoadJs` — entry chunk plus every chunk reachable through **static**
  imports (what a cold first paint must download, including the `modulepreload`
  links Vite writes into `index.html`).
- `deferredJs` — chunks reachable only through `import()`: route pages and KaTeX.
- `distBytes` — the whole `dist/` directory. It barely moves, because the KaTeX
  **font files** are still emitted next to it; they are only fetched when a
  formula is actually typeset.
