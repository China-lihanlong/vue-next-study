import { ComponentInternalInstance, currentInstance } from './component'
import {
  VNode,
  VNodeNormalizedChildren,
  normalizeVNode,
  VNodeChild,
  InternalObjectKey
} from './vnode'
import {
  isArray,
  isFunction,
  EMPTY_OBJ,
  ShapeFlags,
  extend,
  def,
  SlotFlags
} from '@vue/shared'
import { warn } from './warning'
import { isKeepAlive } from './components/KeepAlive'
import { ContextualRenderFn, withCtx } from './componentRenderContext'
import { isHmrUpdating } from './hmr'
import { DeprecationTypes, isCompatEnabled } from './compat/compatConfig'
import { toRaw } from '@vue/reactivity'

export type Slot = (...args: any[]) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type Slots = Readonly<InternalSlots>

export type RawSlots = {
  [name: string]: unknown
  // manual render fn hint to skip forced children updates
  // 手动渲染函数提示跳过强制子级更新
  $stable?: boolean
  /**
   * for tracking slot owner instance. This is attached during
   * normalizeChildren when the component vnode is created.
   * 在附加期间，用于跟踪插槽所有者，创建vnode的时候规范化children
   * @internal
   */
  _ctx?: ComponentInternalInstance | null
  /**
   * indicates compiler generated slots
   * we use a reserved property instead of a vnode patchFlag because the slots
   * object may be directly passed down to a child component in a manual
   * render function, and the optimization hint need to be on the slot object
   * itself to be preserved.
   * 指是经由编译器生成的插槽我们使用保留属性而不是vnode patchFlags 因为插槽属性可以在手动渲染函数中直接传递给子组件
   * 并且优化提示需要保留插槽对象本身
   * @internal
   */
  _?: SlotFlags
}

const isInternalKey = (key: string) => key[0] === '_' || key === '$stable'

// 循环调用normalizeVNode进行规范化vnode
const normalizeSlotValue = (value: unknown): VNode[] =>
  isArray(value)
    ? value.map(normalizeVNode)
    : [normalizeVNode(value as VNodeChild)]

const normalizeSlot = (
  key: string,
  rawSlot: Function,
  ctx: ComponentInternalInstance | null | undefined
): Slot => {
  const normalized = withCtx((...args: any[]) => {
    if (__DEV__ && currentInstance) {
      warn(
        `Slot "${key}" invoked outside of the render function: ` +
          `this will not track dependencies used in the slot. ` +
          `Invoke the slot function inside the render function instead.`
      )
    }
    return normalizeSlotValue(rawSlot(...args))
  }, ctx) as Slot
  // NOT a compiled slot
  ;(normalized as ContextualRenderFn)._c = false
  return normalized
}

// 标准化用户手写的插槽函数对象
const normalizeObjectSlots = (
  rawSlots: RawSlots,
  slots: InternalSlots,
  instance: ComponentInternalInstance
) => {
  const ctx = rawSlots._ctx
  for (const key in rawSlots) {
    // 不能是内部属性
    if (isInternalKey(key)) continue
    const value = rawSlots[key]
    if (isFunction(value)) {
      // 规范化插槽 并且包装 返回一个新函数
      slots[key] = normalizeSlot(key, value, ctx)
    } else if (value != null) {
      if (
        __DEV__ &&
        !(
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance)
        )
      ) {
        warn(
          `Non-function value encountered for slot "${key}". ` +
            `Prefer function slots for better performance.`
        )
      }
      // 用户在某个key传递的是vnode 交给normalizeSlotValue规范化之后 变成返回vnode的一个箭头函数
      const normalized = normalizeSlotValue(value)
      slots[key] = () => normalized
    }
  }
}

// 规范化用户在插槽内传递的vnode
const normalizeVNodeSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  if (
    __DEV__ &&
    !isKeepAlive(instance.vnode) &&
    !(__COMPAT__ && isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance))
  ) {
    warn(
      `Non-function value encountered for default slot. ` +
        `Prefer function slots for better performance.`
    )
  }
  // 交给normalizeSlotValue规范化之后 变成返回vnode的一个箭头函数挂在实例上的slots属性的key为default上
  const normalized = normalizeSlotValue(children)
  instance.slots.default = () => normalized
}

// 初始化插槽 并将插槽函数对象挂载实例上
export const initSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  if (instance.vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._
    if (type) {
      // 模板插槽
      // users can get the shallow readonly version of the slots object through `this.$slots`,
      // we should avoid the proxy object polluting the slots of the internal instance
      // 用户可以通过this.$slots获取实例上的slots对象浅读版本，但是我们需要防止slots对象被代理对象污染
      instance.slots = toRaw(children as InternalSlots)
      // make compiler marker non-enumerable
      // 重新定义内部属性，并使其不可枚举
      def(children as InternalSlots, '_', type)
    } else {
      // 函数插槽
      normalizeObjectSlots(
        children as RawSlots,
        (instance.slots = {}),
        instance
      )
    }
  } else {
    // 渲染函数直接返回vnode数组 不建议这样做 推荐函数插槽
    instance.slots = {}
    if (children) {
      // 对用户传递的插槽内容 进行标准化
      normalizeVNodeSlots(instance, children)
    }
  }
  def(instance.slots, InternalObjectKey, 1)
}

export const updateSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren,
  optimized: boolean
) => {
  const { vnode, slots } = instance
  // 删除旧插槽函数检查
  let needDeletionCheck = true
  // 删除旧插槽函数时的比较对象
  let deletionComparisonTarget = EMPTY_OBJ
  if (vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._
    if (type) {
      // compiled slots.
      // 编译插槽即模板
      if (__DEV__ && isHmrUpdating) {
        // Parent was HMR updated so slot content may have changed.
        // force update slots and mark instance for hmr as well
        // 父项已更新HMR，因此插槽内容可能已更改。强制更新插槽并为hmr标记实例
        // 作用是将新的插槽函数放入slots中
        extend(slots, children as Slots)
      } else if (optimized && type === SlotFlags.STABLE) {
        // compiled AND stable.
        // no need to update, and skip stale slots removal.
        // 编译和稳定。无需更新，并跳过陈旧插槽的删除
        needDeletionCheck = false
      } else {
        // compiled but dynamic (v-if/v-for on slots) - update slots, but skip
        // normalization.
        // 已编译但动态（v-if/v-for on slot）-更新slot，但跳过规范化
        // 作用是将新的插槽函数放入slots中
        extend(slots, children as Slots)
        // #2893
        // when rendering the optimized slots by manually written render function,
        // we need to delete the `slots._` flag if necessary to make subsequent updates reliable,
        // i.e. let the `renderSlot` create the bailed Fragment
        // 当使用手动渲染函数渲染优化插槽时，如有比较，我们需要删除删除`slots._`标记，以便以后可靠更新，即让renderSlot产生bailed Fragment
        if (!optimized && type === SlotFlags.STABLE) {
          delete slots._
        }
      }
    } else {
      // 手动渲染 借$stable判断是否跳过强制子级更新
      needDeletionCheck = !(children as RawSlots).$stable
      // 执行规范化 作用是将新的插槽函数放入slots中
      normalizeObjectSlots(children as RawSlots, slots, instance)
    }
    deletionComparisonTarget = children as RawSlots
  } else if (children) {
    // non slot object children (direct value) passed to a component
    // 手动渲染 但是传递的是vnode数组 执行规范化 作用是将vnode数组变成一个函数之后 放入slots中
    normalizeVNodeSlots(instance, children)
    // 比较目标一定是{default: 1}
    deletionComparisonTarget = { default: 1 }
  }

  // delete stale slots
  // 删除旧的插槽函数 needDeletionCheck必须是真值
  if (needDeletionCheck) {
    for (const key in slots) {
      // 不是保留属性和不在比较对象中
      if (!isInternalKey(key) && !(key in deletionComparisonTarget)) {
        delete slots[key]
      }
    }
  }
}
