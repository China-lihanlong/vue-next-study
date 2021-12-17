import { ComponentInternalInstance } from '../component'
import { SuspenseBoundary } from './Suspense'
import {
  RendererInternals,
  MoveType,
  RendererElement,
  RendererNode,
  RendererOptions,
  traverseStaticChildren
} from '../renderer'
import { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { isString, ShapeFlags } from '@vue/shared'
import { warn } from '../warning'
import { isHmrUpdating } from '../hmr'

export type TeleportVNode = VNode<RendererNode, RendererElement, TeleportProps>

export interface TeleportProps {
  to: string | RendererElement | null | undefined
  disabled?: boolean
}

// 是teleport？
export const isTeleport = (type: any): boolean => type.__isTeleport

// 禁用了teleport的功能？
const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

// 目标是SVG？
const isTargetSVG = (target: RendererElement): boolean =>
  typeof SVGElement !== 'undefined' && target instanceof SVGElement

// 通过选择器(推荐使用id选择器(#some-id)和class选择器(.some-class) 强烈不推荐使用元素选择器)找到指定的容器
// 这个容器最好在开始渲染前或者是teleport渲染前存在，理想的是在vue树之外
const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector']
): T | null => {
  const targetSelector = props && props.to
  // 选择器不存在或者找不到有效元素直接报错 因为使用的是query Selector() 去获取目标 所以需要带#或者是.
  if (isString(targetSelector)) {
    // 如果当前渲染器没有或者不支持 querySelector teleport就无法正常的运行
    if (!select) {
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`
        )
      return null
    } else {
      // 获取目标元素返回 前提是如果获取不到会报错
      const target = select(targetSelector)
      if (!target) {
        __DEV__ &&
          warn(
            `Failed to locate Teleport target with selector "${targetSelector}". ` +
              `Note the target element must exist before the component is mounted - ` +
              `i.e. the target cannot be rendered by the component itself, and ` +
              `ideally should be outside of the entire Vue component tree.`
          )
      }
      return target as any
    }
  } else {
    if (__DEV__ && !targetSelector && !isTeleportDisabled(props)) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    return targetSelector as any
  }
}

export const TeleportImpl = {
  __isTeleport: true,
  process(
    n1: TeleportVNode | null,
    n2: TeleportVNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean,
    internals: RendererInternals
  ) {
    // VNode更新和挂载的函数 o是当前平台操作节点的函数
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment }
    } = internals

    // 是否禁用teleport的功能 如果禁用teleport就会在初始化的容器中渲染(包含teleport的组件卸载那个节点下就在那渲染)
    const disabled = isTeleportDisabled(n2.props)
    let { shapeFlag, children, dynamicChildren } = n2

    // #3302
    // HMR updated, force full diff
    if (__DEV__ && isHmrUpdating) {
      optimized = false
      dynamicChildren = null
    }

    if (n1 == null) {
      // 初始化挂载
      // insert anchors in the main view
      // 在主视图中插入定位 方便如果禁用了teleport的功能 可以进行初始化的容器中渲染
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText(''))
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText(''))
      insert(placeholder, container, anchor)
      insert(mainAnchor, container, anchor)
      // 拿到即将要渲染teleport的容器节点 在没有禁用功能的情况下
      const target = (n2.target = resolveTarget(n2.props, querySelector))
      const targetAnchor = (n2.targetAnchor = createText(''))
      // 传送的目标对象必须存在
      if (target) {
        // 打上一个定位方便后面渲染
        insert(targetAnchor, target)
        // #2652 we could be teleporting from a non-SVG tree into an SVG tree
        //  teleport 从 非SVG 树传送的 SVG树 应该工作
        isSVG = isSVG || isTargetSVG(target)
      } else if (__DEV__ && !disabled) {
        warn('Invalid Teleport target on mount:', target, `(${typeof target})`)
      }

      // 开始挂载teleport中的内容
      const mount = (container: RendererElement, anchor: RendererNode) => {
        // Teleport *always* has Array children. This is enforced in both the
        // compiler and vnode children normalization.
        //传送*始终*具有阵列子级。这在编译器和vnode子规范化中都是强制的。
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            children as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        }
      }

      // 根据disabled进行渲染选择 不是渲染的到指定的位置 否则在初始化teleport的容器中渲染
      if (disabled) {
        // 渲染到组件存在的节点中
        mount(container, mainAnchor)
      } else if (target) {
        // 渲染到执行目标中
        mount(target, targetAnchor)
      }
    } else {
      // update content
      // 更新内容
      n2.el = n1.el
      // 因为重新生成了VNode 全部的数据需要重新确认一次
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      const wasDisabled = isTeleportDisabled(n1.props)
      const currentContainer = wasDisabled ? container : target
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor
      isSVG = isSVG || isTargetSVG(target)

      if (dynamicChildren) {
        // fast path when the teleport happens to be a block root
        // 当传送恰好是块的快速路径
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds
        )
        // even in block tree mode we need to make sure all root-level nodes
        // in the teleport inherit previous DOM references so that they can
        // be moved in future patches.
        
        // 即使在块树模式下，我们也需要确保传送中的所有根级节点继承以前的DOM引
        // 用，以便在将来的更新中移动它们。
        traverseStaticChildren(n1, n2, true)
      } else if (!optimized) {
        // 更新子节点
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          false
        )
      }

      // 根据disabled和wasDisabled进行确认渲染方式 一共有三种情况
      if (disabled) {
        // 1. 从禁用切换到启用 渲染teleport主体内容到指定的teleport容器中
        if (!wasDisabled) {
          // enabled -> disabled
          // move into main container
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      } else {
        // target changed
        // 2. 修改了teleport容器 从旧的容器中移动到新的容器中
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = (n2.target = resolveTarget(
            n2.props,
            querySelector
          ))
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`
            )
          }
        } else if (wasDisabled) {
          // disabled -> enabled
          // move into teleport target
          // 3. 从启用切换到禁用 渲染teleport主体内容到初始化的teleport的容器中
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      }
    }
  },

  // 卸载teleport组件
  remove(
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean,
    // unmount 是 renderer.ts 中提供的 remove是删除节点方法
    { um: unmount, o: { remove: hostRemove } }: RendererInternals,
    doRemove: Boolean
  ) {
    const { shapeFlag, children, anchor, targetAnchor, target, props } = vnode

    if (target) {
      hostRemove(targetAnchor!)
    }

    // an unmounted teleport should always remove its children if not disabled
    // 始终删除teleport的子项 在没有禁用teleport功能的情况下
    if (doRemove || !isTeleportDisabled(props)) {
      hostRemove(anchor!)
      // 遍历删除子项 在子项是ArrayChildren的情况下
      if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        for (let i = 0; i < (children as VNode[]).length; i++) {
          const child = (children as VNode[])[i]
          unmount(
            child,
            parentComponent,
            parentSuspense,
            true,
            !!child.dynamicChildren
          )
        }
      }
    }
  },

  move: moveTeleport,
  hydrate: hydrateTeleport
}

export const enum TeleportMoveTypes {
  TARGET_CHANGE, // 容器目标改变
  TOGGLE, // enable / disable 启用/禁用
  REORDER // moved in the main view 已在主视图中移动
}

// 移动teleport内容主体
function moveTeleport(
  vnode: VNode,
  container: RendererElement,
  parentAnchor: RendererNode | null,
  { o: { insert }, m: move }: RendererInternals,
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER
) {
  // move target anchor if this is a target change.
  // 如果是目标容器发生改变 请将teleport渲染到新的目标容器
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  const { el, anchor, shapeFlag, children, props } = vnode
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  // 渲染teleport的目标容器发生改变 需要重新移动
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  // 如果只是单纯的是teleport内部元素发生变化，只需要去移动内部的子节点，(如果这不是重新排序，或者teleport的功能被禁用)
  // 但是如果是渲染teleport的目标容器发生改变 只会重新移动 不会移动内部字节点
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  // 渲染teleport的目标容器发生改变 不仅仅需要移动主体，还需要移动瞄点
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

// 服务器渲染teleport
function hydrateTeleport(
  node: Node,
  vnode: TeleportVNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  slotScopeIds: string[] | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector }
  }: RendererInternals<Node, Element>,
  // hydrateChildren 这个函数是由外部传递进来的 一定是hydration.ts中的hydrateChildren方法
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  // 渲染目标元素
  const target = (vnode.target = resolveTarget<Element>(
    vnode.props,
    querySelector
  ))
  if (target) {
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    //如果多个teleports呈现给同一个目标元素，我们需要从最后一个传送完成的位置而不是第一个节点开始拾取
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    // 渲染teleport内部的子节点
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      // 根据是否禁用teleport功能来确定渲染在那
      if (isTeleportDisabled(vnode.props)) {
        vnode.anchor = hydrateChildren(
          nextSibling(node),
          vnode,
          parentNode(node)!,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
        vnode.targetAnchor = targetNode
      } else {
        vnode.anchor = nextSibling(node)
        vnode.targetAnchor = hydrateChildren(
          targetNode,
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
      }
      // 重新对最后一个telepor进行赋值
      ;(target as TeleportTargetElement)._lpa =
        vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
    }
  }
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = TeleportImpl as any as {
  __isTeleport: true
  new (): { $props: VNodeProps & TeleportProps }
}
