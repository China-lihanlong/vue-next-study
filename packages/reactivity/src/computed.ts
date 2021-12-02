import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

// 类似ref 这个类生成的对象也是一个容器
// 但与ref不同的是 ref是直接可以拿到容器内部的值
// 而computed是需要用户自己去定义一个返回的数据
// 且内部有一个缓存 在数据没有发生改变时直接返回缓存中值
class ComputedRefImpl<T> {
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
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    // 产生一个effect
    this.effect = new ReactiveEffect(getter, () => {
      if (!this._dirty) {
        // 防止在链式调用computed的时候，后续的微任务多次触发triggerRefValue 
        this._dirty = true
        triggerRefValue(this)
      }
    })
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 从容器中拿出最新的值
  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    // 计算的属性可能会被其他东西代理 如 readonly 需要拿到原始数据
    const self = toRaw(this)
    // 在获取值的时候去收集依赖
    trackRefValue(self)
    if (self._dirty) {
      // 防止在链式调用computed的时候，后续的微任务多次去获取重新计算新值
      self._dirty = false
      self._value = self.effect.run()!
    }
    return self._value
  }

  // 调用用户传递进来set方法 如果用户没有传递 一般都是报警告
  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
) {
  // 存储位置
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    // 只带有getter 如果尝试修改提示警告
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    // 用户传递的 getter 和 setter
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // computed的核心是通过ComputedRefImpl 内部进行处理 返回一个可计算的ref
  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter)

  // 给开发人员一个调试computed的机会
  if (__DEV__ && debugOptions) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  // 最后返回
  return cRef as any
}
