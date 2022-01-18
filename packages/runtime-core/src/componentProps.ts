import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend,
  isOn
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'
import { AppContext } from './apiCreateApp'
import { createPropsDefaultThis } from './compat/props'
import { isCompatEnabled, softAssertCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import { shouldSkipAttr } from './compat/attrsFallthrough'
import { IfAny } from './helpers/typeUtils'

export type ComponentPropsOptions<P = Data> =
  | ComponentObjectPropsOptions<P>
  | string[]

export type ComponentObjectPropsOptions<P = Data> = {
  [K in keyof P]: Prop<P[K]> | null
}

export type Prop<T, D = T> = PropOptions<T, D> | PropType<T>

type DefaultFactory<T> = (props: Data) => T | null | undefined

export interface PropOptions<T = any, D = T> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: D | DefaultFactory<D> | null | undefined | object
  validator?(value: unknown): boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new (...args: any[]): T & {} }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = [T] extends [
  ((...args: any) => any) | undefined
] // if is function with args, allowing non-required functions
  ? { new (): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T> = {
  [K in keyof T]: T[K] extends
    | { required: true }
    | { default: any }
    // don't mark Boolean props as undefined
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { default: undefined | (() => undefined) }
      ? never
      : K
    : never
}[keyof T]

type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>

type DefaultKeys<T> = {
  [K in keyof T]: T[K] extends
    | { default: any }
    // Boolean implicitly defaults to false
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { type: BooleanConstructor; required: true } // not default if Boolean is marked as required
      ? never
      : K
    : never
}[keyof T]

type InferPropType<T> = [T] extends [null]
  ? any // null & true would fail to infer
  : [T] extends [{ type: null | true }]
  ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
  : [T] extends [ObjectConstructor | { type: ObjectConstructor }]
  ? Record<string, any>
  : [T] extends [BooleanConstructor | { type: BooleanConstructor }]
  ? boolean
  : [T] extends [DateConstructor | { type: DateConstructor }]
  ? Date
  : [T] extends [(infer U)[] | { type: (infer U)[] }]
  ? U extends DateConstructor
    ? Date | InferPropType<U>
    : InferPropType<U>
  : [T] extends [Prop<infer V, infer D>]
  ? unknown extends V
    ? IfAny<V, V, D>
    : V
  : T

export type ExtractPropTypes<O> = O extends object
  ? { [K in keyof O]?: unknown } & // This is needed to keep the relation between the option prop and the props, allowing to use ctrl+click to navigate to the prop options. see: #3656
      { [K in RequiredKeys<O>]: InferPropType<O[K]> } &
      { [K in OptionalKeys<O>]?: InferPropType<O[K]> }
  : { [K in string]: any }

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

// extract props which defined with default from prop options
export type ExtractDefaultPropTypes<O> = O extends object
  ? { [K in DefaultKeys<O>]: InferPropType<O[K]> }
  : {}

type NormalizedProp =
  | null
  | (PropOptions & {
      [BooleanFlags.shouldCast]?: boolean
      [BooleanFlags.shouldCastTrue]?: boolean
    })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedProps = Record<string, NormalizedProp>
export type NormalizedPropsOptions = [NormalizedProps, string[]] | []

export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {
  // 创建两个空对象 将来用来存储props和attrs
  const props: Data = {}
  const attrs: Data = {}
  def(attrs, InternalObjectKey, 1)

  // propsDefaults 是 default是一个函数或者构造函数 执行返回的结果 
  // 为了缓存执行完成的结果 可以不需要每次都重新执行
  instance.propsDefaults = Object.create(null)

  // 处理并区分attrs和propps
  setFullProps(instance, rawProps, props, attrs)

  // propsOptions 是一个数组 第一个是所有的key的规则 第二个是需要转换值的key
  // ensure all declared prop keys are present
  // 确保用户声明的props都可以被访问 给一个undefined 不会报错
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = undefined
    }
  }

  // validation
  // props类型验证
  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }

  if (isStateful) {
    // stateful
    // 有状态组件 会将props挂在实例上 SSR模式下不会响应式处理
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    // 如果没有配置props 所有的props和attrs是共用的
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      instance.props = attrs
    } else {
      // 配置了 只能使用props中声明了的
      // functional w/ declared props
      instance.props = props
    }
  }
  // 将attrs汇总挂在实例上
  instance.attrs = attrs
}

// 在组件因为parent Component 而更新时
// 通过这个去更新props
export function updateProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  rawPrevProps: Data | null,
  optimized: boolean
) {
  // rawPorps 是当前的props的原始数据
  // rawPrevProps 是上次的props原始数据
  // 两个都包含props和attrs
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance
  const rawCurrentProps = toRaw(props)
  // options 是所有的传递的props的所有配置的规则
  const [options] = instance.propsOptions
  let hasAttrsChanged = false

  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    !(
      __DEV__ &&
      (instance.type.__hmrId ||
        (instance.parent && instance.parent.type.__hmrId))
    ) &&
    (optimized || patchFlag > 0) &&
    !(patchFlag & PatchFlags.FULL_PROPS)
  ) {
    if (patchFlag & PatchFlags.PROPS) {
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      // 如果props没有修改操作，只需要进行新增
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i]
        // PROPS flag guarantees rawProps to be non-null
        // PatchFlags.PROPS 保证rawProps一定存在
        const value = rawProps![key]
        // 如果没有写props选项 所有的key都会放在attrs中
        // 声明了props选项 那么传递的所有key只有声明的才会放在实例上的props中
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          // attr 和 props 的分离是在初始化的过程中
          // 这里只需要确保attr是否存在且值
          if (hasOwn(attrs, key)) {
            // 存在且值被修改 告诉外面有修改attr
            if (value !== attrs[key]) {
              attrs[key] = value
              hasAttrsChanged = true
            }
          } else {
            // 不属于 作为prop进行解析 且需要转换
            const camelizedKey = camelize(key)
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false /* isAbsent */
            )
          }
        } else {
          if (__COMPAT__) {
            if (isOn(key) && key.endsWith('Native')) {
              key = key.slice(0, -6) // remove Native postfix
            } else if (shouldSkipAttr(key, instance)) {
              continue
            }
          }
          if (value !== attrs[key]) {
            // 存在且值被修改 告诉外面有修改attr
            attrs[key] = value
            hasAttrsChanged = true
          }
        }
      }
    }
  } else {
    // full props update.
    // 元素绑定了动态的`key`属性 diff 全部的传递key
    // 执行setFullProps 可以将新的props和attrs放在实例上 顺便也可以确定attrs是否改变
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true
    }
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    // 在dynamicProps中确认是否存在动态props，验证是否要删除它
    let kebabKey: string
    for (const key in rawCurrentProps) {
      // 前面执行setFullPorps已经更新了新的数据 但是有一部分是旧的，新的数据没有存在
      // options是props配置项，存在 会把在新数据不存在的进行转换或者使用默认值，这些不存在的数据，都是默认它们缺席
      // 不存在options配置 这些不存在的一一删除
      if (
        !rawProps ||
        // for camelCase
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase props属性名不一定都是驼峰命名，也可能是有-命名 (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        if (options) {
          // key在新和旧都存在 需要更新值
          if (
            rawPrevProps &&
            // for camelCase
            (rawPrevProps[key] !== undefined ||
              // for kebab-case
              rawPrevProps[kebabKey!] !== undefined)
          ) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              undefined,
              instance,
              true /* isAbsent */
            )
          }
        } else {
          // 在新的中不存在 需要删除
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    // 如果组件没有配置props功能选项 实例上的attrs和props指向的是同一个对象 就应该已经被更新了
    // 但是如果了配置props 前面只会更新props 这里需要再去更新attr
    if (attrs !== rawCurrentProps) {
      // 移除不存在的旧的attr
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key)) {
          delete attrs[key]
          hasAttrsChanged = true
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  // 更新使用了$attrs的插槽
  if (hasAttrsChanged) {
    trigger(instance, TriggerOpTypes.SET, '$attrs')
  }

  // dev模式下 会多去检查一遍新的props是否符合类型
  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }
}

// 区分传入的key是prop还是attr 处理传递的值
function setFullProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  props: Data,
  attrs: Data
) {
  const [options, needCastKeys] = instance.propsOptions
  let hasAttrsChanged = false
  // prop的值需要转换 用于原始值存储
  let rawCastValues: Data | undefined
  if (rawProps) {
    for (let key in rawProps) {
      // key, ref are reserved and never passed down
      // key和ref不会向下传递 只会在当前组件使用
      if (isReservedProp(key)) {
        continue
      }

      // 兼容v2的实例 hookEvent 如：@hook:mounted
      if (__COMPAT__) {
        if (key.startsWith('onHook:')) {
          softAssertCompatEnabled(
            DeprecationTypes.INSTANCE_EVENT_HOOKS,
            instance,
            key.slice(2).toLowerCase()
          )
        }
        if (key === 'inline-template') {
          continue
        }
      }

      // rawProps 是props值的汇总
      const value = rawProps[key]
      // prop option names are camelized during normalization, so to support
      // kebab -> camel conversion here we need to camelize the key.
      let camelKey
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        // 不需要转换 驼峰化后直接放入props
        // 需要转换 不会直接放入 等待后面进行处理 先存储原始值
        if (!needCastKeys || !needCastKeys.includes(camelKey)) {
          props[camelKey] = value
        } else {
          ;(rawCastValues || (rawCastValues = {}))[camelKey] = value
        }
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        if (__COMPAT__) {
          if (isOn(key) && key.endsWith('Native')) {
            key = key.slice(0, -6) // remove Native postfix
          } else if (shouldSkipAttr(key, instance)) {
            continue
          }
        }
        // 如果不是 emit 派发的事件的key和没有被props选项声明的都会被认为是attr
        if (value !== attrs[key]) {
          attrs[key] = value
          hasAttrsChanged = true
        }
      }
    }
  }

  //  转换值
  if (needCastKeys) {
    const rawCurrentProps = toRaw(props)
    const castValues = rawCastValues || EMPTY_OBJ
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      props[key] = resolvePropValue(
        options!,
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      )
    }
  }

  return hasAttrsChanged
}

// 处理默认值和转换特殊情况的值
function resolvePropValue(
  options: NormalizedProps,
  props: Data,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance,
  isAbsent: boolean
) {
  const opt = options[key]
  // opt 是子组件接受prop时声明的props选项 里面对每一个prop都进行了配置
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // default 时prop配置项的default
    // 在声明了这个prop 但是没有传递值 且defult也存在值
    // default values
    if (hasDefault && value === undefined) {
      const defaultValue = opt.default
      if (opt.type !== Function && isFunction(defaultValue)) {
        // default可以一个函数或者构造函数
        const { propsDefaults } = instance
        // 从default函数执行的缓存结果寻找 可以减少default函数的调用
        if (key in propsDefaults) {
          value = propsDefaults[key]
        } else {
        // 执行default函数 但是为了在函数内部可以访问到当前实例 需要临时设置
        // 但是v3之后 生成默认值的工厂函数不能在访问this 而是组件接受到的prop作为参数传递给默认参数
        // inject API 可以在默认函数中使用。
          setCurrentInstance(instance)
          value = propsDefaults[key] = defaultValue.call(
            __COMPAT__ &&
              isCompatEnabled(DeprecationTypes.PROPS_DEFAULT_THIS, instance)
              ? createPropsDefaultThis(instance, props, key)
              : null,
            props
          )
          unsetCurrentInstance()
        }
      } else {
        // 如果default只是一个普通的值 直接设置即可
        value = defaultValue
      }
    }
    // boolean casting
    // 布尔型转换：如果类型检测允许Boolean通过
    // 进行布尔值转换 
    // 如果一个prop 缺少且没有有默认值 会自动转换成false
    // 如果没有缺少且有默认值 是空字符串或者prop的key的连字符格式字符串 转换成true
    if (opt[BooleanFlags.shouldCast]) {
      // type中含有Boolean就会进入
      if (isAbsent && !hasDefault) {
        value = false
      } else if (
        opt[BooleanFlags.shouldCastTrue] &&
        (value === '' || value === hyphenate(key))
      ) {
        // type中含有 Boolean String(可以没有) 且Boolean在String前面
        // booleanIndex < stringIndex || stringIndex < 0
        value = true
      }
    }
  }
  return value
}

// 标准化组件的props配置
export function normalizePropsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): NormalizedPropsOptions {
  // propsCache 是上下文中的所有组件的props标准化后配置的缓存
  // 如果里面存在当前组件的props标准化配置缓存 可以直接返回
  const cache = appContext.propsCache
  const cached = cache.get(comp)
  if (cached) {
    return cached
  }

  // props配置原始数据
  const raw = comp.props
  // 已经标准化完毕props的key的汇总
  const normalized: NormalizedPropsOptions[0] = {}
  // 后面需要进行转换的keys
  const needCastKeys: NormalizedPropsOptions[1] = []

  // apply mixin/extends props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    // 标准化组件的其他一些扩展配置 mixin和全局的mixin(组件混入)或者是extends(组件扩展) 
    // 但是某些key的优先级会低于组件本身的props
    // 优先级关系: 组件的props > 组件身上的mixin > 组件的extend > 全局的mixin
    const extendProps = (raw: ComponentOptions) => {
      if (__COMPAT__ && isFunction(raw)) {
        raw = raw.options
      }
      hasExtends = true
      const [props, keys] = normalizePropsOptions(raw, appContext, true)
      extend(normalized, props)
      if (keys) needCastKeys.push(...keys)
    }
    // 全局mixin
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps)
    }
    // 组件的extends
    if (comp.extends) {
      extendProps(comp.extends)
    }
    // 组件身上的mixins选项
    if (comp.mixins) {
      comp.mixins.forEach(extendProps)
    }
  }

  // 如果啥都没有 返回一个空数组
  if (!raw && !hasExtends) {
    cache.set(comp, EMPTY_ARR as any)
    return EMPTY_ARR as any
  }

  // 组件的 props配置项只可以写成数组形式或者是对象
  if (isArray(raw)) {
    // props是一个数组
    for (let i = 0; i < raw.length; i++) {
      // 如果写成数组，里面的每一项都要字符串类型
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      // props的key进行驼峰化(studentinfo => studentInfo)
      // 但是需要确保key不能以 $`开头 因为 `$key`可能是保留属性
      const normalizedKey = camelize(raw[i])
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  } else if (raw) {
    // props是一个对象
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        const opt = raw[key]
        // props是一个对象 那么里面的每一个prop的配置都需要转换成对象
        // prop的配置可以是只是一个构造函数函数或者数组 需要转换成{type: option}
        // 也可以是一个对象 可以直接使用
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : opt)
        if (prop) {
          // prop 中 类型检查type如果是一个数组
          // booleanIndex 是 Boolean() 是在这个数组的索引
          // stringIndex 是 String() 是在这个数组的索引
          // 如果不存在返回的就是-1
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          const stringIndex = getTypeIndex(String, prop.type)
          // 第一个需不需要Boolean转换
          // 第二个如果数组中带有Boolean 和 String 两种类型检测
          // 如果Boolean 在 String 前面 
          // 则传递的值如果是空字符串或者是prop名字连字符格式的字符串 后面都会转换成true
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          prop[BooleanFlags.shouldCastTrue] =
            stringIndex < 0 || booleanIndex < stringIndex
          // if the prop needs boolean casting or default value
          // prop没有传递值, 符合两种情况会进行转换
          // 1. 该prop类型检查允许Boolean通过(必须要)
          // 2. 该prop带有默认值，也就是有配置default(可以没有)
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }

  const res: NormalizedPropsOptions = [normalized, needCastKeys]
  cache.set(comp, res)
  return res
}

function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

// use function string name to check type constructors
// so that it works across vms / iframes.
// 分辨是那个构造函数
function getType(ctor: Prop<any>): string {
  // 将原生构造函数转换字符串 再用正则匹配出类型
  const match = ctor && ctor.toString().match(/^\s*function (\w+)/)
  return match ? match[1] : ctor === null ? 'null' : ''
}

// 判断两个数据是不是同一个类型
function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

// 找到类型再type配置项中那个位置
function getTypeIndex(
  type: Prop<any>,
  expectedTypes: PropType<any> | void | null | true
): number {
  if (isArray(expectedTypes)) {
    // type是一个数组 找到第一次出现的索引
    return expectedTypes.findIndex(t => isSameType(t, type))
  } else if (isFunction(expectedTypes)) {
    // type不是数组 如果不是返回-1 是返回0
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  return -1
}

/**
 * dev only
 */
function validateProps(
  rawProps: Data,
  props: Data,
  instance: ComponentInternalInstance
) {
  // 原始数据
  const resolvedValues = toRaw(props)
  // 原始props规则
  const options = instance.propsOptions[0]
  // 开始遍历确定数据和定义的规则是否匹配
  // 如果没有当前的key没有定义规则则会跳过
  for (const key in options) {
    // 每一个key定义的规则
    let opt = options[key]
    if (opt == null) continue
    validateProp(
      key,
      resolvedValues[key],
      opt,
      !hasOwn(rawProps, key) && !hasOwn(rawProps, hyphenate(key))
    )
  }
}

/**
 * dev only
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean
) {
  // type：当前key定义的类型检查 只能是规定的类型中的一种
  // required：当前key必须要传递值
  // validator：自定义的数据校验函数
  const { type, required, validator } = prop
  // required!
  // required为true 但是没有值存在和缺少 提示警告
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // missing but optional
  if (value == null && !prop.required) {
    return
  }
  // type check
  if (type != null && type !== true) {
  // 开始对使用type对数据进行检查
    let isValid = false
    // type转换成数组 方便后面使用
    const types = isArray(type) ? type : [type]
    const expectedTypes = []
    // value is valid as long as one of the specified types match
    for (let i = 0; i < types.length && !isValid; i++) {
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    // 不符合提示警告 不会继续往下执行
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }
  // custom validator
  // 自定义校验 校验必须要返回一个布尔值
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol,BigInt'
)

type AssertionResult = {
  valid: boolean
  expectedType: string
}

/**
 * dev only
 */
// 确认数据的类型
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  // type传递的是一个原生构造函数 
  // (原生构造函数：Number、String、Boolean、Array、Object、Function、Date、Symbol)
  // 找到是那个原生构造函数 确定预期类型
  const expectedType = getType(type)
  // isSimpleType 确保预期类型是八个原生类型中的其中一个
  if (isSimpleType(expectedType)) {
    // 值的数据类型
    const t = typeof value
    // 两个类型是否相同
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    // const num = new Number(1) typeof num === 'object'
    // 实例于原型的关系 value 是不是这个类型的实例
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
    // 确认数据类型是否为预期类型
  } else if (expectedType === 'Object') {
    valid = isObject(value)
  } else if (expectedType === 'Array') {
    valid = isArray(value)
  } else if (expectedType === 'null') {
    valid = value === null
  } else {
    valid = value instanceof type
  }
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(' | ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
