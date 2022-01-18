import {
  Text,
  Fragment,
  Comment,
  cloneIfMounted,
  normalizeVNode,
  VNode,
  VNodeArrayChildren,
  createVNode,
  isSameVNodeType,
  Static,
  VNodeNormalizedRef,
  VNodeHook,
  VNodeNormalizedRefAtom,
  VNodeProps
} from './vnode'
import {
  ComponentInternalInstance,
  ComponentOptions,
  createComponentInstance,
  Data,
  getExposeProxy,
  setupComponent
} from './component'
import {
  filterSingleRoot,
  renderComponentRoot,
  shouldUpdateComponent,
  updateHOCHostEl
} from './componentRenderUtils'
import {
  isString,
  EMPTY_OBJ,
  EMPTY_ARR,
  isReservedProp,
  isFunction,
  PatchFlags,
  ShapeFlags,
  NOOP,
  hasOwn,
  invokeArrayFns,
  isArray,
  getGlobalThis
} from '@vue/shared'
import {
  queueJob,
  queuePostFlushCb,
  flushPostFlushCbs,
  invalidateJob,
  flushPreFlushCbs,
  SchedulerJob
} from './scheduler'
import {
  isRef,
  pauseTracking,
  resetTracking,
  ReactiveEffect
} from '@vue/reactivity'
import { updateProps } from './componentProps'
import { updateSlots } from './componentSlots'
import { pushWarningContext, popWarningContext, warn } from './warning'
import { createAppAPI, CreateAppFunction } from './apiCreateApp'
import {
  SuspenseBoundary,
  queueEffectWithSuspense,
  SuspenseImpl
} from './components/Suspense'
import { TeleportImpl, TeleportVNode } from './components/Teleport'
import { isKeepAlive, KeepAliveContext } from './components/KeepAlive'
import { registerHMR, unregisterHMR, isHmrUpdating } from './hmr'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { createHydrationFunctions, RootHydrateFunction } from './hydration'
import { invokeDirectiveHook } from './directives'
import { startMeasure, endMeasure } from './profiling'
import {
  devtoolsComponentAdded,
  devtoolsComponentRemoved,
  devtoolsComponentUpdated,
  setDevtoolsHook
} from './devtools'
import { initFeatureFlags } from './featureFlags'
import { isAsyncWrapper } from './apiAsyncComponent'
import { isCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import { registerLegacyRef } from './compat/ref'

export interface Renderer<HostElement = RendererElement> {
  render: RootRenderFunction<HostElement>
  createApp: CreateAppFunction<HostElement>
}

export interface HydrationRenderer extends Renderer<Element | ShadowRoot> {
  hydrate: RootHydrateFunction
}

export type RootRenderFunction<HostElement = RendererElement> = (
  vnode: VNode | null,
  container: HostElement,
  isSVG?: boolean
) => void

export interface RendererOptions<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  patchProp(
    el: HostElement,
    key: string,
    prevValue: any,
    nextValue: any,
    isSVG?: boolean,
    prevChildren?: VNode<HostNode, HostElement>[],
    parentComponent?: ComponentInternalInstance | null,
    parentSuspense?: SuspenseBoundary | null,
    unmountChildren?: UnmountChildrenFn
  ): void
  insert(el: HostNode, parent: HostElement, anchor?: HostNode | null): void
  remove(el: HostNode): void
  createElement(
    type: string,
    isSVG?: boolean,
    isCustomizedBuiltIn?: string,
    vnodeProps?: (VNodeProps & { [key: string]: any }) | null
  ): HostElement
  createText(text: string): HostNode
  createComment(text: string): HostNode
  setText(node: HostNode, text: string): void
  setElementText(node: HostElement, text: string): void
  parentNode(node: HostNode): HostElement | null
  nextSibling(node: HostNode): HostNode | null
  querySelector?(selector: string): HostElement | null
  setScopeId?(el: HostElement, id: string): void
  cloneNode?(node: HostNode): HostNode
  insertStaticContent?(
    content: string,
    parent: HostElement,
    anchor: HostNode | null,
    isSVG: boolean
  ): [HostNode, HostNode]
}

// Renderer Node can technically be any object in the context of core renderer
// logic - they are never directly operated on and always passed to the node op
// functions provided via options, so the internal constraint is really just
// a generic object.
export interface RendererNode {
  [key: string]: any
}

export interface RendererElement extends RendererNode {}

// An object exposing the internals of a renderer, passed to tree-shakeable
// features so that they can be decoupled from this file. Keys are shortened
// to optimize bundle size.
export interface RendererInternals<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  p: PatchFn
  um: UnmountFn
  r: RemoveFn
  m: MoveFn
  mt: MountComponentFn
  mc: MountChildrenFn
  pc: PatchChildrenFn
  pbc: PatchBlockChildrenFn
  n: NextFn
  o: RendererOptions<HostNode, HostElement>
}

// These functions are created inside a closure and therefore their types cannot
// be directly exported. In order to avoid maintaining function signatures in
// two places, we declare them once here and use them inside the closure.
type PatchFn = (
  n1: VNode | null, // null means this is a mount
  n2: VNode,
  container: RendererElement,
  anchor?: RendererNode | null,
  parentComponent?: ComponentInternalInstance | null,
  parentSuspense?: SuspenseBoundary | null,
  isSVG?: boolean,
  slotScopeIds?: string[] | null,
  optimized?: boolean
) => void

type MountChildrenFn = (
  children: VNodeArrayChildren,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  start?: number
) => void

type PatchChildrenFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean
) => void

type PatchBlockChildrenFn = (
  oldChildren: VNode[],
  newChildren: VNode[],
  fallbackContainer: RendererElement,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null
) => void

type MoveFn = (
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  type: MoveType,
  parentSuspense?: SuspenseBoundary | null
) => void

type NextFn = (vnode: VNode) => RendererNode | null

type UnmountFn = (
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean
) => void

type RemoveFn = (vnode: VNode) => void

type UnmountChildrenFn = (
  children: VNode[],
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
  start?: number
) => void

export type MountComponentFn = (
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

type ProcessTextOrCommentFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null
) => void

export type SetupRenderEffectFn = (
  instance: ComponentInternalInstance,
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

export const enum MoveType {
  ENTER, // 进入
  LEAVE, // 退出
  REORDER // 重新排序
}

export const queuePostRenderEffect = __FEATURE_SUSPENSE__
  ? queueEffectWithSuspense
  : queuePostFlushCb

/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 */
export function createRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>) {
  return baseCreateRenderer<HostNode, HostElement>(options)
}

// Separate API for creating hydration-enabled renderer.
// Hydration logic is only used when calling this function, making it
// tree-shakable.
export function createHydrationRenderer(
  options: RendererOptions<Node, Element>
) {
  return baseCreateRenderer(options, createHydrationFunctions)
}

/**
 * createRenderer何createHydrationRenderer是两个创建renderer(渲染器)
 * 一个是Client Side Render 一个是Server Side Render
 * 
 * createRenderer 函数接受两个通用参数：HostNode 和 HostElement，
 * 分别对应宿主环境中的 Node 和 Element 类型。 
 * 例如，对于 runtime-dom，HostNode 将是 DOM `Node` 接口，HostElement 将是 DOM `Element` 接口。
 * 
 * 用于创建启用服务端的渲染器的单独 API。 Hydration 逻辑仅在调用此函数时使用，使其可摇树
 * 
 * 两个方法最终调用的是baseCreateRenderer 
 * baseCreateRenderer内部创建了很多方法 比较常见的有：patch render等 在vDom的挂载和更新经常使用的就是这些方法
 * baseCreateRenderer最后返回的是一个渲染器renderer 渲染器的结构如下：
 * {render,
 *  hydrate,
 *  createApp: createAppAPI(render, hydrate)
 * }
 */

// overload 1: no hydration
function baseCreateRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement>

// overload 2: with hydration
function baseCreateRenderer(
  options: RendererOptions<Node, Element>,
  createHydrationFns: typeof createHydrationFunctions
): HydrationRenderer

// implementation
function baseCreateRenderer(
  options: RendererOptions,
  createHydrationFns?: typeof createHydrationFunctions
): any {
  // compile-time feature flags check
  if (__ESM_BUNDLER__ && !__TEST__) {
    initFeatureFlags()
  }

  const target = getGlobalThis()
  target.__VUE__ = true
  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__, target)
  }

  // 宿主环境中 DOM Node 和 DOM Element 接口
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp, // patchProp.ts 中的patchProp方法 用于更新节点上的 attribute 和 prop
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    cloneNode: hostCloneNode,
    insertStaticContent: hostInsertStaticContent
  } = options

  // Note: functions inside this closure should use `const xxx = () => {}`
  // style in order to prevent being inlined by minifiers.
  // 更新VNode
  const patch: PatchFn = (
    n1,
    n2,
    container,
    anchor = null,
    parentComponent = null,
    parentSuspense = null,
    isSVG = false,
    slotScopeIds = null,
    optimized = __DEV__ && isHmrUpdating ? false : !!n2.dynamicChildren
  ) => {
    // 优化：节点完全相同 直接退出
    if (n1 === n2) {
      return
    }

    // patching & not same type, unmount old tree
    // 更新节点 在节点类型不同的情况下 删除旧的的节点
    if (n1 && !isSameVNodeType(n1, n2)) {
      anchor = getNextHostNode(n1)
      //卸载节点
      unmount(n1, parentComponent, parentSuspense, true)
      n1 = null
    }

    // 结束DOM diff 在节点类型是PatchFlags.BAIL情况下
    if (n2.patchFlag === PatchFlags.BAIL) {
      optimized = false
      n2.dynamicChildren = null
    }

    // 根据type和shapeFlag确认更新的类型
    // 第一次进来 type 是根组建的配置对象 所以会执行 if(shapeFlag & ShapeFlags.COMPONENT) 中的逻辑 也就是执行 processComponent 函数
    // 在对比节点列表的情况下(vFor渲染出来的) 大部分情况下都是进入patchElement
    // 如果是teleport 会进入来一个teleport的配置对象
    // 如果传递进来的是Suspense 就是Suspense的操作方法
    const { type, ref, shapeFlag } = n2
    switch (type) {
      case Text: /* 文本 */
        processText(n1, n2, container, anchor)
        break
      case Comment: /* 注释 */
        processCommentNode(n1, n2, container, anchor)
        break
      case Static: /* 静态节点：连续20个节点，且没任何动态的内容 */
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, isSVG)
        } else if (__DEV__) {
          patchStaticNode(n1, n2, container, isSVG)
        }
        break
      case Fragment: /* Fragment 表示一系列没有根节点 并排排列的节点 */
      // DOM diff 开始入口
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) {
          /* 元素 */
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          /* 组件 */
          // 初始化走这
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.TELEPORT) {
          /* Teleport */
          ;(type as typeof TeleportImpl).process(
            n1 as TeleportVNode,
            n2 as TeleportVNode,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized,
            internals
          )
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
          /* Suspense */
          ;(type as typeof SuspenseImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized,
            internals
          )
        } else if (__DEV__) {
          warn('Invalid VNode type:', type, `(${typeof type})`)
        }
    }

    // set ref
    // 初始化或者更新vnode上的模板引用
    if (ref != null && parentComponent) {
      setRef(ref, n1 && n1.ref, parentSuspense, n2 || n1, !n2)
    }
  }

  // 解析文本节点
  const processText: ProcessTextOrCommentFn = (n1, n2, container, anchor) => {
    if (n1 == null) {
      // 没有旧文本存在 挂载文本
      // parent.insertBefore()
      hostInsert(
        // 创建文本
        (n2.el = hostCreateText(n2.children as string)),
        container,
        anchor
      )
    } else {
      // 直接更新文本 在新和旧的节点都存在的情况下
      const el = (n2.el = n1.el!)
      if (n2.children !== n1.children) {
        // hostSetText node.textContent = n2.children
        hostSetText(el, n2.children as string)
      }
    }
  }

  // 初始化注释 但是由于JS不支持动态注释，直接把旧的赋值就好了
  const processCommentNode: ProcessTextOrCommentFn = (
    n1,
    n2,
    container,
    anchor
  ) => {
    if (n1 == null) {
      // 创建一个注释 插入到模板中
      hostInsert(
        (n2.el = hostCreateComment((n2.children as string) || '')),
        container,
        anchor
      )
    } else {
      // there's no support for dynamic comments
      n2.el = n1.el
    }
  }

  // 挂载静态节点
  const mountStaticNode = (
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    isSVG: boolean
  ) => {
    // static nodes are only present when used with compiler-dom/runtime-dom
    // which guarantees presence of hostInsertStaticContent.
    // 静态节点仅在与编译器dom/运行时dom一起使用时才存在，后者保证hostInsertStaticContent的存在。
    ;[n2.el, n2.anchor] = hostInsertStaticContent!(
      n2.children as string,
      container,
      anchor,
      isSVG
    )
  }

  /**
   * Dev / HMR only
   */
  // 对比静态节点
  const patchStaticNode = (
    n1: VNode,
    n2: VNode,
    container: RendererElement,
    isSVG: boolean
  ) => {
    // static nodes are only patched during dev for HMR
    if (n2.children !== n1.children) {
      const anchor = hostNextSibling(n1.anchor!)
      // remove existing
      removeStaticNode(n1)
      // insert new
      ;[n2.el, n2.anchor] = hostInsertStaticContent!(
        n2.children as string,
        container,
        anchor,
        isSVG
      )
    } else {
      n2.el = n1.el
      n2.anchor = n1.anchor
    }
  }

  // 移动静态节点
  const moveStaticNode = (
    { el, anchor }: VNode,
    container: RendererElement,
    nextSibling: RendererNode | null
  ) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el)
      hostInsert(el, container, nextSibling)
      el = next
    }
    hostInsert(anchor!, container, nextSibling)
  }

  // 移除静态节点
  const removeStaticNode = ({ el, anchor }: VNode) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el)
      hostRemove(el)
      el = next
    }
    hostRemove(anchor!)
  }

  // 解析元素节点
  const processElement = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    isSVG = isSVG || (n2.type as string) === 'svg'
    if (n1 == null) {
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    } else {
      patchElement(
        n1,
        n2,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    }
  }

  // 挂载元素节点
  const mountElement = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    let el: RendererElement
    let vnodeHook: VNodeHook | undefined | null
    const { type, props, shapeFlag, transition, patchFlag, dirs } = vnode
    // 如果el不存在 会创建 存在且是静态节点会重用
    if (
      !__DEV__ &&
      vnode.el &&
      hostCloneNode !== undefined &&
      patchFlag === PatchFlags.HOISTED
    ) {
      // If a vnode has non-null el, it means it's being reused.
      // Only static vnodes can be reused, so its mounted DOM nodes should be
      // exactly the same, and we can simply do a clone here.
      // only do this in production since cloned trees cannot be HMR updated.
      // 如果vnode具有非空el，则表示它正在被重用。只有静态Vnode可以重用，
      // 因此它挂载的DOM节点应该完全相同，我们可以在这里简单地进行克隆。
      // 仅在生产环境中执行此操作，因为克隆树无法更新HMR(热更新)
      el = vnode.el = hostCloneNode(vnode.el)
    } else {
      // 创建一个元素赋值给 el
      el = vnode.el = hostCreateElement(
        vnode.type as string,
        isSVG,
        props && props.is,
        props
      )

      // mount children first, since some props may rely on child content
      // being already rendered, e.g. `<select value>`
      // 先去挂载子节点 因为某些道具可能依赖于已渲染的子对象内容
      // 例如事件监听
      if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
        // 直接设置子节点 在子节点是文本子节点情况下 当前节点的解析结束
        hostSetElementText(el, vnode.children as string)
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // 当前节点有多个子节点 遍历每一个子节点 再次调用patch解析
        // array children
        mountChildren(
          vnode.children as VNodeArrayChildren,
          el,
          null,
          parentComponent,
          parentSuspense,
          isSVG && type !== 'foreignObject',
          slotScopeIds,
          optimized
        )
      }

      // 自定义指令created生命周期
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'created')
      }
      // props 给节点初始化特性
      if (props) {
        for (const key in props) {
          if (key !== 'value' && !isReservedProp(key)) {
            hostPatchProp(
              el,
              key,
              null,
              props[key],
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense,
              unmountChildren
            )
          }
        }
        /**
         * Special case for setting value on DOM elements:
         * - it can be order-sensitive (e.g. should be set *after* min/max, #2325, #4024)
         * - it needs to be forced (#1471)
         * #2353 proposes adding another renderer option to configure this, but
         * the properties affects are so finite it is worth special casing it
         * here to reduce the complexity. (Special casing it also should not
         * affect non-DOM renderers)
         */
        if ('value' in props) {
          hostPatchProp(el, 'value', null, props.value)
        }
        // 执行即将创建vnode的生命周期函数
        if ((vnodeHook = props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parentComponent, vnode)
        }
      }
      // scopeId
      setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent)
    }
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      Object.defineProperty(el, '__vnode', {
        value: vnode,
        enumerable: false
      })
      Object.defineProperty(el, '__vueParentComponent', {
        value: parentComponent,
        enumerable: false
      })
    }
    // 自定义指令 beforeMount生命周期函数
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
    }
    // #1583 For inside suspense + suspense not resolved case, enter hook should call when suspense resolved
    // #1689 For inside suspense + suspense resolved case, just call it
    const needCallTransitionHooks =
      (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) &&
      transition &&
      !transition.persisted
    if (needCallTransitionHooks) {
      transition!.beforeEnter(el)
    }
    hostInsert(el, container, anchor)
    // 执行vnode的挂载完成的生命周期函数
    if (
      (vnodeHook = props && props.onVnodeMounted) ||
      needCallTransitionHooks ||
      dirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        needCallTransitionHooks && transition!.enter(el)
        // 自定义指令的 mounted函数
        dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
      }, parentSuspense)
    }
  }

  const setScopeId = (
    el: RendererElement,
    vnode: VNode,
    scopeId: string | null,
    slotScopeIds: string[] | null,
    parentComponent: ComponentInternalInstance | null
  ) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId)
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i])
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree
      if (
        __DEV__ &&
        subTree.patchFlag > 0 &&
        subTree.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
      ) {
        subTree =
          filterSingleRoot(subTree.children as VNodeArrayChildren) || subTree
      }
      if (vnode === subTree) {
        const parentVNode = parentComponent.vnode
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent
        )
      }
    }
  }

  // 挂载子节点
  const mountChildren: MountChildrenFn = (
    children,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds,
    optimized,
    start = 0
  ) => {
    // 遍历所有的子节点，一个一个的挂载
    for (let i = start; i < children.length; i++) {
      // 子节点的优化和标准化
      const child = (children[i] = optimized
        ? cloneIfMounted(children[i] as VNode)
        : normalizeVNode(children[i]))
      // 开始挂载
      patch(
        null,
        child,
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

  // 对比元素 更新元素的Element特性及其动态子节点
  const patchElement = (
    n1: VNode,
    n2: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    const el = (n2.el = n1.el!)
    let { patchFlag, dynamicChildren, dirs } = n2
    // #1426 take the old vnode's patch flag into account since user may clone a
    // compiler-generated vnode, which de-opts to FULL_PROPS
    // 考虑前一个节点和新节点，因为其中一个节点可能已被 cloneVNode 或类似的替换。选择全部特性更新
    patchFlag |= n1.patchFlag & PatchFlags.FULL_PROPS
    const oldProps = n1.props || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    let vnodeHook: VNodeHook | undefined | null

    // 执行vnode即将更新的生命周期函数
    if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
    }
    // 自定义指令的beforeUpdate生命周期函数
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate')
    }

    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // 子元素是SVG吗
    const areChildrenSVG = isSVG && n2.type !== 'foreignObject'
    // 更新动态子节点 如果回退到非优化模式则是全量更新 遍历每一个子节点
    if (dynamicChildren) {
      // 一个元素被称为一个块
      patchBlockChildren(
        n1.dynamicChildren!,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        areChildrenSVG,
        slotScopeIds
      )
      if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
        traverseStaticChildren(n1, n2)
      }
    } else if (!optimized) {
      // 全量diff
      // full diff
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        areChildrenSVG,
        slotScopeIds,
        false
      )
    }

    // 更新元素本身的动态特性
    if (patchFlag > 0) {
      // patchFlag 存在意味着是渲染代码是由编译器生成的
      // the presence of a patchFlag means this element's render code was
      // generated by the compiler and can take the fast path.
      // in this path old node and new node are guaranteed to have the same shape
      // (i.e. at the exact same position in the source template)
      if (patchFlag & PatchFlags.FULL_PROPS) {
        // element props contain dynamic keys, full diff needed
        // 元素上存在动态的attrs 需要去全量更新
        patchProps(
          el,
          n2,
          oldProps,
          newProps,
          parentComponent,
          parentSuspense,
          isSVG
        )
      } else {
        // 元素上存在动态的class 匹配更新(新旧class转换成字符串对比)
        // this flag is matched when the element has dynamic class bindings.
        if (patchFlag & PatchFlags.CLASS) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, 'class', null, newProps.class, isSVG)
          }
        }

        // 对比行内style
        // this flag is matched when the element has dynamic style bindings
        if (patchFlag & PatchFlags.STYLE) {
          hostPatchProp(el, 'style', oldProps.style, newProps.style, isSVG)
        }

        // props 除了 class和style的 特性和参数
        // This flag is matched when the element has dynamic prop/attr bindings
        // other than class and style. The keys of dynamic prop/attrs are saved for
        // faster iteration.
        // Note dynamic keys like :[foo]="bar" will cause this optimization to
        // bail out and go through a full diff because we need to unset the old key
        if (patchFlag & PatchFlags.PROPS) {
          // if the flag is present then dynamicProps must be non-null
          const propsToUpdate = n2.dynamicProps!
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i]
            const prev = oldProps[key]
            const next = newProps[key]
            // #1471 force patch value
            if (next !== prev || key === 'value') {
              // input元素 v-model属性 强制更新
              hostPatchProp(
                el,
                key,
                prev,
                next,
                isSVG,
                n1.children as VNode[],
                parentComponent,
                parentSuspense,
                unmountChildren
              )
            }
          }
        }
      }

      // 更新文本text
      // This flag is matched when the element has only dynamic text children.
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children as string)
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      // unoptimized, full diff
      // 没有优化 全量diff
      patchProps(
        el,
        n2,
        oldProps,
        newProps,
        parentComponent,
        parentSuspense,
        isSVG
      )
    }

    // 执行vnode更新完毕的生命周期函数
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
        // 自定义指令 updated生命周期函数
        dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated')
      }, parentSuspense)
    }
  }

  // The fast path for blocks.
  // 调用patch去对比每一对比Fragment中的子项，找到父元素的(也可以指定)，传递给patch
  // 找到对应的新旧VNode传递给patch进行对比
  const patchBlockChildren: PatchBlockChildrenFn = (
    oldChildren,
    newChildren,
    fallbackContainer,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds
  ) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i]
      const newVNode = newChildren[i]
      // Determine the container (parent element) for the patch.
      // 确认更新的元素的父节点
      const container =
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        // 可能存在异步组件的情况 确保元素的实际DOM结构存在
        oldVNode.el &&
        // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        // 情况一：文档碎片 
        (oldVNode.type === Fragment ||
          // - In the case of different nodes, there is going to be a replacement
          // which also requires the correct parent container
          // 情况二：两个不是同一种元素(key值不一样)或者是组件已经热更新就强制更新 
          !isSameVNodeType(oldVNode, newVNode) ||
          // - In the case of a component, it could contain anything.
          // 如果是组件或者UI组件树 拿到el的parentNode，但是在没有实际使用父容器的情况可以传递一个block元素，避免parentNode的调用
          oldVNode.shapeFlag & (ShapeFlags.COMPONENT | ShapeFlags.TELEPORT))
          ? hostParentNode(oldVNode.el)!
          : // In other cases, the parent container is not actually used so we
            // just pass the block element here to avoid a DOM parentNode call.
            // 在其他情况下，实际上没有使用父容器，因此我们只在此处传递block元素，以避免DOM parentNode调用。
            fallbackContainer
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        true
      )
    }
  }

  // 更新 prop
  const patchProps = (
    el: RendererElement,
    vnode: VNode,
    oldProps: Data,
    newProps: Data,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean
  ) => {
    if (oldProps !== newProps) {
      for (const key in newProps) {
        // empty string is not valid prop
        if (isReservedProp(key)) continue
        const next = newProps[key]
        const prev = oldProps[key]
        // defer patching value
        if (next !== prev && key !== 'value') {
          hostPatchProp(
            el,
            key,
            prev,
            next,
            isSVG,
            vnode.children as VNode[],
            parentComponent,
            parentSuspense,
            unmountChildren
          )
        }
      }
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense,
              unmountChildren
            )
          }
        }
      }
      if ('value' in newProps) {
        hostPatchProp(el, 'value', oldProps.value, newProps.value)
      }
    }
  }

  // 组件更新进入的第一个函数
  const processFragment = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // fragment 开始的位置
    const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''))!
    // fragment 结束的位置
    const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''))!

    // patchFlag：那些是动态的 dynamicChildren：动态的子节点 slotScopeIds：插槽作用域的id
    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2

    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // check if this is a slot fragment with :slotted scope ids
    // 检查这是否是具有：slotted scope id的插槽片段
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds
        ? slotScopeIds.concat(fragmentSlotScopeIds)
        : fragmentSlotScopeIds
    }

    if (n1 == null) {
      // 第一次进来 anchor null 所以先插入开始标记 再插入结束标记 insertBefore的referenceNode传入null的话，默认插入到子节点的末尾
      hostInsert(fragmentStartAnchor, container, anchor)
      hostInsert(fragmentEndAnchor, container, anchor)
      // a fragment can only have array children
      // since they are either generated by the compiler, or implicitly created
      // from arrays.
      //一个fragment 只能有array children
      //因为它们要么是由编译器生成的，要么是隐式创建的
      //从数组。
      // 开始挂载子节点
      mountChildren(
        n2.children as VNodeArrayChildren,
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    } else {
      if (
        patchFlag > 0 &&
        patchFlag & PatchFlags.STABLE_FRAGMENT &&
        dynamicChildren &&
        // #2715 the previous fragment could've been a BAILed one as a result
        // of renderSlot() with no valid children
        // 由于 renderSlot() 没有有效的孩子，前一个片段可能是一个不需要DOMdiff的片段
        n1.dynamicChildren
      ) {
        // a stable fragment (template root or <template v-for>) doesn't need to
        // patch children order, but it may contain dynamicChildren.
        // 稳定片段（模板根或 <template v-for>）不需要修补子顺序，但它可能包含 dynamicChildren。
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds
        )
        if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
          traverseStaticChildren(n1, n2)
        } else if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // 在键控的'template'片段静态子对象中，如果移动片段，子对象始终将移动。
          // 因此，为了确保正确的移动位置，el应该从以前的节点继承
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          // 或者如果它是一个组件根，它也可能随着组件的移动而四处移动。
          n2.key != null ||
          (parentComponent && n2 === parentComponent.subTree)
        ) {
          traverseStaticChildren(n1, n2, true /* shallow */)
        }
      } else {
        // keyed / unkeyed, or manual fragments.
        // for keyed & unkeyed, since they are compiler generated from v-for,
        // each child is guaranteed to be a block so the fragment will never
        // have dynamicChildren.
        // 键控和非键控或者是fragments
        // 键控和非键控 其实也是由vFor编译之后所产生的片段 他们一定没有dynamicChildren
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      }
    }
  }

  const processComponent = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 设置插槽作用域
    n2.slotScopeIds = slotScopeIds
    // n1 是旧的组件VNode 有是更新组件 没有就是初始化挂载组件
    if (n1 == null) {
      // 如果这个组件是有经过缓存的 没有被卸载 这种情况也没有旧的VNode
      // 这是直接去找旧的缓存的VNode
      if (n2.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
        ;(parentComponent!.ctx as KeepAliveContext).activate(
          n2,
          container,
          anchor,
          isSVG,
          optimized
        )
      } else {
        // 初始化走挂载流程
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      }
    } else {
      // 更新DOM
      updateComponent(n1, n2, optimized)
    }
  }

  // 
  const mountComponent: MountComponentFn = (
    initialVNode,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // 2.x compat may pre-create the component instance before actually
    // mounting
    // 创建组件实例
    const compatMountInstance =
      __COMPAT__ && initialVNode.isCompatRoot && initialVNode.component
    const instance: ComponentInternalInstance =
      compatMountInstance ||
      (initialVNode.component = createComponentInstance(
        initialVNode,
        parentComponent,
        parentSuspense
      ))
      // instance 是当前的组件的根实例 里面有 不再是一些$xxx的方法 而是一些属性 其中：bc = beforeCreate bm = beforeMount 
      // bu = beforeUpdate bum = beforeUnmount
      // 最后重要的是其中的上下文 ctx(里面就是$xxx的方法)

    if (__DEV__ && instance.type.__hmrId) {
      registerHMR(instance)
    }

    if (__DEV__) {
      pushWarningContext(initialVNode)
      startMeasure(instance, `mount`)
    }

    // inject renderer internals for keepAlive
    if (isKeepAlive(initialVNode)) {
      ;(instance.ctx as KeepAliveContext).renderer = internals
    }

    // resolve props and slots for setup context
    if (!(__COMPAT__ && compatMountInstance)) {
      if (__DEV__) {
        startMeasure(instance, `init`)
      }
      // 安装组件：选项处理 初始化组件实例
      setupComponent(instance)
      if (__DEV__) {
        endMeasure(instance, `init`)
      }
    }

    // setup() is async. This component relies on async logic to be resolved
    // before proceeding
    // 异步setup 此组件要在结束之前继续之前的异步逻辑(由setup返回的Promise)
    if (__FEATURE_SUSPENSE__ && instance.asyncDep) {
      parentSuspense && parentSuspense.registerDep(instance, setupRenderEffect)

      // Give it a placeholder if this is not hydration
      // TODO handle self-defined fallback
      // 如果不是服务端渲染 请给它一个占位符
      // 方便后面处理自定义的#fallback
      // 也就是说如果异步没有回来之前一直会有一个
      if (!initialVNode.el) {
        const placeholder = (instance.subTree = createVNode(Comment))
        processCommentNode(null, placeholder, container!, anchor)
      }
      return
    }

    // 建立渲染函数的副作用：依赖收集
    setupRenderEffect(
      instance,
      initialVNode,
      container,
      anchor,
      parentSuspense,
      isSVG,
      optimized
    )

    if (__DEV__) {
      popWarningContext()
      endMeasure(instance, `mount`)
    }
  }

  const updateComponent = (n1: VNode, n2: VNode, optimized: boolean) => {
    const instance = (n2.component = n1.component)!
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (
        __FEATURE_SUSPENSE__ &&
        instance.asyncDep &&
        !instance.asyncResolved
      ) {
        // async & still pending - just update props and slots
        // since the component's reactive effect for render isn't set-up yet
        if (__DEV__) {
          pushWarningContext(n2)
        }
        updateComponentPreRender(instance, n2, optimized)
        if (__DEV__) {
          popWarningContext()
        }
        return
      } else {
        // normal update
        instance.next = n2
        // in case the child component is also queued, remove it to avoid
        // double updating the same child component in the same flush.
        invalidateJob(instance.update)
        // instance.update is the reactive effect.
        instance.update()
      }
    } else {
      // no update needed. just copy over properties
      n2.component = n1.component
      n2.el = n1.el
      instance.vnode = n2
    }
  }

  // 安装渲染副作用
  const setupRenderEffect: SetupRenderEffectFn = (
    instance,
    initialVNode,
    container,
    anchor,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // 创建更新函数
    // 这个函数主要作用有两个：初次挂载节点和更新旧节点
    const componentUpdateFn = () => {
      // instance.isMounted的作用是表示当前组件实例是否挂载了
      if (!instance.isMounted) {
        let vnodeHook: VNodeHook | null | undefined
        const { el, props } = initialVNode
        // bm 代表 组合式API onBeforeMount() 生命周期钩子函数
        // m 代表 组合式API onMounted 生命周期钩子函数
        // parent 是当前组件实例的父组件实例
        const { bm, m, parent } = instance
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode)

        // 在处理组件一些东西的时候，如钩子函数等等 不允许去递归
        effect.allowRecurse = false
        // beforeMount hook onBeforeMount()
        if (bm) {
          invokeArrayFns(bm)
        }
        // onVnodeBeforeMount
        // 执行vnode即将开始挂载的生命周期函数
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeBeforeMount)
        ) {
          invokeVNodeHook(vnodeHook, parent, initialVNode)
        }
        // 兼容vue2的 VNode hook:beforeMount 生命周期函数配置
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          // beforeMount() {}
          instance.emit('hook:beforeMount')
        }
        // 开始挂载组件 允许递归
        effect.allowRecurse = true

        // 服务端渲染(Server Side Render) 
        if (el && hydrateNode) {
          // vnode has adopted host node - perform hydration instead of mount.
          // 服务端渲染不是挂载 而是通过hydrateNode将数据渲染到结构中
          // hydrateNode 是结构 hydrate树数据 两者通过 createHydrationFunctions 进行创建
          // 还有一些渲染和更新的函数
          const hydrateSubTree = () => {
            if (__DEV__) {
              startMeasure(instance, `render`)
            }
            instance.subTree = renderComponentRoot(instance)
            if (__DEV__) {
              endMeasure(instance, `render`)
            }
            if (__DEV__) {
              startMeasure(instance, `hydrate`)
            }
            hydrateNode!(
              el as Node,
              instance.subTree,
              instance,
              parentSuspense,
              null
            )
            if (__DEV__) {
              endMeasure(instance, `hydrate`)
            }
          }

          if (isAsyncWrapperVNode) {
            ;(initialVNode.type as ComponentOptions).__asyncLoader!().then(
              // note: we are moving the render call into an async callback,
              // which means it won't track dependencies - but it's ok because
              // a server-rendered async wrapper is already in resolved state
              // and it will never need to change.
              // 注意：我们正在将呈现调用移动到一个异步回调中，这意味着它不会跟踪依赖项-
              // 但这没有问题，因为服务器呈现的异步包装器(Suspense)已经处于已解析状态，它永远不需要更改。
              () => !instance.isUnmounted && hydrateSubTree()
            )
          } else {
            // 直接更新节点结构
            hydrateSubTree()
          }
        } else {
        // 不是Server Side Render 是客户端渲染(Client Side Render)
          if (__DEV__) {
            startMeasure(instance, `render`)
          }
          // subTree 是当前组件vnode 在内部调用render，
          // 在render在执行的过程中 回去访问响应式数据，会将当前的ReactiveEffect存储数据本身
          // 在后续的数据变化，会当前ReactiveEffect会被派发 render重新执行产生新的VNode
          const subTree = (instance.subTree = renderComponentRoot(instance))
          if (__DEV__) {
            endMeasure(instance, `render`)
          }
          if (__DEV__) {
            startMeasure(instance, `patch`)
          }
          // 初始化渲染
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            isSVG
          )
          if (__DEV__) {
            endMeasure(instance, `patch`)
          }
          // 更新el
          initialVNode.el = subTree.el
        }
        // mounted hook onMounted()
        if (m) {
          queuePostRenderEffect(m, parentSuspense)
        }
        // onVnodeMounted
        // 执行vnode挂载完成的生命周期函数
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeMounted)
        ) {
          const scopedInitialVNode = initialVNode
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, scopedInitialVNode),
            parentSuspense
          )
        }
        // 兼容vue2的 VNode  hook:mounted 生命周期函数配置
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:mounted'),
            parentSuspense
          )
        }
        // 这两个生命周期都需要进入队列 等待VNode渲染完成之后才会执行

        // activated hook for keep-alive roots.
        // #1742 activated hook must be accessed after first render
        // since the hook may be injected by a child keep-alive
        // 如果这个组件时被keep-alive缓存过(vue2就会有一个activated函数) 
        // 组件实例上就有一个a作为 在缓存组件被激活时被调用
        // 且都是在渲染队列中 等待渲染完成在调用
        // 但是服务器渲染不会有此钩子函数
        if (initialVNode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense)
          // 兼容vue2的 hook:activated VNode 生命周期函数配置
          if (
            __COMPAT__ &&
            isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
          ) {
            queuePostRenderEffect(
              () => instance.emit('hook:activated'),
              parentSuspense
            )
          }
        }
        // 组件挂载完成的标识
        instance.isMounted = true

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentAdded(instance)
        }

        // #2458: deference mount-only object parameters to prevent memleaks
        // 在组件挂载完毕 清除一切 保证内存不会泄露
        initialVNode = container = anchor = null as any
      } else {
        // updateComponent 组件更新 
        // This is triggered by mutation of component's own state (next: null)
        // OR parent calling processComponent (next: VNode)
        // 可能是内部数据发生了变化(next为null)，也可能是父组件发生变化引发子组件diff(next为VNode)
        // 也就是组件依赖父组件的props 会影响VNode渲染 props改变 子组件就会受到影响
        // bu 代表 组合式API onBeforeUpdate 生命周期钩子函数
        // u 代表 组合式API onUpdated 生命周期钩子函数
        // parent 是当前更新的实例的父组件实例
        // next 是 新的VNode vnode是旧的VNode
        let { next, bu, u, parent, vnode } = instance
        let originNext = next
        let vnodeHook: VNodeHook | null | undefined
        if (__DEV__) {
          pushWarningContext(next || instance.vnode)
        }

        // Disallow component effect recursion during pre-lifecycle hooks.
        // 在beforeUpdate生命周期函数执行期间不允许递归执行 防止重复收集
        // 组件可能会影响到子组件的变化 防止在更新子组件的时候重复收集依赖
        effect.allowRecurse = false

        // 如果只是数据变化，next为null 如果数据变化引发了diff next为VNode
        // 父组件引发组件的改变 组件的VNode会发生变化 需要去更新
        if (next) {
          next.el = vnode.el
          updateComponentPreRender(instance, next, optimized)
        } else {
          next = vnode
        }

        // beforeUpdate hook
        // 执行 组合式API onBeforeUpdate 生命周期函数
        if (bu) {
          invokeArrayFns(bu)
        }
        // onVnodeBeforeUpdate
        // 执行vnode即将更新的生命周期函数
        if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
          invokeVNodeHook(vnodeHook, parent, next, vnode)
        }
        // 兼容vue2的 VNode hook:beforeUpdate 生命周期函数配置
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeUpdate')
        }

        effect.allowRecurse = true

        // render
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        
        // 重新调用render 产生最新的VNode
        const nextTree = renderComponentRoot(instance)
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // 将旧的VNode存储起来 方便进行 diff
        const prevTree = instance.subTree
        // 将新的VNode挂载到实例上
        instance.subTree = nextTree

        if (__DEV__) {
          startMeasure(instance, `patch`)
        }
        // 更新渲染 新旧VNode做diff 这里是开始的地方
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          // teleport 通过to属性来确认当前在那个父节点(这个父节点最后不在vue树之中，最好在渲染之前就存在)中渲染该节点
          // to可以通过props接受指定的，可以通过修改to改变该节点渲染的位置，这也意味着父节点的改变，需要重新确认父节点
          hostParentNode(prevTree.el!)!,
          // anchor may have changed if it's in a fragment
          // 当前节点在一个fragment中,更新可能会导致兄弟节点变成其他节点,需要确认
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          isSVG
        )
        if (__DEV__) {
          endMeasure(instance, `patch`)
        }
        next.el = nextTree.el
        if (originNext === null) {
          // self-triggered update. In case of HOC, update parent component
          // vnode el. HOC is indicated by parent instance's subTree pointing
          // to child component's vnode
          // 自触发更新。如果是HOC，则更新父组件vnode el。HOC由指向子组件vnode的父实例子树表示
          updateHOCHostEl(instance, nextTree.el)
        }
        // composition API 生命周期函数 onUpdated
        // updated hook onUpdated
        if (u) {
          queuePostRenderEffect(u, parentSuspense)
        }
        // onVnodeUpdated
        // 执行vnode即将更新生命周期函数
        if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, next!, vnode),
            parentSuspense
          )
        }
        // 兼容vue2的 VNode hook:updated 生命周期函数配置
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:updated'),
            parentSuspense
          )
        }

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentUpdated(instance)
        }

        if (__DEV__) {
          popWarningContext()
        }
      }
    }

    /**
     * setupRenderEffect 等同于 Vue2 中的 updateComponent
     * setupRenderEffect内部执行了一个effect函数 effect 是将传入的fn和它内部调用的响应式数据之间产生一个映射关系
     * rootComponent.render() 内部会执行patch进行更新
     * 挂载流程 mount => render() => processComponent() => mountComponent() => setupComponent() => 然后分别调用 (响应式处理)setupStatefulComponent() 与 (依赖收集)setupRenderEffect()
     */

    // create reactive effect for rendering
    // 创建渲染effect 可以建立一个依赖关系：传入effect的回调函数和响应式数据之间 
    // 等同于一个渲染Watcher
    // 创建更新规则
    const effect = new ReactiveEffect(
      componentUpdateFn,
      // DOM diff 入口 一般都是由数据改变而触发的调度函数
      // 调度函数内部执行的是componentUpdateFn包装后的函数
      // 主要是以参数二的方式执行参数一
      () => queueJob(instance.update),
      instance.scope // track it in component's effect scope
    )

    // 获取更新函数
    // 将其挂载到组件实例上作为更新执行器 更新执行器会默认执行一遍
    const update = (instance.update = effect.run.bind(effect) as SchedulerJob)
    update.id = instance.uid
    // allowRecurse
    // #1801, #2043 component render effects should allow recursive updates
    effect.allowRecurse = update.allowRecurse = true

    if (__DEV__) {
      effect.onTrack = instance.rtc
        ? e => invokeArrayFns(instance.rtc!, e)
        : void 0
      effect.onTrigger = instance.rtg
        ? e => invokeArrayFns(instance.rtg!, e)
        : void 0
      // @ts-ignore (for scheduler)
      update.ownerInstance = instance
    }

    // 首次执行更新函数
    update()
  }

  // 更新组件实例中的VNode 以及props和slots 
  const updateComponentPreRender = (
    instance: ComponentInternalInstance,
    nextVNode: VNode,
    optimized: boolean
  ) => {
    // 新的VNode也会存储最初的组件实例
    nextVNode.component = instance
    // 存储上次旧的props 方便进行对比
    const prevProps = instance.vnode.props
    // 组件实例本身也会存储最新的VNode
    instance.vnode = nextVNode
    // 将next重新赋值为null
    instance.next = null
    // 更新属性和插槽
    updateProps(instance, nextVNode.props, prevProps, optimized)
    updateSlots(instance, nextVNode.children, optimized)

    // 暂停全局追踪
    pauseTracking()
    // props update may have triggered pre-flush watchers.
    // flush them before the render update.
    // 更新props 可能会触发它们的watchers 需要在进行patch之前，将他们全部执行一遍
    flushPreFlushCbs(undefined, instance.update)
    // 返回之前的track状态
    resetTracking()
  }

  // 更新子节点
  const patchChildren: PatchChildrenFn = (
    n1,
    n2,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds,
    optimized = false
  ) => {
    // 旧节点的Children 如果旧节点不存在代表更新
    const c1 = n1 && n1.children
    // 旧节点的ShapeFlag 如果旧节点不存在代表更新 默认是0
    const prevShapeFlag = n1 ? n1.shapeFlag : 0
    // 新节点的Children
    const c2 = n2.children

    // 新节点的patchFlag, shapeFlag
    const { patchFlag, shapeFlag } = n2
    // fast path
    // 存在 patchFlag 可以快速的进行更新节点列表
    if (patchFlag > 0) {
      if (patchFlag & PatchFlags.KEYED_FRAGMENT) {
        // this could be either fully-keyed or mixed (some keyed some not)
        // presence of patchFlag means children are guaranteed to be arrays
        // 这里可以是全部键控，也可以是混合键控(全部节点有key 或者 一些节点有key一些节点没有key)
        patchKeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        return
      } else if (patchFlag & PatchFlags.UNKEYED_FRAGMENT) {
        // unkeyed
        // 全部没有key
        patchUnkeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        return
      }
    }

    // children has 3 possibilities: text, array or no children.
    // 子节点有三种可能：文本 Children数组 没有children
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // text children fast path
      // Children 是文本 快速更新
      // 如果原本是Children数组 现在需要更新为文本 需要将旧的节点全部卸载
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        unmountChildren(c1 as VNode[], parentComponent, parentSuspense)
      }
      if (c2 !== c1) {
        hostSetElementText(container, c2 as string)
      }
    } else {
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // prev children was array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // two arrays, cannot assume anything, do full diff
          patchKeyedChildren(
            c1 as VNode[],
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else {
          // no new children, just unmount old
          unmountChildren(c1 as VNode[], parentComponent, parentSuspense, true)
        }
      } else {
        // prev children was text OR null
        // new children is array OR null
        if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
          hostSetElementText(container, '')
        }
        // mount new if array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            c2 as VNodeArrayChildren,
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
    }
  }

  // 对比多个没有key的子项
  const patchUnkeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 不确保新旧节点列表是否都有
    c1 = c1 || EMPTY_ARR
    c2 = c2 || EMPTY_ARR
    // 新旧节点列表的长度 两个列表的长度获取不同
    // 可能会删除节点或者是新增节点
    const oldLength = c1.length
    const newLength = c2.length
    const commonLength = Math.min(oldLength, newLength)
    let i
    // 从头开始对比更新新旧节点列表都有的节点 和全量diff差不多
    for (i = 0; i < commonLength; i++) {
      const nextChild = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    }
    // 根据两个列表的长度确定是新增节点还是删除节点
    // 如果旧节点列表长度大于新节点列表长度 代表有些节点在新节点列表中不存在 需要卸载新子节点列表中不存在的旧节点
    // 如果新节点列表长度大于旧节点列表长度 代表有些节点在旧节点列表中不存在 需要新增旧节点中列表中不存在的新节点
    if (oldLength > newLength) {
      // remove old
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength
      )
    } else {
      // mount new
      // 挂载旧节点列表中不存在的新节点
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized,
        commonLength
      )
    }
  }

  // can be all-keyed or mixed
  const patchKeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    parentAnchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    let i = 0
    const l2 = c2.length
    // 旧节点列表中最大索引
    let e1 = c1.length - 1 // prev ending index
    // 新节点列表中最大索引
    let e2 = l2 - 1 // next ending index

    // 1. sync from start
    // (a b) c
    // (a b) d e
    while (i <= e1 && i <= e2) {
    // 同步对比开始位置：
    // 找不同 更新节点 在相同节点类型的情况下 
    // 跳过该节点 在节点类型不同的情况下
      const n1 = c1[i]
      // 在优化(已经挂载)的情况下克隆一份 不然直接标准化后对比
      const n2 = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      } else {
        break
      }
      i++
    }

    // 2. sync from end
    // a (b c)
    // d e (b c)
    while (i <= e1 && i <= e2) {
    // 同步对比结束位置：
    // 找不同 更新节点 在相同节点类型的情况下 
    // 跳过该节点 在节点类型不同的情况下
    // 减小新旧节点列表的对比数量，如果正常的patch完毕(对比完成 后续不在对比)
      const n1 = c1[e1]
      const n2 = (c2[e2] = optimized
        ? cloneIfMounted(c2[e2] as VNode)
        : normalizeVNode(c2[e2]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      } else {
        break
      }
      e1--
      e2--
    }

    // 3. common sequence + mount
    // (a b)
    // (a b) c
    // i = 2, e1 = 1, e2 = 2
    // (a b)
    // c (a b)
    // i = 0, e1 = -1, e2 = 0
    if (i > e1) {
      if (i <= e2) {
        // 挂载新节点
        // 更新位置的下一个节点的索引(可能是新增最后一个节点 则是parentAnchor)
        const nextPos = e2 + 1
        // parentAnchor 其实是节点列表结束的位置一般都是空字符串
        // anchor 会根据新增的是不是最后一个节点
        // 如果是 就会用parentAnchor作为更新位置标记
        // 不是 如这种情况 (a b) c (d, e)  会找到新增位置的下一个节点作为更新位置标记
        const anchor = nextPos < l2 ? (c2[nextPos] as VNode).el : parentAnchor
        while (i <= e2) {
          patch(
            null,
            (c2[i] = optimized
              ? cloneIfMounted(c2[i] as VNode)
              : normalizeVNode(c2[i])),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
          i++
        }
      }
    }

    // 删除旧节点
    // 4. common sequence + unmount
    // (a b) c
    // (a b)
    // i = 2, e1 = 2, e2 = 1
    // a (b c)
    // (b c)
    // i = 0, e1 = 0, e2 = -1
    else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true)
        i++
      }
    }

    // 5. unknown sequence
    // [i ... e1 + 1]: a b [c d e] f g
    // [i ... e2 + 1]: a b [e d c h] f g
    // i = 2, e1 = 4, e2 = 5
    else {
      const s1 = i // prev starting index
      const s2 = i // next starting index

      // 5.1 build key:index map for newChildren
      // 找到新的key和索引的映射关系 保存在 keyToNewIndexMap 中
      const keyToNewIndexMap: Map<string | number | symbol, number> = new Map()
      for (i = s2; i <= e2; i++) {
        const nextChild = (c2[i] = optimized
          ? cloneIfMounted(c2[i] as VNode)
          : normalizeVNode(c2[i]))
        if (nextChild.key != null) {
          if (__DEV__ && keyToNewIndexMap.has(nextChild.key)) {
            warn(
              `Duplicate keys found during update:`,
              JSON.stringify(nextChild.key),
              `Make sure keys are unique.`
            )
          }
          keyToNewIndexMap.set(nextChild.key, i)
        }
      }

      // 5.2 loop through old children left to be patched and try to patch
      // matching nodes & remove nodes that are no longer present
      // 循环旧节点列表 以匹配需要更新的节点和删除不需要的节点
      let j
      let patched = 0
      // 还需要更新节点数量
      const toBePatched = e2 - s2 + 1
      // 标记是否有子节点需要移动
      let moved = false
      // used to track whether any node has moved
      let maxNewIndexSoFar = 0
      // works as Map<newIndex, oldIndex>
      // Note that oldIndex is offset by +1
      // and oldIndex = 0 is a special value indicating the new node has
      // no corresponding old node.
      // used for determining longest stable subsequence
      // 找到新索引的和旧索引的映射关系
      // newIndexToOldIndexMap也是旧节点根据新节点重新排序的情况 在移动节点的情况下
      // 注意oldinex=0是一个特殊值，表示新节点没有对应的旧节点。用于确定最长稳定子序列
      const newIndexToOldIndexMap = new Array(toBePatched)
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0

      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i]
        if (patched >= toBePatched) {
          // 只能卸载节点 在从5开始更新完毕的节点数量大于需要更新的节点
          // all new children have been patched so this can only be a removal
          unmount(prevChild, parentComponent, parentSuspense, true)
          continue
        }
        // 节点的新索引
        let newIndex
        if (prevChild.key != null) {
          // 存在key 在新key和旧key映射中找到对应 => 找到对应的新节点和旧节点
          newIndex = keyToNewIndexMap.get(prevChild.key)
        } else {
          // 节点没有设置 key 尝试从新旧索引映射中找索引 试图在旧的节点中找到相同没有key的节点
          // key-less node, try to locate a key-less node of the same type
          for (j = s2; j <= e2; j++) {
            if (
              newIndexToOldIndexMap[j - s2] === 0 &&
              isSameVNodeType(prevChild, c2[j] as VNode)
            ) {
              newIndex = j
              break
            }
          }
        }
        if (newIndex === undefined) {
          // 没有找到 旧节点没有对应的新节点 卸载这个节点
          unmount(prevChild, parentComponent, parentSuspense, true)
        } else {
          // oldIndex值不为零 说明有对应的节点存在 设置为节点索引+1
          newIndexToOldIndexMap[newIndex - s2] = i + 1
          // maxNewIndexSoFar 是当前对比的旧节点对应新节点的最大位置(默认认为是安装顺序来的)
          // 如果小于了对应的最大的位置说明这个节点移动了
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex
          } else {
            moved = true
          }
          patch(
            prevChild,
            c2[newIndex] as VNode,
            container,
            null,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
          // 更新完毕的节点数量加一
          patched++
        }
      }

      // 5.3 move and mount
      // generate longest stable subsequence only when nodes have moved
      // 返回的是newIndexToOldIndexMap中最长递增子序列的索引汇总
      const increasingNewIndexSequence = moved
        ? getSequence(newIndexToOldIndexMap)
        : EMPTY_ARR
      j = increasingNewIndexSequence.length - 1
      // looping backwards so that we can use last patched node as anchor
      // 从后面开始循环 以便我们可以使用最后一个修补的节点作为锚点
      // 找出新节点中的最长递增子序列(也可以说是那些没有变化的结果)，移动不在该范围的节点
      // 如：原本是[1, 2, 3, 4, 5, 6] 修改之后=> [3, 1, 4, 5, 6, 2]
      // 那么最长递增子序列就是 [3, 4, 5, 6] 可以直接看出只有1和2移动了,
      // 所以移动的依据判断这个节点是否在这个序列中
      // 且在移动的时候,是通过找到当前节点在新节点列表中位置的下一个 通过 insertBefore 进行移动
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i
        const nextChild = c2[nextIndex] as VNode
        const anchor =
          nextIndex + 1 < l2 ? (c2[nextIndex + 1] as VNode).el : parentAnchor
        if (newIndexToOldIndexMap[i] === 0) {
          // 这里是移动新增
          // mount new
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (moved) {
          // move if:
          // There is no stable subsequence (e.g. a reverse)
          // OR current node is not among the stable sequence
          // 如果移动：没有稳定的子序列（例如反向）或当前节点不在稳定序列中 进行节点移动
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            move(nextChild, container, anchor, MoveType.REORDER)
          } else {
            j--
          }
        }
      }
    }
  }

  const move: MoveFn = (
    vnode,
    container,
    anchor,
    moveType,
    parentSuspense = null
  ) => {
    // 取出编译时产生的标记以及其他的一些东西 
    // 最重要的是 shapeFlag 和 el
    // shapeFlag 说明了当前节点包含说明：组件？文本？详细见shapeFlag.ts文件
    // el 是当前节点的真实元素
    // 下面是根据shapeFlag执行不同的move函数(经过一些包装) 但是最后都是调用这个move方法
    const { el, type, transition, children, shapeFlag } = vnode
    if (shapeFlag & ShapeFlags.COMPONENT) {
      move(vnode.component!.subTree, container, anchor, moveType)
      return
    }

    // 移动Suspense
    if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
      vnode.suspense!.move(container, anchor, moveType)
      return
    }

    // 移动Teleport
    if (shapeFlag & ShapeFlags.TELEPORT) {
      ;(type as typeof TeleportImpl).move(vnode, container, anchor, internals)
      return
    }

    // 移动Fragment
    if (type === Fragment) {
      hostInsert(el!, container, anchor)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move((children as VNode[])[i], container, anchor, moveType)
      }
      hostInsert(vnode.anchor!, container, anchor)
      return
    }

    // 移动静态节点
    if (type === Static) {
      moveStaticNode(vnode, container, anchor)
      return
    }

    // single nodes
    // needTransition 确认是不是需要动画过渡
    const needTransition =
      moveType !== MoveType.REORDER &&
      shapeFlag & ShapeFlags.ELEMENT &&
      transition
    if (needTransition) {
      // 判断是进入动画 还是退出动画
      // transition 是内置组件transition实现的一些hook 
      //  beforeEnter(即将进入) enter(进入) leave(离开) clone(主要作用：
      // 将vnode.transition上的hook函数克隆一份放到vnode上，在渲染器的某个时刻执行)
      // 还有其他的很多hook
      // 具体实现可以去看BaseTransition.ts 这里就先不展开
      if (moveType === MoveType.ENTER) {
        transition!.beforeEnter(el!)
        hostInsert(el!, container, anchor)
        queuePostRenderEffect(() => transition!.enter(el!), parentSuspense)
      } else {
        const { leave, delayLeave, afterLeave } = transition!
        const remove = () => hostInsert(el!, container, anchor)
        const performLeave = () => {
          leave(el!, () => {
            remove()
            afterLeave && afterLeave()
          })
        }
        // transition in-out模式
        if (delayLeave) {
          delayLeave(el!, remove, performLeave)
        } else {
          performLeave()
        }
      }
    } else {
      hostInsert(el!, container, anchor)
    }
  }

  // 卸载节点
  const unmount: UnmountFn = (
    vnode,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false
  ) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      // dirs是自定义指令的一些内容
      dirs
    } = vnode
    // unset ref
    // 删除 template ref 模板引用
    if (ref != null) {
      setRef(ref, null, parentSuspense, vnode, true)
    }

    // 缓存过的组件 清除缓存 使其停止工作
    if (shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
      ;(parentComponent!.ctx as KeepAliveContext).deactivate(vnode)
      return
    }

    // 是否有自定义指令生命周期函数需要执行
    const shouldInvokeDirs = shapeFlag & ShapeFlags.ELEMENT && dirs
    // 排除异步组件容器 只执行普通的
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode)

    // 执行即将卸载vnode的生命周期函数
    let vnodeHook: VNodeHook | undefined | null
    if (
      shouldInvokeVnodeHook &&
      (vnodeHook = props && props.onVnodeBeforeUnmount)
    ) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode)
    }

    // 如果Children是组件 走卸载组件的方法
    if (shapeFlag & ShapeFlags.COMPONENT) {
      unmountComponent(vnode.component!, parentSuspense, doRemove)
    } else {
      if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
        // 执行Suspense扩展过的remove函数
        vnode.suspense!.unmount(parentSuspense, doRemove)
        return
      }

      // 自定义指令的 beforeUnmount 生命周期函数
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount')
      }

      if (shapeFlag & ShapeFlags.TELEPORT) {
        // 执行Teleport扩展过的remove函数
        ;(vnode.type as typeof TeleportImpl).remove(
          vnode,
          parentComponent,
          parentSuspense,
          optimized,
          internals,
          doRemove
        )
      } else if (
        dynamicChildren &&
        // #1153: fast path should not be taken for non-stable (v-for) fragments
        // 对于不稳定（v-for）碎片，不应采用快速路径 防止无法触发组件的onUnmounted
        (type !== Fragment ||
          (patchFlag > 0 && patchFlag & PatchFlags.STABLE_FRAGMENT))
      ) {
        // fast path for block nodes: only need to unmount dynamic children.
        // 块节点的快速路径：只需卸载动态子节点
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true
        )
      } else if (
        (type === Fragment &&
          patchFlag &
            (PatchFlags.KEYED_FRAGMENT | PatchFlags.UNKEYED_FRAGMENT)) ||
        (!optimized && shapeFlag & ShapeFlags.ARRAY_CHILDREN)
      ) {
        unmountChildren(children as VNode[], parentComponent, parentSuspense)
      }

      if (doRemove) {
        remove(vnode)
      }
    }

    // 执行卸载vnode时的生命周期函数 还有自定义指令的卸载
    if (
      (shouldInvokeVnodeHook &&
        (vnodeHook = props && props.onVnodeUnmounted)) ||
      shouldInvokeDirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        shouldInvokeDirs &&
          invokeDirectiveHook(vnode, null, parentComponent, 'unmounted')
      }, parentSuspense)
    }
  }

  // 卸载函数 根据节点类型处理
  const remove: RemoveFn = vnode => {
    const { type, el, anchor, transition } = vnode
    // anchor 是 el的结束位置
    if (type === Fragment) {
      removeFragment(el!, anchor!)
      return
    }

    if (type === Static) {
      removeStaticNode(vnode)
      return
    }

    // 执行删除元素 执行当前元素的afterLeave(元素被删除之后执行)如果有
    const performRemove = () => {
      hostRemove(el!)
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave()
      }
    }

    // 删除元素 如果元素的存在transition
    // 存在delayLeave in-out模式 等待新元素进入完毕 当前元素才会离开(执行leave)
    // 没有执行performRemove
    if (
      vnode.shapeFlag & ShapeFlags.ELEMENT &&
      transition &&
      !transition.persisted
    ) {
      const { leave, delayLeave } = transition
      const performLeave = () => leave(el!, performRemove)
      if (delayLeave) {
        delayLeave(vnode.el!, performRemove, performLeave)
      } else {
        performLeave()
      }
    } else {
      performRemove()
    }
  }

  const removeFragment = (cur: RendererNode, end: RendererNode) => {
    // For fragments, directly remove all contained DOM nodes.
    // (fragment child nodes cannot have transition)
    // fragments 的子节点不能带有transition
    let next
    // 如果是 Fragments 循环删除删除所有的子节点，
    while (cur !== end) {
      next = hostNextSibling(cur)!
      hostRemove(cur)
      cur = next
    }
    // 最后将end删除
    hostRemove(end)
  }

  const unmountComponent = (
    instance: ComponentInternalInstance,
    parentSuspense: SuspenseBoundary | null,
    doRemove?: boolean
  ) => {
    if (__DEV__ && instance.type.__hmrId) {
      unregisterHMR(instance)
    }

    // bum是option api的生命周期函数选项beforeUnmount
    // scope是effect作用域
    // update是更新器，也就是在setupRenderEffect函数中产生的 update函数 内部是componentUpdateFn函数
    // subTree是当前的vnode结构
    // um是option api的生命周期函数选项unmounted
    const { bum, scope, update, subTree, um } = instance

    // beforeUnmount hook
    // composition api onBeforeUnmount生命周期函数
    if (bum) {
      invokeArrayFns(bum)
    }

    // 兼容vue2的 VNode hook:beforeDestroy 生命周期函数配置
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      instance.emit('hook:beforeDestroy')
    }

    // stop effects in component scope
    // 停止组件作用域中的所有的effect
    scope.stop()

    // update may be null if a component is unmounted before its async
    // setup has resolved.
    // 如果在异步setup解决之前卸载组件，则更新器可能为空
    if (update) {
      // so that scheduler will no longer invoke it
      // 这样调度器就不会再调用它
      update.active = false
      // 删除vnode结构
      unmount(subTree, instance, parentSuspense, doRemove)
    }
    // unmounted hook
    // composition api onUnmount函数 是一个在组件卸载完毕之后才执行的函数
    // 所以会等待渲染队列执行完毕才会执行
    if (um) {
      queuePostRenderEffect(um, parentSuspense)
    }
    // 兼容vue2的 VNode hook:destroyed 生命周期函数配置
    // 同样需要放在渲染队列之后执行
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      queuePostRenderEffect(
        () => instance.emit('hook:destroyed'),
        parentSuspense
      )
    }
    // 在一切都执行完毕之后 就可以把isUnmounted卸载完成的标识更改为true
    queuePostRenderEffect(() => {
      instance.isUnmounted = true
    }, parentSuspense)

    // A component with async dep inside a pending suspense is unmounted before
    // its async dep resolves. This should remove the dep from the suspense, and
    // cause the suspense to resolve immediately if that was the last dep.
    // 在挂起的 suspense 中带有 async dep 的组件之前被卸载，如果那是最后一个dep。它的 async 
    // dep 解析。这应该从 suspense中执行dep，并让suspense立即删除，
    if (
      __FEATURE_SUSPENSE__ &&
      parentSuspense &&
      parentSuspense.pendingBranch &&
      !parentSuspense.isUnmounted &&
      instance.asyncDep &&
      !instance.asyncResolved &&
      instance.suspenseId === parentSuspense.pendingId
    ) {
      parentSuspense.deps--
      if (parentSuspense.deps === 0) {
        parentSuspense.resolve()
      }
    }

    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      devtoolsComponentRemoved(instance)
    }
  }

  // 遍历卸载节点的Children
  const unmountChildren: UnmountChildrenFn = (
    children,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false,
    start = 0
  ) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized)
    }
  }

  const getNextHostNode: NextFn = vnode => {
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return getNextHostNode(vnode.component!.subTree)
    }
    if (__FEATURE_SUSPENSE__ && vnode.shapeFlag & ShapeFlags.SUSPENSE) {
      return vnode.suspense!.next()
    }
    // nextSibling: node => node.nextSibling 获取下一个兄弟节点
    return hostNextSibling((vnode.anchor || vnode.el)!)
  }

  // 渲染传入vnode 到指定容器中
  const render: RootRenderFunction = (vnode, container, isSVG) => {
    if (vnode == null) {
      if (container._vnode) {
        // VNode不存在 但是页面上存在东西 需要删除
        unmount(container._vnode, null, null, true)
      }
    } else {
      // 判断之前是否有虚拟DOM 有进行diff 没有直接初始化 挂载
      patch(container._vnode || null, vnode, container, null, null, null, isSVG)
    }
    // 执行等待渲染完成才执行的函数
    flushPostFlushCbs()
    container._vnode = vnode
  }

  // VNode更新和挂载时用到的一些函数 option是当前平台的操作实际节点的一些方法
  const internals: RendererInternals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  }

  let hydrate: ReturnType<typeof createHydrationFunctions>[0] | undefined
  let hydrateNode: ReturnType<typeof createHydrationFunctions>[1] | undefined
  if (createHydrationFns) {
    ;[hydrate, hydrateNode] = createHydrationFns(
      internals as RendererInternals<Node, Element>
    )
  }

  // 返回的就是renderer
  return {
    render,
    hydrate,
    createApp: createAppAPI(render, hydrate)
  }
}

// 设置特殊的属性ref 可以是字符串 可以是函数 可以是Refs
export function setRef(
  rawRef: VNodeNormalizedRef,
  oldRawRef: VNodeNormalizedRef | null,
  parentSuspense: SuspenseBoundary | null,
  vnode: VNode,
  isUnmount = false
) {
  // 兼容vue2 vFor ref 数组
  if (isArray(rawRef)) {
    rawRef.forEach((r, i) =>
      setRef(
        r,
        oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef),
        parentSuspense,
        vnode,
        isUnmount
      )
    )
    return
  }

  // 安装异步组件时，无需执行任何操作，因为模板引用被转发到内部组件
  if (isAsyncWrapper(vnode) && !isUnmount) {
    // when mounting async components, nothing needs to be done,
    // because the template ref is forwarded to inner component
    return
  }

  // 根据情况，拿到的是组件实例或者是元素
  const refValue =
    vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT
      ? getExposeProxy(vnode.component!) || vnode.component!.proxy
      : vnode.el
  const value = isUnmount ? null : refValue

  const { i: owner, r: ref } = rawRef
  // ref的归属者必须存在
  if (__DEV__ && !owner) {
    warn(
      `Missing ref owner context. ref cannot be used on hoisted vnodes. ` +
        `A vnode with ref must be created inside the render function.`
    )
    return
  }
  // 旧的ref的值
  const oldRef = oldRawRef && (oldRawRef as VNodeNormalizedRefAtom).r
  // 这个就是$refs
  const refs = owner.refs === EMPTY_OBJ ? (owner.refs = {}) : owner.refs
  // 元素所在的组件的数据状态
  const setupState = owner.setupState

  // dynamic ref changed. unset old ref
  // 动态ref改变 删除旧的ref
  if (oldRef != null && oldRef !== ref) {
    if (isString(oldRef)) {
      refs[oldRef] = null
      if (hasOwn(setupState, oldRef)) {
        setupState[oldRef] = null
      }
    } else if (isRef(oldRef)) {
      oldRef.value = null
    }
  }

  if (isString(ref)) {
    // 重新设置ref
    const doSet = () => {
      if (__COMPAT__ && isCompatEnabled(DeprecationTypes.V_FOR_REF, owner)) {
        // 兼容vue2
        registerLegacyRef(refs, ref, refValue, owner, rawRef.f, isUnmount)
      } else {
        refs[ref] = value
      }
      if (hasOwn(setupState, ref)) {
        setupState[ref] = value
      }
    }
    // #1789: for non-null values, set them after render
    // null values means this is unmount and it should not overwrite another
    // ref with the same key
    // 对于非空值，请在渲染后设置它们，空值表示这是卸载，不应该使用相同的键覆盖另一个ref
    if (value) {
      ;(doSet as SchedulerJob).id = -1
      queuePostRenderEffect(doSet, parentSuspense)
    } else {
      doSet()
    }
  } else if (isRef(ref)) {
    const doSet = () => {
      ref.value = value
    }
    if (value) {
      ;(doSet as SchedulerJob).id = -1
      queuePostRenderEffect(doSet, parentSuspense)
    } else {
      doSet()
    }
  } else if (isFunction(ref)) {
    callWithErrorHandling(ref, owner, ErrorCodes.FUNCTION_REF, [value, refs])
  } else if (__DEV__) {
    warn('Invalid template ref type:', value, `(${typeof value})`)
  }
}

// 同步的带错误的执行生命周期钩子函数
export function invokeVNodeHook(
  hook: VNodeHook,
  instance: ComponentInternalInstance | null,
  vnode: VNode,
  prevVNode: VNode | null = null
) {
  callWithAsyncErrorHandling(hook, instance, ErrorCodes.VNODE_HOOK, [
    vnode,
    prevVNode
  ])
}

/**
 * #1156
 * When a component is HMR-enabled, we need to make sure that all static nodes
 * inside a block also inherit the DOM element from the previous tree so that
 * HMR updates (which are full updates) can retrieve the element for patching.
 * 
 * 当组件启用HMR时，我们需要确保块内的所有静态节点也继承上一个树中的DOM元素，
 * 以便HMR更新（即完全更新）可以检索要修补的元素。
 *
 * #2080
 * Inside keyed `template` fragment static children, if a fragment is moved,
 * the children will always be moved. Therefore, in order to ensure correct move
 * position, el should be inherited from previous nodes.
 * 
 * 在键控的'template'片段静态子对象中，如果移动片段，子对象始终将移动。
 * 因此，为了确保正确的移动位置，el应该从以前的节点继承。
 * 
 */
// 递归寻找或者是定位旧的el 以便在更新节点进行引用 防止更新阶段会抛出 el is null
export function traverseStaticChildren(n1: VNode, n2: VNode, shallow = false) {
  const ch1 = n1.children
  const ch2 = n2.children
  if (isArray(ch1) && isArray(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      // this is only called in the optimized path so array children are
      // guaranteed to be vnodes
      // 这只在优化路径中调用，因此保证数组子节点是VNode
      const c1 = ch1[i] as VNode
      let c2 = ch2[i] as VNode
      if (c2.shapeFlag & ShapeFlags.ELEMENT && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === PatchFlags.HYDRATE_EVENTS) {
          c2 = ch2[i] = cloneIfMounted(ch2[i] as VNode)
          // 继承直接的节点el
          c2.el = c1.el
        }
        // 不是浅的，继续往下找
        if (!shallow) traverseStaticChildren(c1, c2)
      }
      // also inherit for comment nodes, but not placeholders (e.g. v-if which
      // would have received .el during block patch)
      // 而且只继承定位注释节点，但不继承占位符（例如，v-if，在块修补期间会继续使用el）
      if (__DEV__ && c2.type === Comment && !c2.el) {
        c2.el = c1.el
      }
    }
  }
}

// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
// 最长递增子序列
// 这个方法返回的是arr中最长递增子序列的中所有项对应的索引汇总
function getSequence(arr: number[]): number[] {
  // 数组p的作用：和原数组一样的长度 每一项记录的是自己在result中的前一个位置的值 值是索引 对应的是原数组中的值
  const p = arr.slice()
  const result = [0]
  let i, j, u, v, c
  /**
   * c 是中间值的索引
   * i 是当前比较项的索引
   * j 是当前项的前一个索引
   * u 是数组的前半部分
   * v 是数组的后半部分
   */
  const len = arr.length
  for (i = 0; i < len; i++) {
    /**
     * 使用数组中的每一项和结果中索引的最后一个(当成最大的)对应的值(我把它叫做：lastValue)对比
     * 如果当前项大于lastValue 就可以将当前项的索引存储在结果中
     * 当前处理完成 就可以跳出当前循环 进行下一项的处理
     */

    // 当前对比项
    const arrI = arr[i]
    if (arrI !== 0) {
      j = result[result.length - 1]
      if (arr[j] < arrI) {
        // 和当前对比项对比 大于 添加映射 并将索引加入的result中 跳过当前循环
        p[i] = j
        // 将值的索引添加到结果中 在这个值符合条件的情况
        result.push(i)
        continue
      }
      u = 0
      v = result.length - 1
      // 二分算法查找result中的区间 找到递增子序列中里当前对比项尽量相差小值的索引
      // 所对应的值是就是arr[result[u]] 这会出现三种情况，如果是小于和等于，不做任何操作
      // 如果是大于 将result[u]的值改为当前索引 i  u不能是0 u等于0则意思是我是第一个 前面没有了
      // u不等于0 就在 p数组中i的位置上记录我在result中的前一个的值
      while (u < v) {
        c = (u + v) >> 1
        if (arr[result[c]] < arrI) {
          u = c + 1
        } else {
          v = c
        }
      }
      // arr[result[u]] 是通过前面二分算法
      if (arrI < arr[result[u]]) {
        // 当前对比项小于 arr[result[u]] 将result[u]的索引修改为当前对比项的索引
        if (u > 0) {
          // u等于0 说明我是最小的 前面没有比我更小的了
          p[i] = result[u - 1]
        }
        result[u] = i
      }
    }
  }
  // 回溯数组 数组p中记录最长递增子序列的映射 根据映射找到正确的最长递增子序列索引
  // 按照当前result长度
  u = result.length
  v = result[u - 1]
  while (u-- > 0) {
    result[u] = v
    v = p[v]
  }
  return result
}
