import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Blocks, MathText } from './Content'

const PROJECT = '11111111-1111-1111-1111-111111111111'

/**
 * Behaviour lock for the structured STEM renderer.
 *
 * The W3 optimisation moved KaTeX behind a dynamic `import()` and moved its
 * stylesheet out of the entry chunk. These assertions pin what the renderer must
 * still produce, including the fact that a maths node renders *empty* on the
 * server: the renderer is fetched from the client only once a formula exists,
 * so nothing in this module may touch KaTeX at import time.
 */
describe('Content.MathText', () => {
  it('renders an empty maths node when no effect has run (KaTeX is not touched at import time)', () => {
    expect(renderToStaticMarkup(<MathText latex="\frac{1}{2}" />)).toBe('<span class="math"></span>')
  })
})

describe('Content.Blocks', () => {
  it('renders text, maths, table and image blocks unchanged', () => {
    const html = renderToStaticMarkup(
      <Blocks
        projectId={PROJECT}
        blocks={[
          { kind: 'text', text: '题干文本' },
          { kind: 'math', latex: 'x^2' },
          { kind: 'table', rows: [['单元格', { text: '对象单元格' }]], caption: '表注' },
          { kind: 'image', asset_id: 'asset-1', alt: '配图' },
        ]}
      />,
    )
    expect(html).toContain('<p class="block-text">题干文本</p>')
    expect(html).toContain('<p class="block-math"><span class="math"></span></p>')
    expect(html).toContain('<td>单元格</td>')
    expect(html).toContain('<td>对象单元格</td>')
    expect(html).toContain('<figcaption>表注</figcaption>')
    expect(html).toContain(`<img src="/api/v1/projects/${PROJECT}/assets/asset-1" alt="配图"/>`)
  })

  it('explains an image it cannot authorise instead of rendering a broken <img>', () => {
    const html = renderToStaticMarkup(<Blocks blocks={[{ kind: 'image', asset_id: 'asset-1' }]} />)
    expect(html).toContain('图片未能解析（缺少可访问的题干裁图）')
    expect(html).not.toContain('<img')
  })

  it('names an unsupported block kind', () => {
    expect(renderToStaticMarkup(<Blocks blocks={[{ kind: 'audio' }]} />)).toContain(
      '不支持的题干块类型：audio',
    )
  })

  it('renders the empty-content notice for an empty or missing block list', () => {
    expect(renderToStaticMarkup(<Blocks blocks={[]} />)).toContain('（暂无题干内容）')
    expect(renderToStaticMarkup(<Blocks blocks={undefined as never} />)).toContain('（暂无题干内容）')
  })
})
