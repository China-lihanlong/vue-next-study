import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  ElementTypes,
  CallExpression,
  ObjectExpression,
  ElementNode,
  DirectiveNode,
  ExpressionNode,
  ArrayExpression,
  createCallExpression,
  createArrayExpression,
  createObjectProperty,
  createSimpleExpression,
  createObjectExpression,
  Property,
  ComponentNode,
  VNodeCall,
  TemplateTextChildNode,
  DirectiveArguments,
  createVNodeCall,
  ConstantTypes,
  JSChildNode,
  createFunctionExpression,
  createBlockStatement
} from '../ast'
import {
  PatchFlags,
  PatchFlagNames,
  isSymbol,
  isOn,
  isObject,
  isReservedProp,
  capitalize,
  camelize
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  RESOLVE_DIRECTIVE,
  RESOLVE_COMPONENT,
  RESOLVE_DYNAMIC_COMPONENT,
  MERGE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  TO_HANDLERS,
  TELEPORT,
  KEEP_ALIVE,
  SUSPENSE,
  UNREF,
  GUARD_REACTIVE_PROPS,
  IS_REF
} from '../runtimeHelpers'
import {
  getInnerRange,
  toValidAssetId,
  findProp,
  isCoreComponent,
  isBindKey,
  findDir,
  isStaticExp
} from '../utils'
import { buildSlots } from './vSlot'
import { getConstantType } from './hoistStatic'
import { BindingTypes } from '../options'
import {
  checkCompatEnabled,
  CompilerDeprecationTypes,
  isCompatEnabled
} from '../compat/compatConfig'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
// 一些指令在transform时(比如v-model) 需要返回一些唯一标志 在运行时引入，这些标志应该代替resolveDirective调用
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// generate a JavaScript AST for this element's codegen
// 为该元素的codegen生成 javascript AST
export const transformElement: NodeTransform = (node, context) => {
  // perform the work on exit, after all child expressions have been
  // processed and merged.
  // 在处理所有合并子表达式后 执行退出工作
  return function postTransformElement() {
    node = context.currentNode!

    if (
      !(
        node.type === NodeTypes.ELEMENT &&
        (node.tagType === ElementTypes.ELEMENT ||
          node.tagType === ElementTypes.COMPONENT)
      )
    ) {
      return
    }

    const { tag, props } = node
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    // 转换的目的是为了实现一个VNodeCall的接口
    // 拿到元素标签
    let vnodeTag = isComponent
      ? resolveComponentType(node as ComponentNode, context)
      : `"${tag}"`

    // 判断是不是动态组件
    const isDynamicComponent =
      isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT

    // 拿到元素的一系列数据
    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let vnodePatchFlag: VNodeCall['patchFlag']
    let patchFlag: number = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      // 动态组件可以解析为普通的元素标签
      isDynamicComponent ||
      vnodeTag === TELEPORT ||
      vnodeTag === SUSPENSE ||
      (!isComponent &&
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        // <svg>和<foreignObject>必须强制使用block 让runtime中可以正常更新
        (tag === 'svg' ||
          tag === 'foreignObject' ||
          // #938: elements with dynamic keys should be forced into blocks
          // 具有动态的key的元素元素应该被强制进入块
          findProp(node, 'key', true)))

    // props
    // 处理元素的props
    if (props.length > 0) {
      // props 构建结果
      const propsBuildResult = buildProps(node, context)
      vnodeProps = propsBuildResult.props
      patchFlag = propsBuildResult.patchFlag
      dynamicPropNames = propsBuildResult.dynamicPropNames
      const directives = propsBuildResult.directives
      // 构建指令处理函数参数
      vnodeDirectives =
        directives && directives.length
          ? (createArrayExpression(
              directives.map(dir => buildDirectiveArgs(dir, context))
            ) as DirectiveArguments)
          : undefined
    }

    // children
    // 处理 children
    if (node.children.length > 0) {
      if (vnodeTag === KEEP_ALIVE) {
        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 虽然这是一个内置组件，但是我们使用原始children而不是slot函数去编译KeepAlive
        // 这样就可以在Transition和Transition-Wrapping HOC(高阶组件)中去使用它，
        // 为了块优化的正确更新，我们需要: 
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.
        // 1. 强行变成block 这样可以避免parent block去收集childre object
        shouldUseBlock = true
        // 2. Force keep-alive to always be updated, since it uses raw children.
        // keep-alive 始终处于更新状态 因为它使用的是原始children
        patchFlag |= PatchFlags.DYNAMIC_SLOTS
        if (__DEV__ && node.children.length > 1) {
          // keepalive只能有一个
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: ''
            })
          )
        }
      }

      // 判断是否应该构建成插槽
      const shouldBuildAsSlots =
        isComponent &&
        // Teleport is not a real component and has dedicated runtime handling
        // Teleport 不是一个真正的组件 他有专门的运行时处理程序
        vnodeTag !== TELEPORT &&
        // explained above.
        // keep-alive 也不是一个真正的组件 有专门的运行时处理程序
        vnodeTag !== KEEP_ALIVE

      if (shouldBuildAsSlots) {
        // 构建成插槽
        const { slots, hasDynamicSlots } = buildSlots(node, context)
        vnodeChildren = slots
        if (hasDynamicSlots) {
          // 存在动态插槽，请加上DYNAMIC_SLOTS
          patchFlag |= PatchFlags.DYNAMIC_SLOTS
        }
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
        // 只有一个孩子且不是teleport 请校验是不是动态文本孩子
        const child = node.children[0]
        const type = child.type
        // check for dynamic text children
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION ||
          type === NodeTypes.COMPOUND_EXPRESSION
        if (
          hasDynamicTextChild &&
          getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
        ) {
          // 去找child的ConstantType 是NOT_CONSTANT且hasDynamicTextChild是true
          // patch flag 请加上TEXT
          patchFlag |= PatchFlags.TEXT
        }
        // pass directly if the only child is a text node
        // (plain / interpolation / expression)
        // 如果是直接唯一的文本节点(普通文本、插值、表达式),可以直接传递
        if (hasDynamicTextChild || type === NodeTypes.TEXT) {
          vnodeChildren = child as TemplateTextChildNode
        } else {
          // 只能拿node.children
          vnodeChildren = node.children
        }
      } else {
        // 只能拿node.children
        vnodeChildren = node.children
      }
    }

    // patchFlag & dynamicPropNames
    // 确认patchFlag 和dynamicPropNames
    if (patchFlag !== 0) {
      if (__DEV__) {
        if (patchFlag < 0) {
          // special flags (negative and mutually exclusive)
          // 特殊标志
          vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
        } else {
          // bitwise flags
          // 确认标志
          // 最后变成 例如：/* PROPS, TEXT */
          const flagNames = Object.keys(PatchFlagNames)
            .map(Number)
            .filter(n => n > 0 && patchFlag & n)
            .map(n => PatchFlagNames[n])
            .join(`, `)
          vnodePatchFlag = patchFlag + ` /* ${flagNames} */`
        }
      } else {
        vnodePatchFlag = String(patchFlag)
      }
      if (dynamicPropNames && dynamicPropNames.length) {
        vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames)
      }
    }

    // 创建codegendNode
    node.codegenNode = createVNodeCall(
      context,
      vnodeTag,
      vnodeProps,
      vnodeChildren,
      vnodePatchFlag,
      vnodeDynamicProps,
      vnodeDirectives,
      !!shouldUseBlock,
      false /* disableTracking */,
      isComponent,
      node.loc
    )
  }
}

export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false
) {
  let { tag } = node

  // 1. dynamic component
  const isExplicitDynamic = isComponentTag(tag)
  const isProp = findProp(node, 'is')
  if (isProp) {
    if (
      isExplicitDynamic ||
      (__COMPAT__ &&
        isCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context
        ))
    ) {
      const exp =
        isProp.type === NodeTypes.ATTRIBUTE
          ? isProp.value && createSimpleExpression(isProp.value.content, true)
          : isProp.exp
      if (exp) {
        return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
          exp
        ])
      }
    } else if (
      isProp.type === NodeTypes.ATTRIBUTE &&
      isProp.value!.content.startsWith('vue:')
    ) {
      // <button is="vue:xxx">
      // if not <component>, only is value that starts with "vue:" will be
      // treated as component by the parse phase and reach here, unless it's
      // compat mode where all is values are considered components
      tag = isProp.value!.content.slice(4)
    }
  }

  // 1.5 v-is (TODO: Deprecate)
  const isDir = !isExplicitDynamic && findDir(node, 'is')
  if (isDir && isDir.exp) {
    return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
      isDir.exp
    ])
  }

  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // built-ins are simply fallthroughs / have special handling during ssr
    // so we don't need to import their runtime equivalents
    if (!ssr) context.helper(builtIn)
    return builtIn
  }

  // 3. user component (from setup bindings)
  // this is skipped in browser build since browser builds do not perform
  // binding analysis.
  if (!__BROWSER__) {
    const fromSetup = resolveSetupReference(tag, context)
    if (fromSetup) {
      return fromSetup
    }
    const dotIndex = tag.indexOf('.')
    if (dotIndex > 0) {
      const ns = resolveSetupReference(tag.slice(0, dotIndex), context)
      if (ns) {
        return ns + tag.slice(dotIndex)
      }
    }
  }

  // 4. Self referencing component (inferred from filename)
  if (
    !__BROWSER__ &&
    context.selfName &&
    capitalize(camelize(tag)) === context.selfName
  ) {
    context.helper(RESOLVE_COMPONENT)
    // codegen.ts has special check for __self postfix when generating
    // component imports, which will pass additional `maybeSelfReference` flag
    // to `resolveComponent`.
    context.components.add(tag + `__self`)
    return toValidAssetId(tag, `component`)
  }

  // 5. user component (resolve)
  context.helper(RESOLVE_COMPONENT)
  context.components.add(tag)
  return toValidAssetId(tag, `component`)
}

function resolveSetupReference(name: string, context: TransformContext) {
  const bindings = context.bindingMetadata
  if (!bindings || bindings.__isScriptSetup === false) {
    return
  }

  const camelName = camelize(name)
  const PascalName = capitalize(camelName)
  const checkType = (type: BindingTypes) => {
    if (bindings[name] === type) {
      return name
    }
    if (bindings[camelName] === type) {
      return camelName
    }
    if (bindings[PascalName] === type) {
      return PascalName
    }
  }

  const fromConst = checkType(BindingTypes.SETUP_CONST)
  if (fromConst) {
    return context.inline
      ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
        fromConst
      : `$setup[${JSON.stringify(fromConst)}]`
  }

  const fromMaybeRef =
    checkType(BindingTypes.SETUP_LET) ||
    checkType(BindingTypes.SETUP_REF) ||
    checkType(BindingTypes.SETUP_MAYBE_REF)
  if (fromMaybeRef) {
    return context.inline
      ? // setup scope bindings that may be refs need to be unrefed
        `${context.helperString(UNREF)}(${fromMaybeRef})`
      : `$setup[${JSON.stringify(fromMaybeRef)}]`
  }
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] = node.props,
  ssr = false
): {
  props: PropsExpression | undefined
  directives: DirectiveNode[]
  patchFlag: number
  dynamicPropNames: string[]
} {
  const { tag, loc: elementLoc } = node
  // 判断是不是组件
  const isComponent = node.tagType === ElementTypes.COMPONENT
  // prop
  let properties: ObjectExpression['properties'] = []
  // 合并参数
  const mergeArgs: PropsExpression[] = []
  // 运行时指令
  const runtimeDirectives: DirectiveNode[] = []

  // patchFlag analysis
  // patchFlag 分析
  let patchFlag = 0
  let hasRef = false
  let hasClassBinding = false
  let hasStyleBinding = false
  let hasHydrationEventBinding = false
  let hasDynamicKeys = false
  let hasVnodeHook = false
  // 动态props name
  const dynamicPropNames: string[] = []

  const analyzePatchFlag = ({ key, value }: Property) => {
    if (isStaticExp(key)) {
      const name = key.content
      const isEventHandler = isOn(name)
      if (
        !isComponent &&
        isEventHandler &&
        // omit the flag for click handlers because hydration gives click
        // dedicated fast path.
        // 忽略click处理程序的标志 因为它提供了click专用的快速路径
        name.toLowerCase() !== 'onclick' &&
        // omit v-model handlers
        // 忽略v-model处理程序
        name !== 'onUpdate:modelValue' &&
        // omit onVnodeXXX hooks
        // 忽略 onVnodeXXX 钩子函数
        !isReservedProp(name)
      ) {
        hasHydrationEventBinding = true
      }

      // 判断是否存在VnodeXXX 钩子函数
      if (isEventHandler && isReservedProp(name)) {
        hasVnodeHook = true
      }

      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION ||
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getConstantType(value, context) > 0)
      ) {
        // skip if the prop is a cached handler or has constant value
        // 如果prop存在缓存或者是常量 请跳过
        return
      }

      // 判断对应属性 将其标志设置为true
      if (name === 'ref') {
        hasRef = true
      } else if (name === 'class') {
        hasClassBinding = true
      } else if (name === 'style') {
        hasStyleBinding = true
      // 不是ref class style key 且不存在于dynamicPropNames 设置为动态prop
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) {
        dynamicPropNames.push(name)
      }

      // treat the dynamic class and style binding of the component as dynamic props
      // 讲组件上的动态style和class绑定设置为 动态props
      if (
        isComponent &&
        (name === 'class' || name === 'style') &&
        !dynamicPropNames.includes(name)
      ) {
        dynamicPropNames.push(name)
      }
    } else {
      hasDynamicKeys = true
    }
  }

  for (let i = 0; i < props.length; i++) {
    // static attribute
    // 处理静态 attr 比如class style 不是v-bind绑定的属性
    const prop = props[i]
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const { loc, name, value } = prop
      let valueNode = createSimpleExpression(
        value ? value.content : '',
        true,
        value ? value.loc : loc
      ) as JSChildNode
      if (name === 'ref') {
        hasRef = true
        // in inline mode there is no setupState object, so we can't use string
        // keys to set the ref. Instead, we need to transform it to pass the
        // actual ref instead.
        if (!__BROWSER__ && context.inline && value?.content) {
          valueNode = createFunctionExpression(['_value', '_refs'])
          valueNode.body = createBlockStatement(
            processInlineRef(context, value.content)
          )
        }
      }
      // skip is on <component>, or is="vue:xxx"
      // 跳过 在<component>上的 is 或者时 :is="vue:xxx"
      if (
        name === 'is' &&
        (isComponentTag(tag) ||
          (value && value.content.startsWith('vue:')) ||
          (__COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
              context
            )))
      ) {
        continue
      }
      // 创建对应的对象原型放入properties中
      properties.push(
        createObjectProperty(
          createSimpleExpression(
            name,
            true,
            getInnerRange(loc, 0, name.length)
          ),
          valueNode
        )
      )
    } else {
      // directives
      // 处理指令
      const { name, arg, exp, loc } = prop
      const isVBind = name === 'bind'
      const isVOn = name === 'on'

      // skip v-slot - it is handled by its dedicated transform.
      // 跳过v-slot指令 它由专门的transform处理
      if (name === 'slot') {
        if (!isComponent) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc)
          )
        }
        continue
      }
      // skip v-once/v-memo - they are handled by dedicated transforms.
      // 跳过v-once和v-memo 它们由专门的transform 处理
      if (name === 'once' || name === 'memo') {
        continue
      }
      // skip v-is and :is on <component>
      // 跳过在组件上的v-is和:is
      if (
        name === 'is' ||
        (isVBind &&
          isBindKey(arg, 'is') &&
          (isComponentTag(tag) ||
            (__COMPAT__ &&
              isCompatEnabled(
                CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
                context
              ))))
      ) {
        continue
      }
      // skip v-on in SSR compilation
      // 在SSR 下 跳过v-on
      if (isVOn && ssr) {
        continue
      }

      // special case for v-bind and v-on with no argument
      // 无参数的v-bind和v-on的特例 v-bind="$attrs"
      if (!arg && (isVBind || isVOn)) {
        hasDynamicKeys = true
        if (exp) {
          if (properties.length) {
            mergeArgs.push(
              createObjectExpression(dedupeProperties(properties), elementLoc)
            )
            properties = []
          }
          if (isVBind) {
            if (__COMPAT__) {
              // 2.x v-bind object order compat
              // 非兼容2.x v-bind指令对象合并行为 <div v-bind="{id: 'blue'}" id="red">
              if (__DEV__) {
                const hasOverridableKeys = mergeArgs.some(arg => {
                  if (arg.type === NodeTypes.JS_OBJECT_EXPRESSION) {
                    return arg.properties.some(({ key }) => {
                      if (
                        key.type !== NodeTypes.SIMPLE_EXPRESSION ||
                        !key.isStatic
                      ) {
                        return true
                      }
                      return (
                        key.content !== 'class' &&
                        key.content !== 'style' &&
                        !isOn(key.content)
                      )
                    })
                  } else {
                    // dynamic expression
                    return true
                  }
                })
                if (hasOverridableKeys) {
                  checkCompatEnabled(
                    CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                    context,
                    loc
                  )
                }
              }

              if (
                isCompatEnabled(
                  CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                  context
                )
              ) {
                mergeArgs.unshift(exp)
                continue
              }
            }

            mergeArgs.push(exp)
          } else {
            // v-on="obj" -> toHandlers(obj)
            // 将v-on="obj" 最后应该变成 toHanlders 添加对应的助手函数
            mergeArgs.push({
              type: NodeTypes.JS_CALL_EXPRESSION,
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: [exp]
            })
          }
        } else {
          // 不存在表达式 报错
          context.onError(
            createCompilerError(
              isVBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc
            )
          )
        }
        continue
      }

      // 获取对应指令的transform程序
      const directiveTransform = context.directiveTransforms[name]
      if (directiveTransform) {
        // has built-in directive transform.
        // 执行内置的指令transform程序 
        const { props, needRuntime } = directiveTransform(prop, node, context)
        // 不是服务端渲染 分析patchFlag
        !ssr && props.forEach(analyzePatchFlag)
        // 解析出来的props放入properties中
        properties.push(...props)
        // 如果指令返回了唯一标识 请添加进运行时指令处理程序中，
        //并且在全局中的directiveImportMap设置 方便在运行时引入
        // 只有v-show和v-model
        if (needRuntime) {
          runtimeDirectives.push(prop)
          if (isSymbol(needRuntime)) {
            directiveImportMap.set(prop, needRuntime)
          }
        }
      } else {
        // no built-in transform, this is a user custom directive.
        // 不存在内置的transform 这是用户的自定义指令 用户自己提供了运行时处理程序
        runtimeDirectives.push(prop)
      }
    }

    // 2.x 非兼容行为 v-for中的数组
    // 当遇到ref属性 并且有一个v-for正在处理 进行处理
    if (
      __COMPAT__ &&
      prop.type === NodeTypes.ATTRIBUTE &&
      prop.name === 'ref' &&
      context.scopes.vFor > 0 &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_FOR_REF,
        context,
        prop.loc
      )
    ) {
      properties.push(
        createObjectProperty(
          createSimpleExpression('refInFor', true),
          createSimpleExpression('true', false)
        )
      )
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // has v-bind="object" or v-on="object", wrap with mergeProps
  // 存在 v-bind="object" 或 v-on="object" 使用 mergeProps包裹
  if (mergeArgs.length) {
    if (properties.length) {
      // 合并数据
      mergeArgs.push(
        createObjectExpression(dedupeProperties(properties), elementLoc)
      )
    }
    // 创建表达式对象 添加mergeProps助手函数
    if (mergeArgs.length > 1) {
      propsExpression = createCallExpression(
        context.helper(MERGE_PROPS),
        mergeArgs,
        elementLoc
      )
    } else {
      // single v-bind with nothing else - no need for a mergeProps call
      // 没有其他功能的单个v-bind 无需使用mergeProps包裹
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) {
    // 不需要合并数据
    propsExpression = createObjectExpression(
      dedupeProperties(properties),
      elementLoc
    )
  }

  // patchFlag analysis
  // patchFlag 分析
  if (hasDynamicKeys) {
    // 存在动态key 直接直接使用FULL_PROPS
    patchFlag |= PatchFlags.FULL_PROPS
  } else {
    // hasClassBinding 为true 加上CLASS
    if (hasClassBinding && !isComponent) {
      patchFlag |= PatchFlags.CLASS
    }
    // hasStyleBinding 为true 加上STYLE
    if (hasStyleBinding && !isComponent) {
      patchFlag |= PatchFlags.STYLE
    }
    // 存在动态props或者props name 排除key 加上PROPS
    if (dynamicPropNames.length) {
      patchFlag |= PatchFlags.PROPS
    }
    // 这是服务端渲染
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS
    }
  }
  // 服务端渲染不需要浏览器patch
  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || hasVnodeHook || runtimeDirectives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH
  }

  // pre-normalize props, SSR is skipped for now
  // 预先规范化 props SSR现在可以先跳过
  if (!context.inSSR && propsExpression) {
    switch (propsExpression.type) {
      case NodeTypes.JS_OBJECT_EXPRESSION:
        // means that there is no v-bind,
        // but still need to deal with dynamic key binding
        // 意味着没有v-bind绑定 但是仍然需要处理动态的props key
        let classKeyIndex = -1
        let styleKeyIndex = -1
        // :[key]="exp"
        let hasDynamicKey = false

        for (let i = 0; i < propsExpression.properties.length; i++) {
          const key = propsExpression.properties[i].key
          if (isStaticExp(key)) {
            if (key.content === 'class') {
              classKeyIndex = i
            } else if (key.content === 'style') {
              styleKeyIndex = i
            }
          } else if (!key.isHandlerKey) {
            // isHanlderKey 标记它是事件处理程序
            hasDynamicKey = true
          }
        }

        // 找到classProp 和 styleProp
        const classProp = propsExpression.properties[classKeyIndex]
        const styleProp = propsExpression.properties[styleKeyIndex]

        // no dynamic key
        // 不存在动态props key
        if (!hasDynamicKey) {
          // classProps 存在 且value不是动态的 注入助手函数 normalize_class
          if (classProp && !isStaticExp(classProp.value)) {
            classProp.value = createCallExpression(
              context.helper(NORMALIZE_CLASS),
              [classProp.value]
            )
          }
          if (
            styleProp &&
            !isStaticExp(styleProp.value) &&
            // the static style is compiled into an object,
            // so use `hasStyleBinding` to ensure that it is a dynamic style binding
            // 静态样式会编译成一个对象 所以需要使用hasStyleBinding判断是不是有动态的style绑定
            (hasStyleBinding ||
              // v-bind:style and style both exist,
              // v-bind:style with static literal object
              // 动态绑定和静态的样式都有 或者是 动态绑定的静态文字对象 注入助手函数 normalize_style
              styleProp.value.type === NodeTypes.JS_ARRAY_EXPRESSION)
          ) {
            styleProp.value = createCallExpression(
              context.helper(NORMALIZE_STYLE),
              [styleProp.value]
            )
          }
        } else {
          // dynamic key binding, wrap with `normalizeProps`
          // 存在动态props 使用 normalizeProps包裹
          propsExpression = createCallExpression(
            context.helper(NORMALIZE_PROPS),
            [propsExpression]
          )
        }
        break
      case NodeTypes.JS_CALL_EXPRESSION:
        // mergeProps call, do nothing
        // mergeProps 调用 声明也不做
        break
      default:
        // single v-bind
        // 单独v-bind绑定 例如：v-bind="obj"
        propsExpression = createCallExpression(
          context.helper(NORMALIZE_PROPS),
          [
            createCallExpression(context.helper(GUARD_REACTIVE_PROPS), [
              propsExpression
            ])
          ]
        )
        break
    }
  }

  // 返回处理好的props表达式
  // 运行时的指令处理程序
  // patchFlag和动态的propName
  return {
    props: propsExpression,
    directives: runtimeDirectives,
    patchFlag,
    dynamicPropNames
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
// 消除在v-on="{}"或v-bind="bind"中的重复的props
// 文本重复数据在解析阶段就会报警告
// 我们还会遇到使用不同修饰符相同的onXXX和合并静态和动态的class与style
// 那么 onXXX处理程序和style会合并成数组 class会被合并成具有串联的单个表达式
// 处理重复和合并属性
function dedupeProperties(properties: Property[]): Property[] {
  // 已知props
  const knownProps: Map<string, Property> = new Map()
  // 重复数据消除
  const deduped: Property[] = []
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]
    // dynamic keys are always allowed
    // 始终允许使用动态key
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }
    // 存在已知的props 请进行合并
    // 不存在，请设置成已知的 并且需要消除重复数据
    const name = prop.key.content
    const existing = knownProps.get(name)
    if (existing) {
      if (name === 'style' || name === 'class' || isOn(name)) {
        mergeAsArray(existing, prop)
      }
      // unexpected duplicate, should have emitted error during parse
      // 意外的重复 应该再解析时发出错误
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

function mergeAsArray(existing: Property, incoming: Property) {
  // 如果已经存在数组表达式，可以直接添加
  // 不存在则需要创建后再添加
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.value.elements.push(incoming.value)
  } else {
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc
    )
  }
}

// 构建指令处理函数的参数
function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext
): ArrayExpression {
  const dirArgs: ArrayExpression['elements'] = []
  const runtime = directiveImportMap.get(dir)
  if (runtime) {
    // built-in directive with runtime
    // 带运行时的指令
    dirArgs.push(context.helperString(runtime))
  } else {
    // user directive.
    // 用户指令(自定义指令)
    // see if we have directives exposed via <script setup>
    // 查看指令是否通过<script setup>
    const fromSetup =
      !__BROWSER__ && resolveSetupReference('v-' + dir.name, context)
    if (fromSetup) {
      dirArgs.push(fromSetup)
    } else {
      // inject statement for resolving directive
      // 应用于解析指令的注入语句
      // 注入resolve_directive助手函数
      context.helper(RESOLVE_DIRECTIVE)
      context.directives.add(dir.name)
      // 处理一下参数的名字 收集
      dirArgs.push(toValidAssetId(dir.name, `directive`))
    }
  }
  const { loc } = dir
  if (dir.exp) dirArgs.push(dir.exp)
  // 处理 exp arg 根据情况是否给默认值 void 0 后面是会变成undefined
  // 但是如果啥都没带 最后只会有指令的生命周期函数到渲染函数中
  if (dir.arg) {
    if (!dir.exp) {
      dirArgs.push(`void 0`)
    }
    dirArgs.push(dir.arg)
  }
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) {
      if (!dir.exp) {
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      createObjectExpression(
        // 处理修饰符
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression)
        ),
        loc
      )
    )
  }
  // 指令解析过是数组格式
  return createArrayExpression(dirArgs, dir.loc)
}

function stringifyDynamicPropNames(props: string[]): string {
  // 拼凑成例如：['onClick'...]
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}

function isComponentTag(tag: string) {
  return tag === 'component' || tag === 'Component'
}

function processInlineRef(
  context: TransformContext,
  raw: string
): JSChildNode[] {
  const body = [createSimpleExpression(`_refs['${raw}'] = _value`)]
  const { bindingMetadata, helperString } = context
  const type = bindingMetadata[raw]
  if (type === BindingTypes.SETUP_REF) {
    body.push(createSimpleExpression(`${raw}.value = _value`))
  } else if (type === BindingTypes.SETUP_MAYBE_REF) {
    body.push(
      createSimpleExpression(
        `${helperString(IS_REF)}(${raw}) && (${raw}.value = _value)`
      )
    )
  } else if (type === BindingTypes.SETUP_LET) {
    body.push(
      createSimpleExpression(
        `${helperString(
          IS_REF
        )}(${raw}) ? ${raw}.value = _value : ${raw} = _value`
      )
    )
  }
  return body
}
