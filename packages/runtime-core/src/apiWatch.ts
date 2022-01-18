import {
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffect,
  isReactive,
  ReactiveFlags,
  EffectScheduler,
  DebuggerOptions
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : T[K] extends object
    ? Immediate extends true
      ? T[K] | undefined
      : T[K]
    : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync'
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// Post Simple effect.
export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'post' })
      : { flush: 'post' }) as WatchOptionsBase
  )
}

export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'sync' })
      : { flush: 'sync' }) as WatchOptionsBase
  )
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}

function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  const instance = currentInstance // 这是当前组件实例
  let getter: () => any  // 主要是用来获取数据(在获取数据过程中收集依赖)
  let forceTrigger = false // 标记不是立即触发
  let isMultiSource = false // 不是多源(多个数据)

  if (isRef(source)) {
    // 观察ref对象
    getter = () => source.value
    // ref 一般维护的都是简单值，但是也可以放入复杂值 如对象、Array、Map、Set
    // 如果只是浅层次的去观察、就不需要强制更新
    forceTrigger = !!source._shallow
  } else if (isReactive(source)) {
    // 观察reactive响应对象 reactive一般只允许复杂值 默认都是深度观察
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    // 数据源是array 则需要观察多个数据 标记为多源
    isMultiSource = true
    // 只要有一个是reactive对象 就强制更新
    forceTrigger = source.some(isReactive)
    // 对所有的数据进行递归遍历深度观察
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    // 如果数据源是个函数 一般有两种情况
    // watch调用：() => xxx
    // watchEffect调用: () => {code...}
    // 主要是看第二参数 cb 
    // 一般情况下很大概率只有watch传递的是函数，作为doWatch的第二参数传递
    // 而watchEffect传递的一般是配置项但是会将其作为doWatch第三参数传递 第二参数就默认传个null
    // 两个的执行一个是正常执行 一个是异步调用(但是会先执行一次)
    if (cb) {
      // getter with cb cb是一个函数 watch(() => count.value, () => {})
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect //cb不是函数 => watchEffect(() => {})
      getter = () => {
        if (instance && instance.isUnmounted) {
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate]
        )
      }
    }
  } else {
    // 啥也没传，没有监视id数据源 默认给一个函数
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 2.x array mutation watch compat // vue2 数组watch兼容
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        // 递归查找数据
        traverse(val)
      }
      return val
    }
  }

  if (cb && deep) {
    const baseGetter = getter
    // 深度观察时 会 traverse去递归遍历执行拿到数据
    getter = () => traverse(baseGetter())
  }

  // 注册一个函数进行清楚副作用 专门在副作用失效时，给用户手动清除副作用挂起的异步函数
  let cleanup: () => void
  let onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  // 服务端渲染无需有实际效果
  if (__SSR__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    // 不会调用invalidate回调（+未设置运行程序）
    onInvalidate = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        isMultiSource ? [] : undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  // 根据 isMultiSource 初始化观察默认值
  let oldValue = isMultiSource ? [] : INITIAL_WATCHER_VALUE
  // 在数据发生变成执行的副作用函数
  const job: SchedulerJob = () => {
    if (!effect.active) {
      return
    }
    // 主要根据doWatchs的第二参数cb进行判断
    // watch和watchEffect一个传递函数一个传递null
    if (cb) {
      // watch(source, cb)
      // 先获取更新之后最新的值 
      const newValue = effect.run()
      /* 
      条件成立有一个就成立：
      1. deep === true
      2. 值发生了变化 根据isMultiSource 判断值发生变化的方式也不一样(都是依靠hasChanged)
        1. 在多源的情况，通过some去调用hasChanged才知道是否有至少一个值发生了改变
        2. 在只有一个值的情况就直接去调用hasChanged得到值是否发生了改变
      3. 数据源是一个数组，且支持vue2兼容
      */
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) =>
              hasChanged(v, (oldValue as any[])[i])
            )
          : hasChanged(newValue, oldValue)) ||
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // cleanup before running cb again
        // 再次运行cb之前进行清理
        if (cleanup) {
          cleanup()
        }
        // 带错误处理的执行的watch回调函数
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // 第一次更改时，将未定义作为旧值传递
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect
      effect.run()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  // 限制只有watch才会去递归数据本身
  job.allowRecurse = !!cb

  // 产生一个调度函数 一共是三种执行情况
  // sync 同步执行 post 异步执行 pre 默认行为(组件没有挂载进入队列等待组件渲染完毕后在执行，组件存在同步执行 )
  // 最后会在triggerEffect执行
  let scheduler: EffectScheduler
  if (flush === 'sync') {
    // 一般watch和watchEffect都是异步去观察数据，但可以同步的执行
    scheduler = job as any // the scheduler function gets called directly
  } else if (flush === 'post') {
    // 将回调丢入异步渲染队列中，等待渲染完成才会执行
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre'
    // pre 是vue2watch的默认行为方式，如果组件存在，就同步执行
    // 如果组件不存在或者是没有挂载完毕，会将其丢入队列中，等待DOM渲染完毕之后，才会执行
    scheduler = () => {
      if (!instance || instance.isMounted) {
        // 如果组件不存在或者是组件还没有挂载完成 放入队列中 等待组件挂载完成之后执行
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  }

  // 实例化一个副作用响应式对象 等同于一个Watcher
  const effect = new ReactiveEffect(getter, scheduler)

  // 提供给开发者一个调试watch和watchEffect的机会
  if (__DEV__) {
    effect.onTrack = onTrack
    effect.onTrigger = onTrigger
  }

  // initial run // 初始化运行
  if (cb) {
    if (immediate) {
      // immediate立即执行 初始化之后默认执行一次
      job()
    } else {
      // 不是立即执行先获取旧值
      oldValue = effect.run()
    }
  } else if (flush === 'post') {
    // watchEffect 异步的执行 进入异步渲染队列，等待渲染完成后执行
    queuePostRenderEffect(
      effect.run.bind(effect),
      instance && instance.suspense
    )
  } else {
    effect.run() // watchEffect
  }

  // 返回卸载观察的函数
  return () => {
    effect.stop()
    if (instance && instance.scope) {
      remove(instance.scope.effects!, effect)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  // 拿到当前实例的代理对象
  const publicThis = this.proxy as any
  // 获取数据的方法 一共有三种情况
  // 1. 直接是数据名称的字符串
  // 2. 如果是函数 () => this.xxxx 进行bind之后返回一个新的函数 this指向代理对象
  // 3. 如果是xxx.xxx.xxx 多半是个对象 需要通过createPathGetter去获取数据
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  // 副作用函数
  let cb
  if (isFunction(value)) {
    // 如果是一个函数 可以直接使用
    cb = value
  } else {
    // 或者是一个配置对象 {handler() {}, deep: true}
    cb = value.handler as Function
    options = value
  }
  // 缓存之前的当前组件实例
  const cur = currentInstance
  // 将this设置为当前组件实例
  setCurrentInstance(this)
  // 执行doWatch实现watch具体可以看上面
  // 功能和watch类似
  const res = doWatch(getter, cb.bind(publicThis), options)
  // 恢复到之前的当前组件实例 如果之前的实例是null没有就是变成之前的模板
  if (cur) {
    setCurrentInstance(cur)
  } else {
    unsetCurrentInstance()
  }
  // 和watch一样把卸载观察的函数返回
  return res
}

export function createPathGetter(ctx: any, path: string) {
  // ctx是代理对象 path是数据的路径 如：xxx.aaa.ccc
  // { xxx: { aaa: { ccc: 10 } } }
  const segments = path.split('.')
  // 返回一个可以循环从代理对象中拿到数据
  return () => {
    let cur = ctx
    // 循环从代理对象中拿到数据
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}

// 最大作用是在有深层次数据，可以快速的去判断值是否有变化，或者值是否存在，
// 内部自己维护了一个缓存区`seen`任何更新获取操作都会在这里进行一次缓存，方便以后使用，很大的提升了性能
export function traverse(value: unknown, seen?: Set<unknown>) {
  // 如果是无需响应的对象 只需要返回自己本身
  if (!isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }
  seen = seen || new Set()
  // 如果在重复递归的过程中 值存在于 seen(缓存过值，如果有更新或者第一次获取，都会在缓存中放一份，提升性能) 中直接返回(这个值可能有多个观察者在使用它)
  if (seen.has(value)) {
    return value
  }
  seen.add(value)
  // 在以下的几种数据中需要进行递归 以进行深度查找数据 ref(ref维护的值也可以是深层次的) array Set Map 普通对象
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse((value as any)[key], seen)
    }
  }
  return value
}
