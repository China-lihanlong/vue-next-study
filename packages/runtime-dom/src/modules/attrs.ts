import {
  includeBooleanAttr,
  isSpecialBooleanAttr,
  makeMap,
  NOOP
} from '@vue/shared'
import {
  compatUtils,
  ComponentInternalInstance,
  DeprecationTypes
} from '@vue/runtime-core'

export const xlinkNS = 'http://www.w3.org/1999/xlink'

export function patchAttr(
  el: Element,
  key: string,
  value: any,
  isSVG: boolean,
  instance?: ComponentInternalInstance | null
) {
  if (isSVG && key.startsWith('xlink:')) {
    // 更新SVG上的xlink:开头的属性
    if (value == null) {
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length))
    } else {
      el.setAttributeNS(xlinkNS, key, value)
    }
  } else {
    // 兼容v2.x 枚举 attribute 不同值渲染结果不同 
    // 如果是contenteditable,draggable,spellcheck 其中一个且value是真值 就会设置
    // 如果不是 且value是假值 就会移除
    // 如果不是 且value是真值 会交给v3.x 处理
    // 但是不推荐 因为是非兼容 报出警告
    if (__COMPAT__ && compatCoerceAttr(el, key, value, instance)) {
      return
    }

    // note we are only checking boolean attributes that don't have a
    // corresponding dom prop of the same name here.
    const isBoolean = isSpecialBooleanAttr(key)
    // 一些特殊属性 当值是false是会被移除 需要单独处理
    if (value == null || (isBoolean && !includeBooleanAttr(value))) {
      el.removeAttribute(key)
    } else {
      // 更新attr
      el.setAttribute(key, isBoolean ? '' : value)
    }
  }
}

// 2.x compat
const isEnumeratedAttr = __COMPAT__
  ? /*#__PURE__*/ makeMap('contenteditable,draggable,spellcheck')
  : NOOP

export function compatCoerceAttr(
  el: Element,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance | null = null
): boolean {
  if (isEnumeratedAttr(key)) {
    const v2CocercedValue =
      value === null
        ? 'false'
        : typeof value !== 'boolean' && value !== undefined
        ? 'true'
        : null
    if (
      v2CocercedValue &&
      compatUtils.softAssertCompatEnabled(
        DeprecationTypes.ATTR_ENUMERATED_COERCION,
        instance,
        key,
        value,
        v2CocercedValue
      )
    ) {
      el.setAttribute(key, v2CocercedValue)
      return true
    }
  } else if (
    value === false &&
    !isSpecialBooleanAttr(key) &&
    compatUtils.softAssertCompatEnabled(
      DeprecationTypes.ATTR_FALSE_VALUE,
      instance,
      key
    )
  ) {
    el.removeAttribute(key)
    return true
  }
  return false
}
