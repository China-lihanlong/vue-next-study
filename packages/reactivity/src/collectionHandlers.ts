/**
 * 为什么要重写这些方法
 * 这Set和Map内部的实现原理有关，Set和Map内部数据都是通过this去访问的，被称为内存插槽，在直接通过接口去访问的时候，this指向的是Set, 通过代
 * 理对象去访问时，this指向就变成了proxy，
 */
import { toRaw, ReactiveFlags, toReactive, toReadonly } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { capitalize, hasOwn, hasChanged, toRawType, isMap } from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

  // 不深层次的响应式处理
const toShallow = <T extends unknown>(value: T): T => value

// 拿到方法的原型对象
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  // target可能是：只读代理对象 原始数据可能是一个可变代理对象 
  // 需要通过Reactive.Flags.RAW拿到只读代理对象原始数据(或许是可变代理对象) 之后在用toRaw获取一次
  target = (target as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  // 由于Map可以使用对象作为key 有可能会有代理对象作为key 这里拿到原始key
  const rawKey = toRaw(key)
  // 无论是否 key 和 rawKey是否相同 都去收集依赖
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)
  // 原始数据原型上的has方法
  const { has } = getProto(rawTarget)
  // 根据调用的响应式api的不同找到拿到不同的方法
  const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
  if (has.call(rawTarget, key)) {
    // key对应的值存在
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    // rawKey 值存在
    return wrap(target.get(rawKey))
  } else if (target !== rawTarget) {
    // #3602 readonly(reactive(Map))
    // ensure that the nested reactive `Map` can do tracking for itself
    // key 和 rawKey都不存在 且两个数据不一样(这样代表target是一个可变代理对象) 只能让代理对象自己追踪
    target.get(key)
  }
}

function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  // target可能是：只读代理对象 原始数据可能是一个可变代理对象 
  // 需要通过Reactive.Flags.RAW拿到只读代理对象原始数据(或许是可变代理对象) 之后在用toRaw获取一次
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  // 由于Map可以使用对象作为key 有可能会有代理对象作为key 这里拿到原始key
  const rawKey = toRaw(key)
  // 无论是否 key 和 rawKey是否相同 都去收集依赖
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
  // 根据key 和 rawKey 分别使用 key 和 rawKey在target 寻找
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}

function size(target: IterableCollections, isReadonly = false) {
  // target可能是：只读代理对象 原始数据可能是一个可变代理对象 
  // 需要通过Reactive.Flags.RAW拿到只读代理对象原始数据(或许是可变代理对象)
  target = (target as any)[ReactiveFlags.RAW]
  // 不是只读 就收集依赖
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  // 映射到原始对象上
  return Reflect.get(target, 'size', target)
}

// Set WeakSet 独有
function add(this: SetTypes, value: unknown) {
  // value 可能是 代理对象 拿到原始value
  value = toRaw(value)
  // target 是一个代理对象， 需要拿到原始数据
  const target = toRaw(this)
  // 获得原型，并使用has方法判断value 是否存在于target中
  const proto = getProto(target)
  const hadKey = proto.has.call(target, value)
// 不存在 则添加值，并且触发依赖 
  if (!hadKey) {
    target.add(value)
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  // 返回自己
  return this
}


// Map WeakMap独有
function set(this: MapTypes, key: unknown, value: unknown) {
  // value 可能是 代理对象 拿到原始value
  value = toRaw(value)
  // target 是一个代理对象， 需要拿到原始数据
  const target = toRaw(this)
  // 原型上的 has、get方法
  const { has, get } = getProto(target)

  // 判断值是否存在，后面用来判断是修改还是新增
  let hadKey = has.call(target, key)
  if (!hadKey) {
    // 不存在 获取原始key 重新在获取一次
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    // 存在 但是为了防止key和rawKey都存在与target 获取不准确 进行校验
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值
  const oldValue = get.call(target, key)
  target.set(key, value)
  // 存在是修改 不存在是新增 之后触发依赖
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return this
}

// 等同于DELETE
function deleteEntry(this: CollectionTypes, key: unknown) {
  // target 可能是一个代理对象 需要拿到原始数据
  const target = toRaw(this)
  // 原型上的 has、get方法
  const { has, get } = getProto(target)
  // 判断值是否存在
  let hadKey = has.call(target, key)
  if (!hadKey) {
    // 不存在 获取原始key 重新在获取一次
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    // 存在 但是为了防止key和rawKey都存在与target 获取不准确 进行校验
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值
  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = target.delete(key)
  // 只有要删除的值存在才会触发依赖 进行更新
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function clear(this: IterableCollections) {
  // target 可能是一个代理对象 需要拿到原始数据
  const target = toRaw(this)
  // 判断对象大小(类似数组的长度)
  const hadItems = target.size !== 0
  // 根据环境 判断是否要缓存旧值 给后面的 作为参数传递给 onTrigger
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  // 先执行清楚操作 之后再触发依赖 更新进入队列
  const result = target.clear()
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

// 给每一个响应式API创建一个遍历拦截处理方法
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    // 存储代理对象 拿到代理之前的数据 拿到原始数据
    const observed = this as any
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    // 根据条件 warp 返回对应的方法 例如 如果是 reactive 返回的就是 toReactive
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      // 为了更好的遍历 由内部调用外界进来函数，并且数据是只读或者是响应式的
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}


// 迭代器需要实现的接口
// 实现一个迭代器 返回值满足 Iterator
interface Iterable {
  [Symbol.iterator](): Iterator
}

// 实现一个迭代方法 返回值满足 IterationResult
interface Iterator {
  next(value?: any): IterationResult
}

// 用来限制next迭代方法
interface IterationResult {
  value: any
  done: boolean
}

// 创建迭代器方法
function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    // target可能是：只读代理对象 原始数据可能是一个可变代理对象 
    // 需要通过Reactive.Flags.RAW拿到只读代理对象原始数据(或许是可变代理对象)
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    // 目标是Map类型吗
    const targetIsMap = isMap(rawTarget)
    // Set是没有entries方法，这是Map的迭代方法  只有Map去调用，isPair为true
    // 每一次迭代返回的结构是 [key value] 形式的数组
    // 后面的(method === Symbol.iterator && targetIsMap) 是因为Symbol.iterator调用的方法是entries
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
      // Set是没有keys方法的，这是Map的迭代方法，
    const isKeyOnly = method === 'keys' && targetIsMap
    // 执行原生的迭代方法 keys values entries
    const innerIterator = target[method](...args)
    // 根据条件 warp 返回对应的方法 例如 如果是 reactive 返回的就是 toReactive
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 不是只读 收集依赖
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    // 返回一个包转过的迭代器 这个迭代器的返回值都是由默认迭代器返回
    return {
      // iterator protocol
      next() {
        // 去除重要的两个值 当前迭代的值、是否迭代完成
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
            // 如果是有一对 返回的数组中 索引0是key 索引1是value 不是代表是Set和WeakSet 就只有值
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol 返回迭代对象本身
      // 自定义迭代器 返回自己迭代对象自己本身
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

// 创建集合类型的只读方法
function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

// 根据需求 生成对应拦截方法
function createInstrumentations() {
  const mutableInstrumentations: Record<string, Function> = {
    // this 即是调用get的对象，现实情况就是Proxy代理对象
    get(this: MapTypes, key: unknown) {
      return get(this, key)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
  }

  const shallowInstrumentations: Record<string, Function> = {
    // this 即是调用get的对象，现实情况就是Proxy代理对象
    get(this: MapTypes, key: unknown) {
      return get(this, key, false, true)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
  }

  const readonlyInstrumentations: Record<string, Function> = {
    // this 即是调用get的对象，现实情况就是Proxy代理对象
    get(this: MapTypes, key: unknown) {
      return get(this, key, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, false)
  }

  const shallowReadonlyInstrumentations: Record<string, Function> = {
    // this 即是调用get的对象，现实情况就是Proxy代理对象
    get(this: MapTypes, key: unknown) {
      return get(this, key, true, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, true)
  }

  // 添加拦截 'keys', 'values', 'entries', Symbol.iterator 的方法
  const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
  iteratorMethods.forEach(method => {
    mutableInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      false
    )
    readonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      false
    )
    shallowInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      true
    )
    shallowReadonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      true
    )
  })

  return [
    mutableInstrumentations,
    readonlyInstrumentations,
    shallowInstrumentations,
    shallowReadonlyInstrumentations
  ]
}

const [
  mutableInstrumentations,
  readonlyInstrumentations,
  shallowInstrumentations,
  shallowReadonlyInstrumentations
] = /* #__PURE__*/ createInstrumentations()

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 根据外界传递的属性判断使用什么拦截处理方法
  const instrumentations = shallow
    ? isReadonly
      ? shallowReadonlyInstrumentations
      : shallowInstrumentations
    : isReadonly
    ? readonlyInstrumentations
    : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    // 如果是 在 拦截处理方法中找到该方法 并且该方法存在与代理对象中 使用拦截处理方法
    // 不是 直接将代理对象传递进去
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, false)
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, true)
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(true, false)
}

export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*#__PURE__*/ createInstrumentationGetter(true, true)
  }

// 用于校验Map WeakMap集合中是否存在 key rawkey
function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
