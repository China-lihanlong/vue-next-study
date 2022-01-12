import { patchClass } from './modules/class'
import { patchStyle } from './modules/style'
import { patchAttr } from './modules/attrs'
import { patchDOMProp } from './modules/props'
import { patchEvent } from './modules/events'
import { isOn, isString, isFunction, isModelListener } from '@vue/shared'
import { RendererOptions } from '@vue/runtime-core'

const nativeOnRE = /^on[a-z]/

type DOMRendererOptions = RendererOptions<Node, Element>

// 更新元素上的动态特性
export const patchProp: DOMRendererOptions['patchProp'] = (
  el,
  key,
  prevValue,
  nextValue,
  isSVG = false,
  prevChildren,
  parentComponent,
  parentSuspense,
  unmountChildren
) => {
  if (key === 'class') {
    // 更新ClassName
    patchClass(el, nextValue, isSVG)
  } else if (key === 'style') {
    // 更新Style
    patchStyle(el, prevValue, nextValue)
  } else if (isOn(key)) {
    // ignore v-model listeners
    // 更新事件 且不是由v-model派发的事件
    if (!isModelListener(key)) {
      patchEvent(el, key, prevValue, nextValue, parentComponent)
    }
  } else if (
    key[0] === '.'
      ? ((key = key.slice(1)), true)
      : key[0] === '^'
      ? ((key = key.slice(1)), false)
      : shouldSetAsProp(el, key, nextValue, isSVG)
  ) {
    // 校验一些特殊key 例如 SVG的attr 或者是一些 custom attr
    // 一些attr没有按照规范是如何进行编译 进行转换
    patchDOMProp(
      el,
      key,
      nextValue,
      prevChildren,
      parentComponent,
      parentSuspense,
      unmountChildren
    )
  } else {
    // input 元素的v-model值是false或者是true的特殊情况需要存储为DOM的值
    // 不是字符串的值会被字符串化
    // special case for <input v-model type="checkbox"> with
    // :true-value & :false-value
    // store value as dom properties since non-string values will be
    // stringified.
    if (key === 'true-value') {
      ;(el as any)._trueValue = nextValue
    } else if (key === 'false-value') {
      ;(el as any)._falseValue = nextValue
    }
    // 更新元素上的attribute
    patchAttr(el, key, nextValue, isSVG, parentComponent)
  }
}

// 确认一些key是否可以作为prop 因为有一些key始终不能为prop 只能设置为attr
function shouldSetAsProp(
  el: Element,
  key: string,
  value: unknown,
  isSVG: boolean
) {
  if (isSVG) {
    // SVG的大多数key必须设置为attr才会正常工作 innerHTML 和 textContent除外
    // most keys must be set as attribute on svg elements to work
    // ...except innerHTML & textContent
    if (key === 'innerHTML' || key === 'textContent') {
      return true
    }
    // or native onclick with function values
    // 或者是onclick之类设置function值
    if (key in el && nativeOnRE.test(key) && isFunction(value)) {
      return true
    }
    return false
  }

  // spellcheck and draggable are numerated attrs, however their
  // corresponding DOM properties are actually booleans - this leads to
  // setting it with a string "false" value leading it to be coerced to
  // `true`, so we need to always treat them as attributes.
  // Note that `contentEditable` doesn't have this problem: its DOM
  // property is also enumerated string values.
  // spellcheck 和 draggable 是计算属性 将他们设置为字符串 "false" 需要将其强制设置为`true`
  // 所以我们需要将其始终设置为attr
  // 注意，`contentEditable`没有这个问题(它是枚举属性)：它的DOM属性也是枚举字符串值。
  if (key === 'spellcheck' || key === 'draggable') {
    return false
  }

  // #1787, #2840 form property on form elements is readonly and must be set as
  // attribute.
  // form 元素的 form 应该是只读且必须设置为attr
  if (key === 'form') {
    return false
  }

  // #1526 <input list> must be set as attribute
  // input 的list必须设置为attr
  if (key === 'list' && el.tagName === 'INPUT') {
    return false
  }

  // #2766 <textarea type> must be set as attribute
  // textarea元素的type必须设置为attr
  if (key === 'type' && el.tagName === 'TEXTAREA') {
    return false
  }

  // native onclick with string value, must be set as attribute
  // 元素原生的一些key必须设置为attr 如onclick
  if (nativeOnRE.test(key) && isString(value)) {
    return false
  }

  return key in el
}
