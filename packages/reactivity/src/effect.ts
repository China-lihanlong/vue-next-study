import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()
/* 
targetMap的设计就是为了存储数据和effect之间的关系 具体结构如下
{
  target1: {
    key1: {
      effect1,
      effect2
      ...
    },
    key2: {

    }
    ...
  },
  target2: {
    
  }
  ...
}
并且因为使用WeakMap 浏览器会自动的帮我们把一些没有的用的垃圾回收

*/

// The number of effects currently being tracked recursively.
// 记录当前的层数
let effectTrackDepth = 0

// effect 归属标记
export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
// effect依赖嵌套最大层数 (注：嵌套就比如在一个依赖中带有其他依赖，如：computed中使用computed) 
// 最多支持30层 如果超出了这个范围 会进入清除模式
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 全局 effectStack “栈”
const effectStack: ReactiveEffect[] = []
// 当前激活的effect
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// 通过实例化ReactiveEffect可以产生一个effect，但是effect的所有东西需要用户自己控制
// 其他大部分的响应式api都是通过这个实现
export class ReactiveEffect<T = any> {
  active = true
  // 将当前的归属于当前effect的所有的dep存储于自己本身 方便以后直接读取
  deps: Dep[] = []

  // can be attached after creation
  // 记录是由computed产生的effect
  computed?: boolean
  // 允许嵌套依赖
  allowRecurse?: boolean
  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
     // fn就是数据变化之后需要执行的副作用函数
    public fn: () => T,
    // 有时候 fn并不是需要立即执行 而是由其他某些effect去触发 会先放入队列中 等待执行
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope | null
  ) {
    // 记录影响范围 存储于每一个组件的本身 属于EffectScope操作
    recordEffectScope(this, scope)
  }

  // 执行 effect的入口
  run() {
    if (!this.active) {
      return this.fn()
    }
    if (!effectStack.includes(this)) {
      try {
        // 将当前触发的 effect进入"栈区"
        effectStack.push((activeEffect = this))
        // 应该去追踪
        enableTracking()

        // 每嵌套一层就记录一层
        trackOpBit = 1 << ++effectTrackDepth

        // 如果嵌套的层数，没有超过最大限制，初始化Dep
        if (effectTrackDepth <= maxMarkerBits) {
          // 给dep打上标记 记录这个effect的dep全部是已经收集过的
          initDepMarkers(this)
        } else {
          // 超过就清楚当前 effect 的所有相关的dep 但是一般都不超过
          cleanupEffect(this)
        }
        // 按位运算优化追踪
        // 执行当前的 effect 的函数 但是这个函数可能会带有其他依赖
        // 这就形成了嵌套依赖，但是为了更好的区分依赖和收集依赖
        // trackOpBit(全局变量)就会作为当前依赖的唯一标记 
        // 而每一个新的 trackOpBit 都是与effectTrackDepth进行位运算之后产生 
        // 当有嵌套依赖执行run() trackOpBit就会和当前effectTrackDepth加一
        // 执行完毕之后会减一 但是如果还有嵌套会重复上一条 直到唱过最大限制maxMarkerBits
        return this.fn()
      } finally {
        if (effectTrackDepth <= maxMarkerBits) {
          // 如果执行完当前effect的函数之后没有嵌套依赖
          // 则会去“栈区”中找到当前的effect 清除 'w' 和 ‘n’ 标记
          finalizeDepMarkers(this)
        }

        // 将effectTrackDepth回归到之前的位置
        trackOpBit = 1 << --effectTrackDepth

        // 重置是否应该去追踪 并将当前的effect移出 "栈区"
        resetTracking()
        effectStack.pop()
        // 如果n是0 代表所有的effect全部都执行完了 activeEffect赋值为undefined
        // 如果不是 代表effect “栈区” 中还有effect 指向栈最后一个effect
        // 最后一个都是嵌套依赖执行上一个的effect
        const n = effectStack.length
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

// 清除依赖的所有dep中删除effect 清除effect的信息
function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

// 提供给用户方便实例化ReactiveEffect的方法 产生一个effect
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 如果fn已经是一个effect函数 重新指向原始函数
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建一个 wrapper _effect 是一个响应式的副作用函数
  const _effect = new ReactiveEffect(fn)
  if (options) {
    // 拷贝options中的属性到_effect中
    extend(_effect, options)
    // effectScope 相关处理逻辑 确认_effect的作用范围
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    // 没有配置或懒加载 立即执行
    _effect.run()
  }
  // 绑定 run 函数 作为 effect runner
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  // 在runner中保留_effect的引用
  runner.effect = _effect
  return runner
}

// 停止用户的自定义effect
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

// 表示全局是否应该追踪
let shouldTrack = true
// 全局 trackStack 栈区
const trackStack: boolean[] = []

// 对于是否追踪的三个函数
// 全局暂停追踪
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

// 全局可能(允许)追踪
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

// 恢复到 enableTracking() 或者是 pauseTracking()之前
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 在初始化渲染中 触发的get中会调用track
// 但是这里并不是直接收集依赖 而是进行一些处理 
// 产生信息 传递给核心逻辑
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果全局不允许收集依赖 结束
  if (!isTracking()) {
    return
  }
  // track是给reactive等响应式对象收集依赖 
  // 找到当前对象对应的depsMap 没有则创建并存储在targetMap上
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 找到当前修改的key对的dep 没有就初始化一个并存储在depsMap上
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = createDep()))
  }

  // 更新信息
  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined

  // 将dep和更新信息传递给核心逻辑 
  trackEffects(dep, eventInfo)
}

// 判断是否应该追踪
export function isTracking() {
  return shouldTrack && activeEffect !== undefined
}

// 收集依赖的核心逻辑
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      // 标记是新收集的依赖
      dep.n |= trackOpBit // set newly tracked
      // 获取这个依赖是否已经收集过
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode. cleanup 模式 
    shouldTrack = !dep.has(activeEffect!)
  }

  // 开始追踪依赖关系
  if (shouldTrack) {
    // 双向存储依赖
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      // 调用用户传递进来的onTrack方法
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          // 调试器事件额外信息
          debuggerEventExtraInfo
        )
      )
    }
  }
}

// 派发更新的入口 当开始执行这个函数代表着数据已经变化了 需要开始执行副作用的函数
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 找到当前对象对应的depsMap 没有找到 结束
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  // 不一定需要将所有的依赖执行，可能修改的数据不一定影响到全部 需要有一个空间存储需要执行的依赖
  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // 清除操作 执行所有的effect
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 只寻找索引大于length(说明是新增)相关的副作用函数
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 从依赖中找到key相关的
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 根据操作找出所有相关key在前面track中存储在depsMap中的迭代器
    // 普通的数据只会产生一个track 而对于数组等有长度的数据会产生两个track
    // 在删除或者添新增数据时，不仅内部的数据会发生的变化 而且长度也会发生变化
    // 在track阶段会执行两次
    // 只有在ADD的时候才会对数组的length进行单独处理, 而Set和DELETE是其他数据类型身上的方法数组上没有
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes 新索引添加到数组->长度更改
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  // 派发更新的基本信息
  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    // 两个可能是都是由同一个依赖发出的嵌套依赖(一个是数据变化，一个是长度变化)
    // 但是由于前面的优化 一次只有一个依赖存在 
    // 就算有多个副作用函数 也只能一个个执行
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    // 如果有多个，则需要用createDep包装 (加上 w n标记) 为了方便优化
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

// 派发更新的核心逻辑
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  // 无论如何都是数组 这样稳定
  for (const effect of isArray(dep) ? dep : [...dep]) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      // 存在调度函数就执行调度函数进入队列 不存在直接执行副作用函数本身
      // 这里调度函数一般都是在doWatch中产生(watch和watchEffect的核心逻辑都是在doWatch)
      // 调度函数只要作用在于可以把队列函数job丢入异步渲染队列
      // 在调用函数存在情况 fn函数就是doWatch包装过的getter函数 
      // 在其他情况一般都是组件的componentUpdateFn函数
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        effect.run()
      }
    }
  }
}
