import {
  ElementNode,
  ObjectExpression,
  createObjectExpression,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
  createFunctionExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  Property,
  TemplateChildNode,
  SourceLocation,
  createConditionalExpression,
  ConditionalExpression,
  SimpleExpressionNode,
  FunctionExpression,
  CallExpression,
  createCallExpression,
  createArrayExpression,
  SlotsExpression
} from '../ast'
import { TransformContext, NodeTransform } from '../transform'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  findDir,
  isTemplateNode,
  assert,
  isVSlot,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { CREATE_SLOTS, RENDER_LIST, WITH_CTX } from '../runtimeHelpers'
import { parseForExpression, createForLoopParams } from './vFor'
import { SlotFlags, slotFlagsText } from '@vue/shared'

const defaultFallback = createSimpleExpression(`undefined`, false)

// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 跟踪scope slot中的scopeId 这样它们就不会被transformExpression转换成前缀
// 但这只适合{prefixIdentifiers: true}的非浏览器版本
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
// 追踪v-slot的深度 以便让我们知道一个slot在另一个slot中 
// 注意 退出函数必须在同一节点的上的buildSlot之前执行，这样才可以看到正整数
export const trackSlotScopes: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.COMPONENT ||
      node.tagType === ElementTypes.TEMPLATE)
  ) {
    // We are only checking non-empty v-slot here
    // since we only care about slots that introduce scope variables.
    // 这里只关心非空的v-slot 因为只检查引入了scope variables的
    const vSlot = findDir(node, 'slot')
    if (vSlot) {
      const slotProps = vSlot.exp
      if (!__BROWSER__ && context.prefixIdentifiers) {
        // 非浏览器+前缀的模式下 添加标识
        slotProps && context.addIdentifiers(slotProps)
      }
      // 标识有一个v-slot在处理
      context.scopes.vSlot++
      return () => {
        if (!__BROWSER__ && context.prefixIdentifiers) {
          slotProps && context.removeIdentifiers(slotProps)
        }
        context.scopes.vSlot--
      }
    }
  }
}

// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
export const trackVForSlotScopes: NodeTransform = (node, context) => {
  let vFor
  if (
    isTemplateNode(node) &&
    node.props.some(isVSlot) &&
    (vFor = findDir(node, 'for'))
  ) {
    const result = (vFor.parseResult = parseForExpression(
      vFor.exp as SimpleExpressionNode,
      context
    ))
    if (result) {
      const { value, key, index } = result
      const { addIdentifiers, removeIdentifiers } = context
      value && addIdentifiers(value)
      key && addIdentifiers(key)
      index && addIdentifiers(index)

      return () => {
        value && removeIdentifiers(value)
        key && removeIdentifiers(key)
        index && removeIdentifiers(index)
      }
    }
  }
}

export type SlotFnBuilder = (
  slotProps: ExpressionNode | undefined,
  slotChildren: TemplateChildNode[],
  loc: SourceLocation
) => FunctionExpression

// 构建客户端插槽函数
const buildClientSlotFn: SlotFnBuilder = (props, children, loc) =>
  createFunctionExpression(
    props,
    children,
    false /* newline */,
    true /* isSlot */,
    children.length ? children[0].loc : loc
  )

// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
export function buildSlots(
  node: ElementNode,
  context: TransformContext,
  buildSlotFn: SlotFnBuilder = buildClientSlotFn
): {
  slots: SlotsExpression
  hasDynamicSlots: boolean
} {
  // 插槽需要withCtx 助手函数
  context.helper(WITH_CTX)

  const { children, loc } = node
  // 动态插槽原型
  const slotsProperties: Property[] = []
  // 动态插槽
  const dynamicSlots: (ConditionalExpression | CallExpression)[] = []

  // If the slot is inside a v-for or another v-slot, force it to be dynamic
  // since it likely uses a scope variable.
  // 如果slot位于一个vFor中或者位于另一个v-slot中，则需要强制为动态插槽，因为它可能使用scope variable
  let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0
  // with `prefixIdentifiers: true`, this can be further optimized to make
  // it dynamic only when the slot actually uses the scope variables.
  // 当是前缀模式时 可以进一步优化：只有当前插槽使用scope variable 它才是动态的
  if (!__BROWSER__ && !context.ssr && context.prefixIdentifiers) {
    hasDynamicSlots = hasScopeRef(node, context.identifiers)
  }

  // 1. Check for slot with slotProps on component itself.
  //    <Comp v-slot="{ prop }"/>
  // 检查组件身上是否存在插槽
  // 匹配指令 v-slot 获取
  const onComponentSlot = findDir(node, 'slot', true)
  if (onComponentSlot) {
    const { arg, exp } = onComponentSlot
    // 当存在arg 且不是静态的 为动态插槽 创建动态插槽原型push进slotsProperties
    if (arg && !isStaticExp(arg)) {
      hasDynamicSlots = true
    }
    slotsProperties.push(
      createObjectProperty(
        arg || createSimpleExpression('default', true),
        buildSlotFn(exp, children, loc)
      )
    )
  }

  // 2. Iterate through children and check for template slots
  //    <template v-slot:foo="{ prop }">
  // 遍历子项 查找模板插槽
  // 存在模板插槽
  let hasTemplateSlots = false
  // default插槽位置
  let hasNamedDefaultSlot = false
  // 隐性的默认孩子
  const implicitDefaultChildren: TemplateChildNode[] = []
  const seenSlotNames = new Set<string>()

  for (let i = 0; i < children.length; i++) {
    const slotElement = children[i]
    let slotDir

      // 当前元素不是<template>或者不存在指令v-slot 说明不是一个<template v-slot> 跳过
    if (
      !isTemplateNode(slotElement) ||
      !(slotDir = findDir(slotElement, 'slot', true))
    ) {
      // not a <template v-slot>, skip.
      if (slotElement.type !== NodeTypes.COMMENT) {
        // 但是如果这个节点不是注释节点 请作为隐性节点
        implicitDefaultChildren.push(slotElement)
      }
      continue
    }

    // 如果组件上已经存在v-slot 这是不正确的用法
    if (onComponentSlot) {
      // already has on-component slot - this is incorrect usage.
      context.onError(
        createCompilerError(ErrorCodes.X_V_SLOT_MIXED_SLOT_USAGE, slotDir.loc)
      )
      break
    }

    // 到这里说明节点是<template>或者是v-slot
    // 产生的是默认插槽
    hasTemplateSlots = true
    const { children: slotChildren, loc: slotLoc } = slotElement
    const {
      // 名字不存在 默认是default
      arg: slotName = createSimpleExpression(`default`, true),
      exp: slotProps,
      loc: dirLoc
    } = slotDir

    // check if name is dynamic.
    // 校验插槽名字是不是动态的
    let staticSlotName: string | undefined
    if (isStaticExp(slotName)) {
      // 确认静态插槽名字
      staticSlotName = slotName ? slotName.content : `default`
    } else {
      // 插槽名字是动态的
      hasDynamicSlots = true
    }

    // 构建客户端插槽函数
    const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc)
    // check if this slot is conditional (v-if/v-for)
    // 检查此插槽是否存在vIf vFor vElse/vElseIf
    let vIf: DirectiveNode | undefined
    let vElse: DirectiveNode | undefined
    let vFor: DirectiveNode | undefined
    if ((vIf = findDir(slotElement, 'if'))) {
      // 存在vIf指令 是动态插槽
      hasDynamicSlots = true
      dynamicSlots.push(
        createConditionalExpression(
          vIf.exp!,
          buildDynamicSlot(slotName, slotFunction),
          defaultFallback
        )
      )
    } else if (
      (vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))
    ) {
      // find adjacent v-if
      // 存在elseIf/else 需要找到相邻的vIf
      let j = i
      let prev
      while (j--) {
        prev = children[j]
        // 找到离当前最近的非注释节点 
        // 因为在template中使用vIf等指令，vElse必须跟在vIf或vElseIf后
        // 而vElseIf必须紧跟在vElseIf或者VIf后面
        if (prev.type !== NodeTypes.COMMENT) {
          break
        }
      }
      if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
        // 对找到的最近的非元素节点进行检查 必须是template节点和带有v-if指令
        // remove node
        // 移除这个节点 方便下一个节点寻找v-if
        children.splice(i, 1)
        i--
        // 带指令的插槽一定是动态的，进到这说明前面应该会有动态插槽
        __TEST__ && assert(dynamicSlots.length > 0)
        // attach this slot to previous conditional
        let conditional = dynamicSlots[
          dynamicSlots.length - 1
        ] as ConditionalExpression
        // 如果是vElse 循环找到最外层
        while (
          conditional.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
        ) {
          conditional = conditional.alternate
        }
        // 根据表达式情况构建动态插槽对象
        conditional.alternate = vElse.exp
          ? createConditionalExpression(
              vElse.exp,
              buildDynamicSlot(slotName, slotFunction),
              defaultFallback
            )
          : buildDynamicSlot(slotName, slotFunction)
      } else {
        // 没有相邻的vIf或者vElseIf 报警告
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, vElse.loc)
        )
      }
    } else if ((vFor = findDir(slotElement, 'for'))) {
      // 存在vFor 一定是动态插槽
      hasDynamicSlots = true
      // 需要拿到vFor指令的解析结果 没有就去解析
      const parseResult =
        vFor.parseResult ||
        parseForExpression(vFor.exp as SimpleExpressionNode, context)
      if (parseResult) {
        // Render the dynamic slots as an array and add it to the createSlot()
        // args. The runtime knows how to handle it appropriately.
        // 将动态插槽渲染成数组，并添加为createSlot() 的实际参数 
        // 那么runtimne就会知道如何适当处理它
        dynamicSlots.push(
          createCallExpression(context.helper(RENDER_LIST), [
            parseResult.source,
            createFunctionExpression(
              createForLoopParams(parseResult),
              buildDynamicSlot(slotName, slotFunction),
              true /* force newline */
            )
          ])
        )
      } else {
        // 报警告：没有正确的vFor表达式
        context.onError(
          createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, vFor.loc)
        )
      }
    } else {
      // check duplicate static names
      // 检查是否有重复的静态的插槽名
      if (staticSlotName) {
        if (seenSlotNames.has(staticSlotName)) {
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_SLOT_DUPLICATE_SLOT_NAMES,
              dirLoc
            )
          )
          continue
        }
        // 没有重复的 添加进缓存
        seenSlotNames.add(staticSlotName)
        if (staticSlotName === 'default') {
          // 确认默认插槽
          hasNamedDefaultSlot = true
        }
      }
      // 创建动态插槽对象
      slotsProperties.push(createObjectProperty(slotName, slotFunction))
    }
  }

  // 不是组件上存在v-slot
  if (!onComponentSlot) {
    const buildDefaultSlotProperty = (
      props: ExpressionNode | undefined,
      children: TemplateChildNode[]
    ) => {
      const fn = buildSlotFn(props, children, loc)
      if (__COMPAT__ && context.compatConfig) {
        fn.isNonScopedSlot = true
      }
      return createObjectProperty(`default`, fn)
    }

    if (!hasTemplateSlots) {
      // implicit default slot (on component)
      // 不是<template v-slot>隐式默认插槽在组件上
      slotsProperties.push(buildDefaultSlotProperty(undefined, children))
    } else if (
      implicitDefaultChildren.length &&
      // #3766
      // with whitespace: 'preserve', whitespaces between slots will end up in
      // implicitDefaultChildren. Ignore if all implicit children are whitespaces.
      // 插槽之间的空白处理
      // 当使用空白策略是 preserve 插槽之间的空格将以implicitDefaultChildren结尾(渲染成默认插槽)
      // 如果 implicitDefaultChildren都是空白 则忽略
      implicitDefaultChildren.some(node => isNonWhitespaceContent(node))
    ) {
      // implicit default slot (mixed with named slots)
      // hasNamedDefaultSlot为true说明已经存在默认插槽
      // 属于隐式默认插槽和具名插槽混用 报错
      if (hasNamedDefaultSlot) {
        context.onError(
          createCompilerError(
            ErrorCodes.X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN,
            implicitDefaultChildren[0].loc
          )
        )
      } else {
        // inplicit default children as default slot render
        slotsProperties.push(
          buildDefaultSlotProperty(undefined, implicitDefaultChildren)
        )
      }
    }
  }

  // 确认slotFlag
  const slotFlag = hasDynamicSlots
    ? SlotFlags.DYNAMIC
    // 判断是不是转发插槽
    : hasForwardedSlots(node.children)
    ? SlotFlags.FORWARDED
    : SlotFlags.STABLE

  // 构建插槽内容对象
  let slots = createObjectExpression(
    slotsProperties.concat(
      createObjectProperty(
        `_`,
        // 2 = compiled but dynamic = can skip normalization, but must run diff
        // 2 已编译但是动态的 可以跳过规范化，但是需要运行 diff
        // 1 = compiled and static = can skip normalization AND diff as optimized
        // 1 已编译和是静态的 可以跳过优化模式下的规范化和 diff
        createSimpleExpression(
          slotFlag + (__DEV__ ? ` /* ${slotFlagsText[slotFlag]} */` : ``),
          false
        )
      )
    ),
    loc
  ) as SlotsExpression
  if (dynamicSlots.length) {
    // 存在动态插槽 注入create_slot助手函数 构建完整插槽对象
    slots = createCallExpression(context.helper(CREATE_SLOTS), [
      slots,
      createArrayExpression(dynamicSlots)
    ]) as SlotsExpression
  }

  return {
    slots,
    hasDynamicSlots
  }
}

// 构建动态插槽对象
function buildDynamicSlot(
  name: ExpressionNode,
  fn: FunctionExpression
): ObjectExpression {
  return createObjectExpression([
    createObjectProperty(`name`, name),
    createObjectProperty(`fn`, fn)
  ])
}

// 检查插槽里面是不是存在转发插槽
function hasForwardedSlots(children: TemplateChildNode[]): boolean {
  // 遍历子节点
  // 子节点是元素且tagType是SLOT 说明是转发插槽
  // 或者是递归调用 返回的是true 那也是转发插槽
  // 遍历完所有子元素 没有就不是插槽转发
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    switch (child.type) {
      case NodeTypes.ELEMENT:
        if (
          child.tagType === ElementTypes.SLOT ||
          hasForwardedSlots(child.children)
        ) {
          return true
        }
        break
      case NodeTypes.IF:
        if (hasForwardedSlots(child.branches)) return true
        break
      case NodeTypes.IF_BRANCH:
      case NodeTypes.FOR:
        if (hasForwardedSlots(child.children)) return true
        break
      default:
        break
    }
  }
  return false
}

function isNonWhitespaceContent(node: TemplateChildNode): boolean {
  if (node.type !== NodeTypes.TEXT && node.type !== NodeTypes.TEXT_CALL)
    return true
  return node.type === NodeTypes.TEXT
    ? !!node.content.trim()
    : isNonWhitespaceContent(node.content)
}
