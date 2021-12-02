import { Dep } from './dep'
import { ReactiveEffect } from './effect'
import { ComputedGetter, ComputedRef } from './computed'
import { ReactiveFlags, toRaw } from './reactive'
import { trackRefValue, triggerRefValue } from './ref'

const tick = Promise.resolve()
const queue: any[] = []
let queued = false

const scheduler = (fn: any) => {
  queue.push(fn)
  if (!queued) {
    queued = true
    tick.then(flush)
  }
}

const flush = () => {
  for (let i = 0; i < queue.length; i++) {
    queue[i]()
  }
  queue.length = 0
  queued = false
}

class DeferredComputedRefImpl<T> {
  // computed 依赖存储的位置
  public dep?: Dep = undefined

  // 计算属性缓存的值
  private _value!: T
  // 这个计算属性是否有缓存 防止多次触发
  private _dirty = true
  // 属于这个计算属性的getter的副作用
  public readonly effect: ReactiveEffect<T>

  // 计算属性是一个可以计算的ref
  public readonly __v_isRef = true
  // 标记这个计算属性是否为只读属性
  public readonly [ReactiveFlags.IS_READONLY] = true

  constructor(getter: ComputedGetter<T>) {
    // 比较对象
    let compareTarget: any
    // 比较对象是否存在
    let hasCompareTarget = false
    // 延迟执行？
    let scheduled = false
    // 产生计算属性的副作用
    this.effect = new ReactiveEffect(getter, (computedTrigger?: boolean) => {
      if (this.dep) {
        if (computedTrigger) {
          compareTarget = this._value
          hasCompareTarget = true
        } else if (!scheduled) {
          // 对比值
          const valueToCompare = hasCompareTarget ? compareTarget : this._value
          // 延迟执行！
          scheduled = true
          // 比较过后 值就是不是最新的了，比较对象就没有用了
          hasCompareTarget = false
          scheduler(() => {
            if (this.effect.active && this._get() !== valueToCompare) {
              triggerRefValue(this)
            }
            scheduled = false
          })
        }
        // chained upstream computeds are notified synchronously to ensure
        // value invalidation in case of sync access; normal effects are
        // deferred to be triggered in scheduler.
        for (const e of this.dep) {
          if (e.computed) {
            e.scheduler!(true /* computedTrigger */)
          }
        }
      }
      this._dirty = true
    })
    this.effect.computed = true
  }

  private _get() {
    if (this._dirty) {
      this._dirty = false
      return (this._value = this.effect.run()!)
    }
    return this._value
  }

  get value() {
    trackRefValue(this)
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    // 计算的属性可能会被其他东西代理 如 readonly 需要拿到原始数据
    return toRaw(this)._get()
  }
}

export function deferredComputed<T>(getter: () => T): ComputedRef<T> {
  return new DeferredComputedRefImpl(getter) as any
}
