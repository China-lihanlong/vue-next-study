import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

// 工具函数：`__proto__,__v_isRef,__isVue` 这三个属性不可变化
const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// 筛选出Symbol原型上的所有唯一属性 一共12个
const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter() // 可变数据的拦截代理get方法
const shallowGet = /*#__PURE__*/ createGetter(false, true) // 浅层次可变数据的拦截代理get方法
const readonlyGet = /*#__PURE__*/ createGetter(true) // 不可变数据的拦截代理方法
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true) // 浅层次的不可变数据的拦截代理方法

// 创建数组插桩 用于劫持数组的方法
const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 劫持数组的8个方法 includes indexOf, lastIndexOf push, pop, shift, unshift, splice
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  // 3个判断数组中是否存在某值的方法
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        // 收集依赖
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 使用传递进来的参数第一次运行方法 (参数可能是代理对象, 会找不到结果) 找到了结果 返回即可
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // 将代理对象转换成原始数据 并再一次运行 且返回
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 5个会修改数组本身的方法
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 在vue3.0版本 vue会对数组的push等方法进行依赖收集和触发 可能产生无限循环调用 这里让数组的push等方法不进行依赖的收集和触发
      /**
       * watachEffect(() => {
       *  arr.push(1)
       * })
       * 
       * watchEffect(() => {
       *  arr.push(2)
       * })
       */
      pauseTracking()
      // 执行数组原生上的方法 将结果返回
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    // reactive 对 readonly 进行了相关校验 readonly中反之
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (
      // 代理对象已经存在 返回即可
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)

    // key 如果是数组方法名称 且是进行过拦截处理的数组原生方法进行操作 arrayInstrumentations
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 映射到原始对象上
    const res = Reflect.get(target, key, receiver)

    // 如果是Symbol类型值 Symbol 无法修改 返回原数据 或者不是 `__proto__,__v_isRef,__isVue` 这三个也直接返回
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果是只读就不做依赖收集
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅响应 不会对值进行响应式处理
    if (shallow) {
      return res
    }

    // 如果值是数组、或者是带有数字为键的对象的ref对象，不能展开直接返回
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果获取值不是对象直接返回即可
    // 否则根据isReadonly返回响应式数据
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()// 可变数据的拦截set方法
const shallowSet = /*#__PURE__*/ createSetter(true) // 浅层次的可变数据的拦截set方法

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    // 获取旧的属性值
    let oldValue = (target as any)[key]
    // 只有不是浅层次 旧值是ref类型 新值不是 直接在旧值上修改
    if (!shallow && !isReadonly(value)) {
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // 在浅层模式下 不管是不是代理对象 都按默认设置
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 看看key值的存在于对象中？ 
    const hadKey =
    // 是数组 且 key是整数类型
      isArray(target) && isIntegerKey(key)
      // 数组索引不能大于数组的长度
        ? Number(key) < target.length
        // key值存在于存在对象？
        : hasOwn(target, key)
        // 映射的原始对象上
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // receiver 必须是target 的代理对象 才会触发 trigger
    // Receiver：最初被调用的对象。通常是 proxy 本身，但 handler 的 set 方法也有可能在原型链上或以其他方式被间接地调用（因此不一定是 proxy 本身）
    if (target === toRaw(receiver)) {
      // 存在旧值 修改 不存在 新增
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  // 判断key键是否存在 然后删除操作
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  // 只有key键存在 和删除成功了才会进行更新
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  // isSymbol不是唯一值 builtInSymbols 不是Symbol原型上的12个方法
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
