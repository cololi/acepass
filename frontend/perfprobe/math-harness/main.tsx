import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Blocks } from '../../src/components/Content'

/**
 * Minimal harness for the W3 KaTeX probe.
 *
 * The real app only reaches `MathText` from an authenticated route carrying a
 * maths block, which the acceptance fixture does not contain. This page imports
 * the same `src/components/Content.tsx` and renders a formula only after a
 * click, so perfprobe/math-probe.mjs can prove in a real browser that:
 *
 *   1. nothing KaTeX-related is fetched while the page merely loads, and
 *   2. the renderer *and* its stylesheet arrive on demand and render correctly.
 */
function Probe() {
  const [showMath, setShowMath] = useState(false)
  return (
    <div>
      <p id="ready">probe-ready</p>
      <button id="show-math" onClick={() => setShowMath(true)}>
        render math
      </button>
      {showMath ? <Blocks blocks={[{ kind: 'math', latex: '\\frac{1}{2}' }]} /> : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
)
