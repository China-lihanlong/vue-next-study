import { isString, hyphenate, capitalize, isArray } from '@vue/shared'
import { camelize } from '@vue/runtime-core'

type Style = string | Record<string, string | string[]> | null

export function patchStyle(el: Element, prev: Style, next: Style) {
  // 数组格式 里面的多个样式对象 会合并为一个对象
  // 元素的style对象
  const style = (el as HTMLElement).style
  // style配置的是字符串？
  const isCssString = isString(next)
  if (next && !isCssString) {
    // 不是字符串格式
    // 更新新的内联样式
    for (const key in next) {
      setStyle(style, key, next[key])
    }
    // 移除旧的、不在新的里面的内联样式
    if (prev && !isString(prev)) {
      for (const key in prev) {
        if (next[key] == null) {
          setStyle(style, key, '')
        }
      }
    }
  } else {
    // 保存原本的display 最后在重新设置
    const currentDisplay = style.display
    if (isCssString) {
      // 字符串格式
      if (prev !== next) {
        style.cssText = next as string
      }
    } else if (prev) {
      // 新的绑定样式 不是对象 不是数组  不是字符串 移除
      el.removeAttribute('style')
    }
    // indicates that the `display` of the element is controlled by `v-show`,
    // so we always keep the current `display` value regardless of the `style`
    // value, thus handing over control to `v-show`.
    // 如果元素使用了v-show 无论display的值如何 都有v-show接管元素的显示和隐藏
    // _vod 是元素使用了v-show指令 执行v-show指令的生命周期期间设置的 设置在el身上
    if ('_vod' in el) {
      style.display = currentDisplay
    }
  }
}

const importantRE = /\s*!important$/

// 设置和修改样式对象
function setStyle(
  style: CSSStyleDeclaration,
  name: string,
  val: string | string[]
) {
  if (isArray(val)) {
    val.forEach(v => setStyle(style, name, v))
  } else {
    if (name.startsWith('--')) {
      // custom property definition
      // 自定义CSS特性
      style.setProperty(name, val)
    } else {
      const prefixed = autoPrefix(style, name)
      if (importantRE.test(val)) {
        // !important
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ''),
          'important'
        )
      } else {
        // 不带有important
        style[prefixed as any] = val
      }
    }
  }
}

const prefixes = ['Webkit', 'Moz', 'ms']
const prefixCache: Record<string, string> = {}

// 产生带有前缀的样式名称
function autoPrefix(style: CSSStyleDeclaration, rawName: string): string {
  const cached = prefixCache[rawName]
  if (cached) {
    return cached
  }
  // 驼峰化
  let name = camelize(rawName)
  if (name !== 'filter' && name in style) {
    return (prefixCache[rawName] = name)
  }
  // 首字母大写化
  // 带有前缀的名字一般都是：webkitBackgroundClip
  name = capitalize(name)
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name
    if (prefixed in style) {
      return (prefixCache[rawName] = prefixed)
    }
  }
  return rawName
}
