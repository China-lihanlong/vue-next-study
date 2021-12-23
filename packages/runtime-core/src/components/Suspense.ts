import {
  VNode,
  normalizeVNode,
  VNodeProps,
  isSameVNodeType,
  openBlock,
  closeBlock,
  currentBlock,
  Comment,
  createVNode,
  isBlockTreeEnabled
} from '../vnode'
import { isFunction, isArray, ShapeFlags, toNumber } from '@vue/shared'
import { ComponentInternalInstance, handleSetupResult } from '../component'
import { Slots } from '../componentSlots'
import {
  RendererInternals,
  MoveType,
  SetupRenderEffectFn,
  RendererNode,
  RendererElement
} from '../renderer'
import { queuePostFlushCb } from '../scheduler'
import { filterSingleRoot, updateHOCHostEl } from '../componentRenderUtils'
import { pushWarningContext, popWarningContext, warn } from '../warning'
import { handleError, ErrorCodes } from '../errorHandling'

export interface SuspenseProps {
  onResolve?: () => void
  onPending?: () => void
  onFallback?: () => void
  timeout?: string | number
}

/**
 * Suspense的vnode
 *  Suspense的vnode的Choldren的是两个渲染函数 一个渲染#default中的内容 一个渲染#fallback中的内容
 *  vnode上会有两个属性 ssContent和ssFallback 分别对应其#default和#fallback的vnode
 *  且Suspense会产生一个suspense对象 记录了一些操作函数、#fallback容器和#default容器、是否SSR等信息
 *  在suspense对象初始化完成之后便会放在vnode上 或者是在更新时，再次挂在新的vnode上
 * 
 * #default会被设置为pendingBranch(即将挂载到页面上的) 
 * #fallback会被设置为activeBranch(已经挂载到页面上的)
 * Suspense 会先处理#default中的内容 并将ssContent放到pendingBranch上
 * 然后再处理#fallback中的内容 将其挂载到vue树中 并且设置为activeBranch
 * 
 * Suspense 更新阶段 
 * 
 * Suspense有三个独有的周期函数 onResolve onFallback onPending
 *  onResolve 在resolve执行完的最后执行
 *  onPending 在加载pendingBranch之前会触发
 *  onFallback 在加载#fallback树之前会执行一次
 * 
 */

// 判断是否为Suspense
export const isSuspense = (type: any): boolean => type.__isSuspense

// Suspense exposes a component-like API, and is treated like a component
// in the compiler, but internally it's a special built-in type that hooks
// directly into the renderer.
// Suspense 暴露了一个类似组件的 API，在编译器中被视为组件，但在内部它是一个特殊的内置类型，
// 它直接挂钩到渲染器中
export const SuspenseImpl = {
  name: 'Suspense',
  // In order to make Suspense tree-shakable, we need to avoid importing it
  // directly in the renderer. The renderer checks for the __isSuspense flag
  // on a vnode's type and calls the `process` method, passing in renderer
  // internals.
  // 为了使 Suspense tree-shakable，我们需要避免在渲染器中直接导入。 渲染器检查 vnode 类型上的 
  // __isSuspense 标志并调用 `process` 方法，传入渲染器内部。
  __isSuspense: true,
  // 挂载方法
  process(
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean,
    // platform-specific impl passed from renderer
    // 从渲染器传递的特定于平台的实现
    rendererInternals: RendererInternals
  ) {
    // 旧的存在就更新 不存咋的就挂载
    if (n1 == null) {
      mountSuspense(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized,
        rendererInternals
      )
    } else {
      patchSuspense(
        n1,
        n2,
        container,
        anchor,
        parentComponent,
        isSVG,
        slotScopeIds,
        optimized,
        rendererInternals
      )
    }
  },
  hydrate: hydrateSuspense,
  create: createSuspenseBoundary,
  normalize: normalizeSuspenseChildren
}

// Force-casted public typing for h and TSX props inference
export const Suspense = (__FEATURE_SUSPENSE__ ? SuspenseImpl : null) as any as {
  __isSuspense: true
  new (): { $props: VNodeProps & SuspenseProps }
}

function triggerEvent(
  vnode: VNode,
  name: 'onResolve' | 'onPending' | 'onFallback'
) {
  const eventListener = vnode.props && vnode.props[name]
  if (isFunction(eventListener)) {
    eventListener()
  }
}

function mountSuspense(
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals
) {
  const {
    p: patch,
    o: { createElement }
  } = rendererInternals
  // #default内容的容器
  const hiddenContainer = createElement('div')
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    container,
    hiddenContainer,
    anchor,
    isSVG,
    slotScopeIds,
    optimized,
    rendererInternals
  ))

  // start mounting the content subtree in an off-dom container
  // 先开始处理#default中的内容 并将其后续放到异步队列中 后面开始处理#fallback
  patch(
    null,
    (suspense.pendingBranch = vnode.ssContent!),
    hiddenContainer,
    null,
    parentComponent,
    suspense,
    isSVG,
    slotScopeIds
  )
  // now check if we have encountered any async deps
  // 如果没有产生异步的dep 直接可以进行resolve
  if (suspense.deps > 0) {
    // has async
    // invoke @fallback event
    triggerEvent(vnode, 'onPending')
    triggerEvent(vnode, 'onFallback')

    // mount the fallback tree
    patch(
      null,
      vnode.ssFallback!,
      container,
      anchor,
      parentComponent,
      null, // fallback tree will not have suspense context
      isSVG,
      slotScopeIds
    )
    // 挂载完毕之后 将其设置为activeBranch
    setActiveBranch(suspense, vnode.ssFallback!)
  } else {
    // Suspense has no async deps. Just resolve.
    suspense.resolve()
  }
}

function patchSuspense(
  n1: VNode,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  { p: patch, um: unmount, o: { createElement } }: RendererInternals
) {
  // 获取原始的suspense对象 将其放在新的vnode身上 还有挂载的容器
  const suspense = (n2.suspense = n1.suspense)!
  suspense.vnode = n2
  n2.el = n1.el
  // 新的 #default
  const newBranch = n2.ssContent!
  // 新的 #fallback
  const newFallback = n2.ssFallback!

  // activeBranch：当前已经挂载的, pendingBranch：还在等待结果返回的, 
  // isInFallback：显示的内容还是fallback?, isHydrating：SSR是否完成？
  const { activeBranch, pendingBranch, isInFallback, isHydrating } = suspense
  if (pendingBranch) {
    // 在Suspense的异步任务没有返回结果之前就更新Suspense
    // 更新的可能是pendingBranch 也可能是#fallback中的内容
    // 先进行更新#default
    suspense.pendingBranch = newBranch
    if (isSameVNodeType(newBranch, pendingBranch)) {
      // same root type but content may have changed.
      // 相同的根类型，但内容可能已更改。(也就是已经开始解析了)
      // 但是由于render或effect尚未执行或设置 只需要更新props和slots
      patch(
        pendingBranch,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      // 如果在更新完 没有异步的dep Suspense直接进入结束阶段
      // 如果还是在#fallback阶段 开始更新#fallback的更新 并将新的#fallback设置activeBranch
      if (suspense.deps <= 0) {
        suspense.resolve()
      } else if (isInFallback) {
        patch(
          activeBranch,
          newFallback,
          container,
          anchor,
          parentComponent,
          null, // fallback tree will not have suspense context fallback里不会有Suspense内容
          isSVG,
          slotScopeIds,
          optimized
        )
        setActiveBranch(suspense, newFallback)
      }
    } else {
      // toggled before pending tree is resolved
      // 在异步任务进入resolve阶段之前更新 替换整个pending tree
      // 增量pendingid。这用于使异步回调无效并重置挂起状态
      suspense.pendingId++
      if (isHydrating) {
        // if toggled before hydration is finished, the current DOM tree is
        // no longer valid. set it as the active branch so it will be unmounted
        // when resolved
        // 如果在服务端渲染完成之前更新 则说明当前DOM树不在有效 设置为activeBranch 方便以后resolve阶段卸载
        suspense.isHydrating = false
        suspense.activeBranch = pendingBranch
      } else {
        // 不是SSR 直接将已经挂载的DOM树卸载
        unmount(pendingBranch, parentComponent, suspense)
      }
      // increment pending ID. this is used to invalidate async callbacks
      // reset suspense state
      // 重置suspense状态
      suspense.deps = 0
      // discard effects from pending branch
      // 放弃旧的的pendingBranch的一切effect
      suspense.effects.length = 0
      // discard previous container
      // 放弃旧的容器
      suspense.hiddenContainer = createElement('div')

      if (isInFallback) {
        // already in fallback state
        // 处于#fallback阶段 先对#default进行解析
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        // 没有产生异步dep Suspense进入结束阶段
        // 产生了异步dep 为了防止没有东西回来 开始解析#fallback的内容
        if (suspense.deps <= 0) {
          suspense.resolve()
        } else {
          patch(
            activeBranch,
            newFallback,
            container,
            anchor,
            parentComponent,
            null, // fallback tree will not have suspense context
            isSVG,
            slotScopeIds,
            optimized
          )
          setActiveBranch(suspense, newFallback)
        }
      } else if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
        // toggled "back" to current active branch
        // pendingBranch已经挂载完毕了 变成了activeBranch 进行更新
        patch(
          activeBranch,
          newBranch,
          container,
          anchor,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        // force resolve
        // 已经挂载完毕了，已经存在了进入过渡，不需要再次解析进入过渡
        suspense.resolve(true)
      } else {
        // switched to a 3rd branch
        // 在上一个第二分支进入resolve之前切换到第三分支 则重新开始解析#default
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        // 没有产生异步的dep Suspense进入结束状态
        if (suspense.deps <= 0) {
          suspense.resolve()
        }
      }
    }
  } else {
    // 在#default执行完resolve之后 
    if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
      // root did not change, just normal patch
      // 更新#default 再把新的branch设置为activeBranch
      // 没有将整个#default直接更新 知识更新其内部 也就是简单的 patch 更新
      patch(
        activeBranch,
        newBranch,
        container,
        anchor,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      setActiveBranch(suspense, newBranch)
    } else {
      // 直接将整个#default换成新的#default 需要从头开始解析新的#default
      // 且如果符合条件 也是会重新去加载#fallback里的内容
      // root node toggled
      // invoke @pending event
      // 触发钩子函数函数 onPenging
      triggerEvent(n2, 'onPending')
      // mount pending branch in off-dom container
      // 重新设定pendingBranch
      suspense.pendingBranch = newBranch
      suspense.pendingId++
      // 开始解析新的#default
      patch(
        null,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      // 在解析的过程中 如果没有产生异步的dep 那么当前Suspense直接进入结束阶段
      if (suspense.deps <= 0) {
        // incoming branch has no async deps, resolve now.
        suspense.resolve()
      } else {
        // 符合条件就会加载#fallback
        // 最长加载时间(timeout)大于0 就会在大于timeout的时候去加载#fallback
        // 前提是在等待加载的过程中pendingBranch不会变化
        const { timeout, pendingId } = suspense
        if (timeout > 0) {
          setTimeout(() => {
            if (suspense.pendingId === pendingId) {
              suspense.fallback(newFallback)
            }
          }, timeout)
        } else if (timeout === 0) {
          // 最长加载时间(timeout)为0 直接开始挂载#fallback
          suspense.fallback(newFallback)
        }
      }
    }
  }
}

export interface SuspenseBoundary {
  vnode: VNode<RendererNode, RendererElement, SuspenseProps>
  parent: SuspenseBoundary | null
  parentComponent: ComponentInternalInstance | null
  isSVG: boolean
  container: RendererElement
  hiddenContainer: RendererElement
  anchor: RendererNode | null
  activeBranch: VNode | null
  pendingBranch: VNode | null
  deps: number
  pendingId: number
  timeout: number
  isInFallback: boolean
  isHydrating: boolean
  isUnmounted: boolean
  effects: Function[]
  resolve(force?: boolean): void
  fallback(fallbackVNode: VNode): void
  move(
    container: RendererElement,
    anchor: RendererNode | null,
    type: MoveType
  ): void
  next(): RendererNode | null
  registerDep(
    instance: ComponentInternalInstance,
    setupRenderEffect: SetupRenderEffectFn
  ): void
  unmount(parentSuspense: SuspenseBoundary | null, doRemove?: boolean): void
}

let hasWarned = false

// 创建Susoense边界
function createSuspenseBoundary(
  vnode: VNode,
  parent: SuspenseBoundary | null,
  parentComponent: ComponentInternalInstance | null,
  container: RendererElement,
  hiddenContainer: RendererElement,
  anchor: RendererNode | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  isHydrating = false
): SuspenseBoundary {
  /* istanbul ignore if */
  // Suspense 是一个还在测试的API 可能还会改变 请不要在生产环境环境中使用
  // hasWarned 是否已经提示过这是一个测试API
  if (__DEV__ && !__TEST__ && !hasWarned) {
    hasWarned = true
    // @ts-ignore `console.info` cannot be null error
    console[console.info ? 'info' : 'log'](
      `<Suspense> is an experimental feature and its API will likely change.`
    )
  }

  // 从渲染器传递的特定于平台的实现
  const {
    p: patch,
    m: move,
    um: unmount,
    n: next,
    o: { parentNode, remove }
  } = rendererInternals

  // 外界可以设置多长时间超时 如果没有设置在后面默认是-1
  const timeout = toNumber(vnode.props && vnode.props.timeout)
  const suspense: SuspenseBoundary = {
    vnode,
    parent,
    parentComponent,
    isSVG,
    container, // 最先显示的容器
    hiddenContainer, // 正在请求内容的容器 但是由于可能会请求失败 也许不会显示
    anchor, // 内容的兄弟节点
    deps: 0,
    pendingId: 0,
    timeout: typeof timeout === 'number' ? timeout : -1,
    activeBranch: null,
    pendingBranch: null,
    isInFallback: true,
    isHydrating,
    isUnmounted: false,
    effects: [],

    // 下面的是一系列操作方法
    resolve(resume = false) {
      if (__DEV__) {
        if (!resume && !suspense.pendingBranch) {
          throw new Error(
            `suspense.resolve() is called without a pending branch.`
          )
        }
        if (suspense.isUnmounted) {
          throw new Error(
            `suspense.resolve() is called on an already unmounted suspense boundary.`
          )
        }
      }
      const {
        vnode,
        // activeBranch是#fallback中的内容
        activeBranch,
        // pendingBranch是#default中的内容
        pendingBranch,
        pendingId,
        effects,
        parentComponent,
        container
      } = suspense

      if (suspense.isHydrating) {
        // 服务器渲染在前面已经处理过了，这里将其关闭
        suspense.isHydrating = false
      } else if (!resume) {
        // 如果pendingBranch存在进入过渡 那么activeBranch就会有一个离开过渡
        // 在renderer.ts 的move会被执行
        const delayEnter =
          activeBranch &&
          pendingBranch!.transition &&
          pendingBranch!.transition.mode === 'out-in'
        if (delayEnter) {
          activeBranch!.transition!.afterLeave = () => {
            if (pendingId === suspense.pendingId) {
              move(pendingBranch!, container, anchor, MoveType.ENTER)
            }
          }
        }
        // this is initial anchor on mount
        // 这是初始化时的定位瞄
        let { anchor } = suspense
        // 如果activeBranch存在，需要卸载#fallback 这玩意没用了 因为要开始挂载#default中的内容了
        // unmount current active tree
        if (activeBranch) {
          // if the fallback tree was mounted, it may have been moved
          // as part of a parent suspense. get the latest anchor for insertion
          // 如果#fallback已经挂载 但是可能会作为parent Suspense的一部分移动，
          // 所以这里再进行挂载#default进行重新确定插入的位置(确认之前插入的瞄点)
          anchor = next(activeBranch)
          // 卸载完毕#fallback的过程中会执行#fallback身上的afterLeave方法 进行离开过渡
          unmount(activeBranch, parentComponent, suspense, true)
        }
        if (!delayEnter) {
          // 没有进入过渡，直接进行挂载
          // move content from off-dom container to actual container
          move(pendingBranch!, container, anchor, MoveType.ENTER)
        }
      }

      // 重新设置activeBranch 然后将其他属性恢复初始值
      setActiveBranch(suspense, pendingBranch!)
      suspense.pendingBranch = null
      suspense.isInFallback = false

      // flush buffered effects
      // check if there is a pending parent suspense
      // Suspense 会有嵌套的情况 一直往外找
      let parent = suspense.parent
      let hasUnresolvedAncestor = false
      while (parent) {
        if (parent.pendingBranch) {
          // found a pending parent suspense, merge buffered post jobs
          // into that parent
          // 找到一个挂起的父Suspense，将等待的异步任务合并到该父项中
          // 如果没找到重新赋值parent 找parent的parent 直到找到最外层
          parent.effects.push(...effects)
          hasUnresolvedAncestor = true
          break
        }
        parent = parent.parent
      }
      // no pending parent suspense, flush all jobs
      // 如果没有parent Suspense 开始执行所有的异步任务
      if (!hasUnresolvedAncestor) {
        queuePostFlushCb(effects)
      }
      suspense.effects = []

      // 钩子函数 onResolve
      // invoke @resolve event
      triggerEvent(vnode, 'onResolve')
    },

    // 重新加载#fallback
    fallback(fallbackVNode) {
      // 如果suspense没有挂起pendingBranch 说明没有新的异步任务需要加载 所以不需要重新加载#fallback
      if (!suspense.pendingBranch) {
        return
      }

      const { vnode, activeBranch, parentComponent, container, isSVG } =
        suspense

      // invoke @fallback event
      // suspense钩子函数 onFallback
      triggerEvent(vnode, 'onFallback')

      // 外界可能更新 需要重新定位瞄点 mountFallback是挂载的主要函数
      const anchor = next(activeBranch!)
      const mountFallback = () => {
        // 只有在isInFallback=true也就是进入的InFallback阶段才会挂载#fallback
        if (!suspense.isInFallback) {
          return
        }
        // mount the fallback tree
        patch(
          null,
          fallbackVNode,
          container,
          anchor,
          parentComponent,
          null, // fallback tree will not have suspense context
          isSVG,
          slotScopeIds,
          optimized
        )
        setActiveBranch(suspense, fallbackVNode)
      }

      // 过渡：离开过渡 在进行unmount的时候就会执行 在删除当前activeBranch之后会执行mountFallback
      const delayEnter =
        fallbackVNode.transition && fallbackVNode.transition.mode === 'out-in'
      if (delayEnter) {
        activeBranch!.transition!.afterLeave = mountFallback
      }
      suspense.isInFallback = true

      // unmount current active branch
      // 删除当前activeBranch(已经挂载到页面上的)
      unmount(
        activeBranch!,
        parentComponent,
        null, // no suspense so unmount hooks fire now
        true // shouldRemove
      )

      // 如果没有过渡 在unmount之中不会去执行过渡 也就不会执行mountFallback 所以这里需要去调用去挂载#fallback
      if (!delayEnter) {
        mountFallback()
      }
    },

    // 将suspense的activeBranch移动到指定的container中
    // 前提是activeBranch存在，且到最后会更新suspense身上的container
    move(container, anchor, type) {
      suspense.activeBranch &&
        move(suspense.activeBranch, container, anchor, type)
      suspense.container = container
    },

    // 确认activeBranch的兄弟 确认瞄点
    next() {
      return suspense.activeBranch && next(suspense.activeBranch)
    },

    // 注册suspense产生的异步dep
    registerDep(instance, setupRenderEffect) {
      // 在执行当前组件时 如果setup内部存在异步操作 就会执行这个
      // instance 是当前组件实例 setupRenderEffect是安装渲染依赖的函数
      // 是否存在未完成的pendingBranch 有dep+1
      const isInPendingSuspense = !!suspense.pendingBranch
      if (isInPendingSuspense) {
        suspense.deps++
      }
      const hydratedEl = instance.vnode.el
      instance
        .asyncDep!.catch(err => {
          handleError(err, instance, ErrorCodes.SETUP_FUNCTION)
        })
        .then(asyncSetupResult => {
          // retry when the setup() promise resolves.
          // component may have been unmounted before resolve.
          // 不知道返回的Promise什么时候返回结果 但是在返回的时候可能组件已经被卸载
          // 如果已经被卸载或者是Suspense被卸载以及如果不是等待的异步和处理的异步不是同一个
          /// 直接结束当前的Pormise解析
          if (
            instance.isUnmounted ||
            suspense.isUnmounted ||
            suspense.pendingId !== instance.suspenseId
          ) {
            return
          }
          // retry from this component
          // 组件重试从这里开始
          // 标记开始异步解析
          instance.asyncResolved = true
          const { vnode } = instance
          if (__DEV__) {
            pushWarningContext(vnode)
          }
          // setup返回结果处理 和普通组件差不多 一样的处理v2的兼容
          handleSetupResult(instance, asyncSetupResult, false)
          if (hydratedEl) {
            // vnode may have been replaced if an update happened before the
            // async dep is resolved.
            // 如果在解析异步dep之前发生更新，则vnode可能已被替换
            vnode.el = hydratedEl
          }
          // 占位符
          const placeholder = !hydratedEl && instance.subTree.el
          // 处理异步返回产生的依赖
          setupRenderEffect(
            instance,
            vnode,
            // component may have been moved before resolve.
            // if this is not a hydration, instance.subTree will be the comment
            // placeholder.
            parentNode(hydratedEl || instance.subTree.el!)!,
            // anchor will not be used if this is hydration, so only need to
            // consider the comment placeholder case.
            hydratedEl ? null : next(instance.subTree),
            suspense,
            isSVG,
            optimized
          )
          // 移除占位符
          if (placeholder) {
            remove(placeholder)
          }
          // 高阶组件 确认el
          updateHOCHostEl(instance, vnode.el)
          if (__DEV__) {
            popWarningContext()
          }
          // Suspense的异步任务中嵌套了其他异步任务 到这里 每减少一个deps 代表一个异步任务结束
          // 只有到了最后一个异步任务Suspense才会进入resolve
          // only decrease deps count if suspense is not already resolved
          if (isInPendingSuspense && --suspense.deps === 0) {
            suspense.resolve()
          }
        })
    },

    // 卸载suspense 需要卸载两个东西 activeBranch 和 pendingBranch
    unmount(parentSuspense, doRemove) {
      suspense.isUnmounted = true
      if (suspense.activeBranch) {
        unmount(
          suspense.activeBranch,
          parentComponent,
          parentSuspense,
          doRemove
        )
      }
      if (suspense.pendingBranch) {
        unmount(
          suspense.pendingBranch,
          parentComponent,
          parentSuspense,
          doRemove
        )
      }
    }
  }

  return suspense
}

function hydrateSuspense(
  node: Node,
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  hydrateNode: (
    node: Node,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  /* eslint-disable no-restricted-globals */
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    node.parentNode!,
    document.createElement('div'),
    null,
    isSVG,
    slotScopeIds,
    optimized,
    rendererInternals,
    true /* hydrating */
  ))
  // there are two possible scenarios for server-rendered suspense:
  // - success: ssr content should be fully resolved
  // - failure: ssr content should be the fallback branch.
  // however, on the client we don't really know if it has failed or not
  // attempt to hydrate the DOM assuming it has succeeded, but we still
  // need to construct a suspense boundary first
  const result = hydrateNode(
    node,
    (suspense.pendingBranch = vnode.ssContent!),
    parentComponent,
    suspense,
    slotScopeIds,
    optimized
  )
  if (suspense.deps === 0) {
    suspense.resolve()
  }
  return result
  /* eslint-enable no-restricted-globals */
}

function normalizeSuspenseChildren(vnode: VNode) {
  const { shapeFlag, children } = vnode
  const isSlotChildren = shapeFlag & ShapeFlags.SLOTS_CHILDREN
  vnode.ssContent = normalizeSuspenseSlot(
    isSlotChildren ? (children as Slots).default : children
  )
  vnode.ssFallback = isSlotChildren
    ? normalizeSuspenseSlot((children as Slots).fallback)
    : createVNode(Comment)
}

function normalizeSuspenseSlot(s: any) {
  let block: VNode[] | null | undefined
  if (isFunction(s)) {
    const trackBlock = isBlockTreeEnabled && s._c
    if (trackBlock) {
      // disableTracking: false
      // allow block tracking for compiled slots
      // (see ./componentRenderContext.ts)
      s._d = false
      openBlock()
    }
    s = s()
    if (trackBlock) {
      s._d = true
      block = currentBlock
      closeBlock()
    }
  }
  if (isArray(s)) {
    const singleChild = filterSingleRoot(s)
    if (__DEV__ && !singleChild) {
      warn(`<Suspense> slots expect a single root node.`)
    }
    s = singleChild
  }
  s = normalizeVNode(s)
  if (block && !s.dynamicChildren) {
    s.dynamicChildren = block.filter(c => c !== s)
  }
  return s
}

export function queueEffectWithSuspense(
  fn: Function | Function[],
  suspense: SuspenseBoundary | null
): void {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn)
    } else {
      suspense.effects.push(fn)
    }
  } else {
    queuePostFlushCb(fn)
  }
}

function setActiveBranch(suspense: SuspenseBoundary, branch: VNode) {
  suspense.activeBranch = branch
  const { vnode, parentComponent } = suspense
  const el = (vnode.el = branch.el)
  // in case suspense is the root node of a component,
  // recursively update the HOC el
  if (parentComponent && parentComponent.subTree === vnode) {
    parentComponent.vnode.el = el
    updateHOCHostEl(parentComponent, el)
  }
}
