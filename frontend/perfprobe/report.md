# W3 before/after · frontend first-screen bundle

Command for both columns (same command, no estimation):

```bash
cd frontend && npm run build && node perfprobe/measure-assets.mjs --label <before|after> --out perfprobe/<baseline|after>.json
```

| artefact | before | after | change |
|---|---:|---:|---:|
| entry JS (`dist/assets/index-*.js`) | 886,357 B | 39,762 B | 4.5% of before |
| entry JS, gzip | 260,385 B | 12,490 B | 4.8% |
| first-load JS (entry + static imports) | 886,357 B (1 chunk) | 342,882 B (3 chunks) | 38.7% of before |
| first-load JS, gzip | 260,385 B | 107,870 B | 41.4% |
| entry CSS | 36,459 B | 7,376 B | 20.2% |
| deferred JS (on demand only) | 0 B | 548,365 B in 16 chunks | route pages + KaTeX off the first screen |
| `dist/` total | 1,995,764 B (61 files) | 2,000,859 B (80 files) | KaTeX font files are still emitted, just never fetched up front |

Target: entry JS <= 65% of baseline = 576,132 B.

- entry JS: **39,762 B = 4.5%** of baseline -> PASS (true)
- first-load JS total: **342,882 B = 38.7%** of baseline -> PASS (true)

## First-load chunk graph (after)

| chunk | bytes | gzip | role |
|---|---:|---:|---|
| `assets/index-CizSZg1U.js` | 886,357 | 260,385 | entry |
| `assets/CandidateReviewPage-Ca09KJmM.js` | 24,155 | 8,686 | deferred |
| `assets/Content-Esn1vM1B.js` | 1,983 | 1,009 | deferred |
| `assets/ExposurePanel-D3Et3ChA.js` | 6,922 | 3,024 | deferred |
| `assets/GradingPage-51COvx-P.js` | 9,125 | 3,834 | deferred |
| `assets/ImportsPage-CeQ93Kgz.js` | 17,059 | 5,666 | deferred |
| `assets/KnowledgePage-etHTjjmO.js` | 50,189 | 14,026 | deferred |
| `assets/LayoutReview-CI2WggPY.js` | 6,712 | 2,809 | deferred |
| `assets/MemoryPage-BUfNYu2v.js` | 11,397 | 3,994 | deferred |
| `assets/PracticePage-CNFcQy6m.js` | 64,416 | 19,922 | deferred |
| `assets/QuestionBankPage-BoU4t5uL.js` | 27,505 | 8,870 | deferred |
| `assets/ReportsPage-DTHMjy_0.js` | 36,185 | 10,110 | deferred |
| `assets/ReviewPage-DrJ3QdgM.js` | 7,753 | 2,931 | deferred |
| `assets/SearchPage-CkdzgNP0.js` | 6,900 | 3,016 | deferred |
| `assets/SettingsPage-D_UulorP.js` | 9,820 | 3,585 | deferred |
| `assets/TodayPage-DdsmHLBC.js` | 6,733 | 2,831 | deferred |
| `assets/index-BFrTDZ2v.js` | 39,762 | 12,490 | entry |
| `assets/vendor-katex-CBezJsc7.js` | 261,511 | 77,567 | deferred |
| `assets/vendor-query-C9CjAvfR.js` | 40,682 | 12,063 | first-load |
| `assets/vendor-react-C4-hOpdN.js` | 262,438 | 83,317 | first-load |

## Other gates

| gate | result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test` (vitest) | 1 file, 5 tests pass (was: 10 collection failures at HEAD, see `vitest-before-after.txt`) |
| `npm run build` | pass |
| browser main suite (`--grep-invert "@stub"`) | **78 passed (1.7m)**, exit 0 |
| KaTeX on-demand browser probe (dev + production preview) | PASS in both modes |
