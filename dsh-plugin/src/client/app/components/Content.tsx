import { useEffect, useRef } from 'react'
import { assetUrl } from '../api/client'

type KatexApi = typeof import('katex')['default']

/**
 * KaTeX is ~280 kB of minified JavaScript plus its own stylesheet, and it is
 * only useful once a question actually contains a formula. Both are therefore
 * fetched on demand instead of being welded into the first screen, and the
 * renderer + its CSS resolve together so a formula is never painted unstyled.
 */
let katexModule: Promise<KatexApi> | null = null

function loadKatex(): Promise<KatexApi> {
  if (!katexModule) {
    katexModule = Promise.all([import('katex'), import('../../katex-css.ts').then((module) => module.installKatexCss())])
      .then(([module]) => module.default)
      .catch((error: unknown) => {
        katexModule = null // do not cache a failure: a retry may succeed
        throw error
      })
  }
  return katexModule
}

/**
 * Structured STEM rendering.
 *
 * KaTeX runs with `throwOnError: false` and `trust: false`, and the structured
 * blocks carry no raw HTML anywhere, so a question author cannot inject script
 * or arbitrary links into the learning UI. Images are only rendered from
 * server-issued asset ids that the presentation endpoint already authorised.
 */
export function MathText({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let cancelled = false
    loadKatex()
      .then((katex) => {
        if (cancelled || !ref.current) return
        katex.render(latex, ref.current, { throwOnError: false, trust: false, displayMode: false })
      })
      .catch((error: unknown) => {
        if (cancelled || !ref.current) return
        // Never leave the line blank: show the source when the renderer cannot
        // be fetched (offline, stale deployment after a rebuild).
        console.error('KaTeX failed to load; showing raw LaTeX', error)
        ref.current.textContent = latex
      })
    return () => {
      cancelled = true
    }
  }, [latex])
  return <span className="math" ref={ref} />
}

export function Blocks({ blocks, projectId }: { blocks: BlockLike[]; projectId?: string }) {
  if (!blocks?.length) return <p className="muted">（暂无题干内容）</p>
  return (
    <div className="blocks">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} projectId={projectId} />
      ))}
    </div>
  )
}

function BlockView({ block, projectId }: { block: BlockLike; projectId?: string }) {
  switch (block.kind) {
    case 'text':
      return <p className="block-text">{block.text}</p>
    case 'math':
      return (
        <p className="block-math">
          <MathText latex={block.latex ?? ''} />
        </p>
      )
    case 'image':
      return (
        <figure className="block-image">
          {block.asset_id && projectId ? (
            <img src={assetUrl(projectId, block.asset_id)} alt={block.alt ?? '题干配图'} />
          ) : (
            <div className="image-missing">图片未能解析（缺少可访问的题干裁图）</div>
          )}
        </figure>
      )
    case 'table':
      return (
        <figure className="block-table">
          <table>
            <tbody>
              {(block.rows ?? []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{typeof cell === 'string' ? cell : cell.text}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      )
    default:
      return <p className="muted">不支持的题干块类型：{String(block.kind)}</p>
  }
}

export interface BlockLike {
  kind: string
  text?: string
  latex?: string
  asset_id?: string
  alt?: string
  caption?: string
  rows?: Array<Array<{ text?: string } | string>>
}
