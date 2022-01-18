import { RendererOptions } from '@vue/runtime-core'

export const svgNS = 'http://www.w3.org/2000/svg'

// 可能是浏览器的Document
const doc = (typeof document !== 'undefined' ? document : null) as Document

// 静态节点的缓存
// 在每次初始化找之前的缓存
// 如果没有找到 在插入结构中之前进行缓存
const staticTemplateCache = new Map<string, DocumentFragment>()

// Vue支持多平台，只需要用户提供了平台的操作函数就可以在平台上使用vue 这里是浏览器平台对节点的操作
export const nodeOps: Omit<RendererOptions<Node, Element>, 'patchProp'> = {
  // 将节点插入到自己父节点中
  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null)
  },

  // 重写删除当前元素，获取当前元素的父元素 再通过父元素去删除自己
  remove: child => {
    const parent = child.parentNode
    if (parent) {
      parent.removeChild(child)
    }
  },

  // 重写创建元素的方法
  createElement: (tag, isSVG, is, props): Element => {
    // 创建元素节点 可能是SVG 或者是普通元素
    // is: 自定义标签名字
    const el = isSVG
      ? doc.createElementNS(svgNS, tag)
      : doc.createElement(tag, is ? { is } : undefined)

    // 设置特殊属性multiple
    if (tag === 'select' && props && props.multiple != null) {
      ;(el as HTMLSelectElement).setAttribute('multiple', props.multiple)
    }

    return el
  },

  // 创建一个文本
  createText: text => doc.createTextNode(text),

  // 创建一个注释
  createComment: text => doc.createComment(text),

  // 设置文本
  setText: (node, text) => {
    node.nodeValue = text
  },

  setElementText: (el, text) => {
    el.textContent = text
  },

  parentNode: node => node.parentNode as Element | null,

  // 返回下一个兄弟节点
  nextSibling: node => node.nextSibling,

  // 柯里化方法：通过任意选择器获取目标元素
  querySelector: selector => doc.querySelector(selector),

  setScopeId(el, id) {
    el.setAttribute(id, '')
  },

  cloneNode(el) {
    const cloned = el.cloneNode(true)
    // #3072
    // - in `patchDOMProp`, we store the actual value in the `el._value` property.
    // - normally, elements using `:value` bindings will not be hoisted, but if
    //   the bound value is a constant, e.g. `:value="true"` - they do get
    //   hoisted.
    // - in production, hoisted nodes are cloned when subsequent inserts, but
    //   cloneNode() does not copy the custom property we attached.
    // - This may need to account for other custom DOM properties we attach to
    //   elements in addition to `_value` in the future.
    if (`_value` in el) {
      ;(cloned as any)._value = (el as any)._value
    }
    return cloned
  },

  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, isSVG) {
    // <parent> before | first ... last | anchor </parent>
    const before = anchor ? anchor.previousSibling : parent.lastChild
    let template = staticTemplateCache.get(content)
    if (!template) {
      const t = doc.createElement('template')
      t.innerHTML = isSVG ? `<svg>${content}</svg>` : content
      template = t.content
      if (isSVG) {
        // remove outer svg wrapper
        const wrapper = template.firstChild!
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild)
        }
        template.removeChild(wrapper)
      }
      staticTemplateCache.set(content, template)
    }
    // 更新时，静态节点的的容器不会被移除 还存在
    parent.insertBefore(template.cloneNode(true), anchor)
    return [
      // first
      before ? before.nextSibling! : parent.firstChild!,
      // last
      anchor ? anchor.previousSibling! : parent.lastChild!
    ]
  }
}
