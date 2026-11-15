/** KaTeX stylesheet: bundled, inlined once, and only when a formula is first rendered. */
import { KATEX_CSS } from './generated/katex-css.ts'

let installed = false

export function installKatexCss(): void {
  if (installed) return
  installed = true
  const style = document.createElement('style')
  style.dataset.acepassKatex = ''
  style.textContent = KATEX_CSS
  document.head.append(style)
}
