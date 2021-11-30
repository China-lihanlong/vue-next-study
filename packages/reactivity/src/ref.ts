import { isTracking, trackEffects, triggerEffects } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged } from '@vue/shared'
import { isProxy, toRaw, isReactive, toReactive } from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { CollectionTypes } from './collectionHandlers'
import { createDep, Dep } from './dep'

declare const RefSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
  /**
   * @internal
   */
  _shallow?: boolean
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

// ref收集依赖的入口
export function trackRefValue(ref: RefBase<any>) {
  // 先进行处理 只有应该去追踪才会去收集这个依赖
  // 可能收集依赖的过程中会产生其他依赖
  // 就不会出现之前，收集依赖之前需要清除一遍依赖 提高了性能
  if (isTracking()) {
    // 拿到原始的ref
    ref = toRaw(ref)
    // 如果ref本身没有dep 初始化dep
    if (!ref.dep) {
      ref.dep = createDep()
    }
    if (__DEV__) {
      trackEffects(ref.dep, {
        target: ref,
        type: TrackOpTypes.GET,
        key: 'value'
      })
    } else {
      trackEffects(ref.dep)
    }
  }
}

// 派发更新的入口
export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  // 拿到原始的ref
  ref = toRaw(ref)
  // 只有依赖存在 才会去派发更新，
  if (ref.dep) {
    if (__DEV__) {
      triggerEffects(ref.dep, {
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: newVal
      })
    } else {
      triggerEffects(ref.dep)
    }
  }
}

// 判断值是否为ref(值身上有__v_isRef属性)
export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
export function isRef(r: any): r is Ref {
  return Boolean(r && r.__v_isRef === true)
}

export function ref<T extends object>(
  value: T
): [T] extends [Ref] ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }

export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : ShallowRef<T>
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

// 创建一个ref 所有和ref相关的API都是调用这个
function createRef(rawValue: unknown, shallow: boolean) {
  if (isRef(rawValue)) {
    return rawValue
  }
  return new RefImpl(rawValue, shallow)
}

// 这个类本身可以看作是一个容器 但是只会存储一个值
// 一个容器一个值 有存取描述符作为获取和修改的入口 且方便拦截
class RefImpl<T> {
  private _value: T
  private _rawValue: T

  public dep?: Dep = undefined
  public readonly __v_isRef = true

  constructor(value: T, public readonly _shallow: boolean) {
    this._rawValue = _shallow ? value : toRaw(value)
    this._value = _shallow ? value : toReactive(value)
  }

  // 使用存取描述符对数据进行拦截 
  // 在每次获取或修改的时候 触发trackRefValue或者triggerRefValue
  get value() {
    trackRefValue(this)
    return this._value
  }

  set value(newVal) {
    newVal = this._shallow ? newVal : toRaw(newVal)
    if (hasChanged(newVal, this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : toReactive(newVal)
      triggerRefValue(this, newVal)
    }
  }
}

// 手动将一个执行与ref相关的副作用
export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

// 如果是ref 返回原始数据 否则返回参数本身
export function unref<T>(ref: T | Ref<T>): T {
  return isRef(ref) ? (ref.value as any) : ref
}

// 数据对象拦截处理方法
const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}

// 在setup执行完毕 返回一个数据对象 通过这个方法进行响应式处理 拦截它的访问修改
export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

// 自定义ref的容器 需要提供get和set方法 
// 而容器内部会提供track和trigger方法 进行依赖收集和派发更新
type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    // get 和 set 是用户自定义 并将依赖收集和依赖触发函数传递过去
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    // 存储自定义 get 和 set
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

// 自定义Ref
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}
// 将一个reactive对象转换为由多个ref组成的结构(reactive是啥结构转换出来的就是啥结构)
export function toRefs<T extends object>(object: T): ToRefs<T> {
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  // 根据源数据对象生成一个对应的新数据对象
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    // 用每一个key产生ref 在存入产生的数据对象中
    ret[key] = toRef(object, key)
  }
  // 最后将存有所有的key转换后的数据对象返回
  return ret
}

// toRef 将一个reactive上的某一个key和对应的value转换成ref
// 而toRefs就是通过该函数 循环reactive对象 拿到所有的key和起对应的value转换成ref
class ObjectRefImpl<T extends object, K extends keyof T> {
  // __v_isRef 为true 作为ref对象的标识
  public readonly __v_isRef = true

  // 存储对象 存储key
  constructor(private readonly _object: T, private readonly _key: K) {}

  // 获取和修改都是在对象上操作 ref对象本身不会存储值
  get value() {
    return this._object[this._key]
  }

  set value(newVal) {
    this._object[this._key] = newVal
  }
}

export type ToRef<T> = [T] extends [Ref] ? T : Ref<T>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]> {
  // 是ref对象 返回 不是就实例化
  const val = object[key]
  return isRef(val) ? val : (new ObjectRefImpl(object, key) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 *
 * Note that api-extractor somehow refuses to include `declare module`
 * augmentations in its generated d.ts, so we have to manually append them
 * to the final generated d.ts in our build process.
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V
    : // if `V` is `unknown` that means it does not extend `Ref` and is undefined
    T[K] extends Ref<infer V> | undefined
    ? unknown extends V
      ? undefined
      : V | undefined
    : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  ? T
  : T extends Array<any>
  ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
  : T extends object & { [ShallowReactiveMarker]?: never }
  ? {
      [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
    }
  : T
