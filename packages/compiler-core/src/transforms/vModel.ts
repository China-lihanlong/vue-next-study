import { DirectiveTransform } from '../transform'
import {
  createSimpleExpression,
  createObjectProperty,
  createCompoundExpression,
  NodeTypes,
  Property,
  ElementTypes,
  ExpressionNode,
  ConstantTypes
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  isMemberExpression,
  isSimpleIdentifier,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { IS_REF } from '../runtimeHelpers'
import { BindingTypes } from '../options'

export const transformModel: DirectiveTransform = (dir, node, context) => {
  const { exp, arg } = dir
  // 表达式不存在 报错 返回一个对象，里面的props是空数组
  if (!exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_NO_EXPRESSION, dir.loc)
    )
    return createTransformProps()
  }

  // 检测表达式是否是一个稳定表达式 以此来判断是否使用原始表达式
  const rawExp = exp.loc.source
  const expString =
    exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : rawExp

  // im SFC <script setup> inline mode, the exp may have been transformed into
  // _unref(exp)
  // SFC <script setup> 内联模式下， 表达式可能已经转换成 _unref(exp)
  const bindingType = context.bindingMetadata[rawExp]
  // 可能是ref绑定
  const maybeRef =
    !__BROWSER__ &&
    context.inline &&
    bindingType &&
    bindingType !== BindingTypes.SETUP_CONST

  if (
    !expString.trim() ||
    (!isMemberExpression(expString, context) && !maybeRef)
  ) {
    // 空表达式 或者 不是一个成员表达式且不是一个可能的ref
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_MALFORMED_EXPRESSION, exp.loc)
    )
    return createTransformProps()
  }

  if (
    !__BROWSER__ &&
    context.prefixIdentifiers &&
    isSimpleIdentifier(expString) &&
    context.identifiers[expString]
  ) {
    // 非浏览器环境下，并且开启了前缀标识符，并且表达式是一个简单的标识符，并且这个标识符在标识符表中
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_ON_SCOPE_VARIABLE, exp.loc)
    )
    return createTransformProps()
  }

  // 创建v-model派发的事件名称 如果arg存在，则使用arg，否则使用默认的moudleValue事件名称
  const propName = arg ? arg : createSimpleExpression('modelValue', true)
  const eventName = arg
    ? isStaticExp(arg)
      ? `onUpdate:${arg.content}`
      : createCompoundExpression(['"onUpdate:" + ', arg])
    : `onUpdate:modelValue`

  let assignmentExp: ExpressionNode
  // 创建事件参数
  const eventArg = context.isTS ? `($event: any)` : `$event`
  if (maybeRef) {
    if (bindingType === BindingTypes.SETUP_REF) {
      // v-model used on known ref.
      // 确定是v-model使用的是ref绑定
      assignmentExp = createCompoundExpression([
        `${eventArg} => ((`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event)`
      ])
    } else {
      // v-model used on a potentially ref binding in <script setup> inline mode.
      // the assignment needs to check whether the binding is actually a ref.
      // v-model 使用了潜在的ref绑定在<script setup>内联模式下
      // 赋值需要检查绑定是否实际上是一个ref
      const altAssignment =
        bindingType === BindingTypes.SETUP_LET ? `${rawExp} = $event` : `null`
      assignmentExp = createCompoundExpression([
        `${eventArg} => (${context.helperString(IS_REF)}(${rawExp}) ? (`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event : ${altAssignment})`
      ])
    }
  } else {
    // 不是可能的ref
    assignmentExp = createCompoundExpression([
      `${eventArg} => ((`,
      exp,
      `) = $event)`
    ])
  }

  const props = [
    // modelValue: foo
    // 创建modelValue属性
    createObjectProperty(propName, dir.exp!),
    // "onUpdate:modelValue": $event => (foo = $event)
    // 创建事件属性
    createObjectProperty(eventName, assignmentExp)
  ]

  // cache v-model handler if applicable (when it doesn't refer any scope vars)
  // 缓存v-model 处理程序 如果适用，当没有任何引用范围变量时
  if (
    !__BROWSER__ &&
    context.prefixIdentifiers &&
    !context.inVOnce &&
    context.cacheHandlers &&
    !hasScopeRef(exp, context.identifiers)
  ) {
    props[1].value = context.cache(props[1].value)
  }

  // modelModifiers: { foo: true, "bar-baz": true }
  if (dir.modifiers.length && node.tagType === ElementTypes.COMPONENT) {
    // model 修饰符应该变成一个对象
    // 如果修饰符带有一个简单的标识符 比如数字或者除了$以外的非单词字符 需要进行字符串化
    const modifiers = dir.modifiers
      .map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
      .join(`, `)
    // 创建modifiersKey 根据arg进行创建 arg为空时，直接使用modelModifiers作为key
    const modifiersKey = arg
      ? isStaticExp(arg)
        ? `${arg.content}Modifiers`
        : createCompoundExpression([arg, ' + "Modifiers"'])
      : `modelModifiers`
    props.push(
      createObjectProperty(
        modifiersKey,
        createSimpleExpression(
          `{ ${modifiers} }`,
          false,
          dir.loc,
          ConstantTypes.CAN_HOIST
        )
      )
    )
  }

  return createTransformProps(props)
}

function createTransformProps(props: Property[] = []) {
  return { props }
}
