import { ElementWithTransition } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// 编译器应该将其将静态class和绑定的class进行规范化为单个绑定 ['staticClass', dynamic]
// into a single binding ['staticClass', dynamic]
export function patchClass(el: Element, value: string | null, isSVG: boolean) {
  // directly setting className should be faster than setAttribute in theory
  // if this is an element during a transition, take the temporary transition
  // classes into account.
  // 理论上，直接设置className应该是比较快的 
  // 但是如果是 transition的className 需要去考虑transitionClassName
  const transitionClasses = (el as ElementWithTransition)._vtc
  // value 是新className 如果存在就会和transitionClasses 一起规范化
  if (transitionClasses) {
    value = (
      value ? [value, ...transitionClasses] : [...transitionClasses]
    ).join(' ')
  }
  // 更新className 可能是设置或删除
  if (value == null) {
    el.removeAttribute('class')
  } else if (isSVG) {
    el.setAttribute('class', value)
  } else {
    el.className = value
  }
}
