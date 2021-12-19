import {
  extend,
  hyphenate,
  isArray,
  isObject,
  isString,
  makeMap,
  normalizeClass,
  normalizeStyle,
  ShapeFlags,
  toHandlerKey
} from '@vue/shared'
import {
  Component,
  ComponentInternalInstance,
  ComponentOptions,
  Data,
  InternalRenderFunction
} from '../component'
import { currentRenderingInstance } from '../componentRenderContext'
import { DirectiveArguments, withDirectives } from '../directives'
import {
  resolveDirective,
  resolveDynamicComponent
} from '../helpers/resolveAssets'
import {
  Comment,
  createVNode,
  isVNode,
  normalizeChildren,
  VNode,
  VNodeArrayChildren,
  VNodeProps
} from '../vnode'
import {
  checkCompatEnabled,
  DeprecationTypes,
  isCompatEnabled
} from './compatConfig'
import { compatModelEventPrefix } from './componentVModel'

// 转换v3之前的旧的渲染函数
export function convertLegacyRenderFn(instance: ComponentInternalInstance) {
  const Component = instance.type as ComponentOptions
  const render = Component.render as InternalRenderFunction | undefined

  // v3 runtime compiled, or already checked / wrapped
  // 如果v3已经进行编译或者检测/打包 直接退出 不在进行v2的渲染函数转换
  if (!render || render._rc || render._compatChecked || render._compatWrapped) {
    return
  }

  if (render.length >= 2) {
    // v3 pre-compiled function, since v2 render functions never need more than
    // 2 arguments, and v2 functional render functions would have already been
    // normalized into v3 functional components
    // v3预编译函数，因为v2渲染函数永远不需要超过2个参数，而且v2渲染函数已经被规范化为v3函数组件
    render._compatChecked = true
    return
  }

  // v2 render function, try to provide compat
  // v2渲染函数，尝试提供兼容
  if (checkCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance)) {
    // wrapped是最后执行完兼容 返回的VNode
    const wrapped = (Component.render = function compatRender() {
      // @ts-ignore
      // 执行兼容 compatH 函数会对旧插槽、旧指令、旧属性、过滤器进行转换
      return render.call(this, compatH)
    })
    // @ts-ignore
    wrapped._compatWrapped = true
  }
}

interface LegacyVNodeProps {
  key?: string | number
  ref?: string
  refInFor?: boolean

  staticClass?: string
  class?: unknown
  staticStyle?: Record<string, unknown>
  style?: Record<string, unknown>
  attrs?: Record<string, unknown>
  domProps?: Record<string, unknown>
  on?: Record<string, Function | Function[]>
  nativeOn?: Record<string, Function | Function[]>
  directives?: LegacyVNodeDirective[]

  // component only
  props?: Record<string, unknown>
  slot?: string
  scopedSlots?: Record<string, Function>
  model?: {
    value: any
    callback: (v: any) => void
    expression: string
  }
}

interface LegacyVNodeDirective {
  name: string
  value: unknown
  arg?: string
  modifiers?: Record<string, boolean>
}

type LegacyVNodeChildren =
  | string
  | number
  | boolean
  | VNode
  | VNodeArrayChildren

export function compatH(
  type: string | Component,
  children?: LegacyVNodeChildren
): VNode
export function compatH(
  type: string | Component,
  props?: Data & LegacyVNodeProps,
  children?: LegacyVNodeChildren
): VNode

export function compatH(
  type: any,
  propsOrChildren?: any,
  children?: any
): VNode {
  if (!type) {
    type = Comment
  }

  // to support v2 string component name look!up
  // 要支持v2字符串组件名称 请看上面的形参
  if (typeof type === 'string') {
    const t = hyphenate(type)
    // 兼容v2中内置组件
    //因为transition和transition-group是特定于运行时dom的，所以我们不能在这里直接导入它们。
    // 相反，它们是使用@vue/compat条目中的特殊密钥注册的。
    if (t === 'transition' || t === 'transition-group' || t === 'keep-alive') {
      // since transition and transition-group are runtime-dom-specific,
      // we cannot import them directly here. Instead they are registered using
      // special keys in @vue/compat entry.
      type = `__compat__${t}`
    }
    // 解析注册组件
    type = resolveDynamicComponent(type)
  }

  // 处理用户手写的渲染函数的参数 也就是h函数的参数 最后都会返回一个VNode
  const l = arguments.length
  // 第二个参数可能是props对象也可能是Children数组
  const is2ndArgArrayChildren = isArray(propsOrChildren)
  // 只有参数达到两个 或者是 第二参数是数组
  // h('div', {key1: value1})
  // h('div', [h('div', {...}, [...])])
  // h('componentName', VNode)
  if (l === 2 || is2ndArgArrayChildren) {
    if (isObject(propsOrChildren) && !is2ndArgArrayChildren) {
      // single vnode without props
      // 如果第二参数是vnode代表这是slots
      // h('componentName', VNode)
      if (isVNode(propsOrChildren)) {
        // 转换v3版本之前的旧插槽
        return convertLegacySlots(createVNode(type, null, [propsOrChildren]))
      }
      // props without children
      // 只有props没有children
      // h('div', {key1: value1})
      return convertLegacySlots(
        // 节点身上可能会出现v3版本之前的旧指令，需要转换
        convertLegacyDirectives(
          createVNode(type, convertLegacyProps(propsOrChildren, type)),
          propsOrChildren
        )
      )
    } else {
      // omit props
      // 只有children 没有props 
      // h('div', [h('div', {...}, [...])])
      return convertLegacySlots(createVNode(type, null, propsOrChildren))
    }
  } else {
    // 到这里说明是给了三个参数 且第二参数必定不是数组
    // h('div', {key1: value1, key2: value2}, [h('div', {...}, [...])])
    // h('componentName', {key1: value1, key2: value2}, VNode)
    // 如果children是VNode 代表是一个旧插槽 但是需要转换成数组去解析
    if (isVNode(children)) {
      children = [children]
    }
    // 需要转换旧参数 旧指令 旧插槽
    return convertLegacySlots(
      convertLegacyDirectives(
        createVNode(type, convertLegacyProps(propsOrChildren, type), children),
        propsOrChildren
      )
    )
  }
}

const skipLegacyRootLevelProps = /*#__PURE__*/ makeMap(
  'staticStyle,staticClass,directives,model,hook'
)

function convertLegacyProps(
  legacyProps: LegacyVNodeProps | undefined,
  type: any
): (Data & VNodeProps) | null {
  if (!legacyProps) {
    return null
  }

  const converted: Data & VNodeProps = {}

  for (const key in legacyProps) {
    if (key === 'attrs' || key === 'domProps' || key === 'props') {
      extend(converted, legacyProps[key])
    } else if (key === 'on' || key === 'nativeOn') {
      const listeners = legacyProps[key]
      for (const event in listeners) {
        let handlerKey = convertLegacyEventKey(event)
        if (key === 'nativeOn') handlerKey += `Native`
        const existing = converted[handlerKey]
        const incoming = listeners[event]
        if (existing !== incoming) {
          if (existing) {
            converted[handlerKey] = [].concat(existing as any, incoming as any)
          } else {
            converted[handlerKey] = incoming
          }
        }
      }
    } else if (!skipLegacyRootLevelProps(key)) {
      converted[key] = legacyProps[key as keyof LegacyVNodeProps]
    }
  }

  if (legacyProps.staticClass) {
    converted.class = normalizeClass([legacyProps.staticClass, converted.class])
  }
  if (legacyProps.staticStyle) {
    converted.style = normalizeStyle([legacyProps.staticStyle, converted.style])
  }

  if (legacyProps.model && isObject(type)) {
    // v2 compiled component v-model
    const { prop = 'value', event = 'input' } = (type as any).model || {}
    converted[prop] = legacyProps.model.value
    converted[compatModelEventPrefix + event] = legacyProps.model.callback
  }

  return converted
}

function convertLegacyEventKey(event: string): string {
  // normalize v2 event prefixes
  if (event[0] === '&') {
    event = event.slice(1) + 'Passive'
  }
  if (event[0] === '~') {
    event = event.slice(1) + 'Once'
  }
  if (event[0] === '!') {
    event = event.slice(1) + 'Capture'
  }
  return toHandlerKey(event)
}

function convertLegacyDirectives(
  vnode: VNode,
  props?: LegacyVNodeProps
): VNode {
  if (props && props.directives) {
    return withDirectives(
      vnode,
      props.directives.map(({ name, value, arg, modifiers }) => {
        return [
          resolveDirective(name)!,
          value,
          arg,
          modifiers
        ] as DirectiveArguments[number]
      })
    )
  }
  return vnode
}

function convertLegacySlots(vnode: VNode): VNode {
  const { props, children } = vnode

  let slots: Record<string, any> | undefined

  if (vnode.shapeFlag & ShapeFlags.COMPONENT && isArray(children)) {
    slots = {}
    // check "slot" property on vnodes and turn them into v3 function slots
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const slotName =
        (isVNode(child) && child.props && child.props.slot) || 'default'
      const slot = slots[slotName] || (slots[slotName] = [] as any[])
      if (isVNode(child) && child.type === 'template') {
        slot.push(child.children)
      } else {
        slot.push(child)
      }
    }
    if (slots) {
      for (const key in slots) {
        const slotChildren = slots[key]
        slots[key] = () => slotChildren
        slots[key]._ns = true /* non-scoped slot */
      }
    }
  }

  const scopedSlots = props && props.scopedSlots
  if (scopedSlots) {
    delete props!.scopedSlots
    if (slots) {
      extend(slots, scopedSlots)
    } else {
      slots = scopedSlots
    }
  }

  if (slots) {
    normalizeChildren(vnode, slots)
  }

  return vnode
}

export function defineLegacyVNodeProperties(vnode: VNode) {
  /* istanbul ignore if */
  if (
    isCompatEnabled(
      DeprecationTypes.RENDER_FUNCTION,
      currentRenderingInstance,
      true /* enable for built-ins */
    ) &&
    isCompatEnabled(
      DeprecationTypes.PRIVATE_APIS,
      currentRenderingInstance,
      true /* enable for built-ins */
    )
  ) {
    const context = currentRenderingInstance
    const getInstance = () => vnode.component && vnode.component.proxy
    let componentOptions: any
    Object.defineProperties(vnode, {
      tag: { get: () => vnode.type },
      data: { get: () => vnode.props || {}, set: p => (vnode.props = p) },
      elm: { get: () => vnode.el },
      componentInstance: { get: getInstance },
      child: { get: getInstance },
      text: { get: () => (isString(vnode.children) ? vnode.children : null) },
      context: { get: () => context && context.proxy },
      componentOptions: {
        get: () => {
          if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) {
            if (componentOptions) {
              return componentOptions
            }
            return (componentOptions = {
              Ctor: vnode.type,
              propsData: vnode.props,
              children: vnode.children
            })
          }
        }
      }
    })
  }
}
