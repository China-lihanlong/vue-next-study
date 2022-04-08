import {
  transformOn as baseTransform,
  DirectiveTransform,
  createObjectProperty,
  createCallExpression,
  createSimpleExpression,
  NodeTypes,
  createCompoundExpression,
  ExpressionNode,
  SimpleExpressionNode,
  isStaticExp,
  CompilerDeprecationTypes,
  TransformContext,
  SourceLocation,
  checkCompatEnabled
} from '@vue/compiler-core'
import { V_ON_WITH_MODIFIERS, V_ON_WITH_KEYS } from '../runtimeHelpers'
import { makeMap, capitalize } from '@vue/shared'

// 判断是否是为事件选项修饰符
const isEventOptionModifier = /*#__PURE__*/ makeMap(`passive,once,capture`)
// 判断是不是非关键修饰符
const isNonKeyModifier = /*#__PURE__*/ makeMap(
  // event propagation management
  // 事件传播管理
  `stop,prevent,self,` +
    // system modifiers + exact
    // 系统修改器 + 精确
    `ctrl,shift,alt,meta,exact,` +
    // mouse
    // 鼠标
    `middle`
)
// left & right could be mouse or key modifiers based on event type
// left 和 right可以是基于事件类型的鼠标或者键的修饰符
const maybeKeyModifier = /*#__PURE__*/ makeMap('left,right')
// 判断是不是键盘事件
const isKeyboardEvent = /*#__PURE__*/ makeMap(
  `onkeyup,onkeydown,onkeypress`,
  true
)

const resolveModifiers = (
  key: ExpressionNode,
  modifiers: string[],
  context: TransformContext,
  loc: SourceLocation
) => {
  // 键盘事件修饰符
  const keyModifiers = []
  // 非键盘事件修饰符
  const nonKeyModifiers = []
  // 事件选项修饰符
  const eventOptionModifiers = []

  // 遍历修饰符数组
  for (let i = 0; i < modifiers.length; i++) {
    const modifier = modifiers[i]

    // 是否兼容模式 在v3中.native修饰符已经被移除
    if (
      __COMPAT__ &&
      modifier === 'native' &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_ON_NATIVE,
        context,
        loc
      )
    ) {
      // .native兼容 归为事件选项修饰符
      eventOptionModifiers.push(modifier)
    } else if (isEventOptionModifier(modifier)) {
      // eventOptionModifiers: modifiers for addEventListener() options,
      // 事件选项修饰符：是yongyuaddEventListener()选项的修饰符
      // e.g. .passive & .capture
      // 比如.passive & .capture
      eventOptionModifiers.push(modifier)
    } else {
      // runtimeModifiers: modifiers that needs runtime guards
      // 运行时的修饰符：需要运行时保护的修饰符
      if (maybeKeyModifier(modifier)) {
        // maybeKeyModifier: 匹配的时.right,.left修饰符
        // 判断是不是静态表达式
        if (isStaticExp(key)) {
          // 判断是不是键盘事件 是键盘事件就添加到键盘修饰符数组中
          // 否则添加到非键盘修饰符数组中
          if (isKeyboardEvent((key as SimpleExpressionNode).content)) {
            keyModifiers.push(modifier)
          } else {
            nonKeyModifiers.push(modifier)
          }
        } else {
          // 不是静态表达式 键盘修饰符数组和非键盘修饰符数组都添加
          keyModifiers.push(modifier)
          nonKeyModifiers.push(modifier)
        }
      } else {
        // 其他运行时需要保护的指令
        if (isNonKeyModifier(modifier)) {
          // 其他非键盘事件修饰符
          nonKeyModifiers.push(modifier)
        } else {
          // 其他键盘事件修饰符
          keyModifiers.push(modifier)
        }
      }
    }
  }

  return {
    keyModifiers,
    nonKeyModifiers,
    eventOptionModifiers
  }
}

// 修正click事件修饰符
const transformClick = (key: ExpressionNode, event: string) => {
  // 判断是不是静态Click事件
  const isStaticClick =
    isStaticExp(key) && key.content.toLowerCase() === 'onclick'
  return isStaticClick
  // 如果是静态click事件 就修正事件
    ? createSimpleExpression(event, true)
    : key.type !== NodeTypes.SIMPLE_EXPRESSION
    // 如果不是静态的click event 就进行判断，如果不是click event就返回原本的event
    ? createCompoundExpression([
        `(`,
        key,
        `) === "onClick" ? "${event}" : (`,
        key,
        `)`
      ])
    : key
}

export const transformOn: DirectiveTransform = (dir, node, context) => {
  return baseTransform(dir, node, context, baseResult => {
    // 处理修饰符
    const { modifiers } = dir
    // 没有修饰符 则直接返回
    if (!modifiers.length) return baseResult

    let { key, value: handlerExp } = baseResult.props[0]
    // 确认修饰符 区分键盘事件修饰符和非键盘事件修饰符以及事件选项修饰符
    const { keyModifiers, nonKeyModifiers, eventOptionModifiers } =
      resolveModifiers(key, modifiers, context, dir.loc)

    // normalize click.right and click.middle since they don't actually fire
    // 修正click.right和click.middle, 因为它们实际上并不会触发
    // 需要修正为正确的事件名称
    // 如果是right => onContextmenu middle => onMouseup
    if (nonKeyModifiers.includes('right')) {
      key = transformClick(key, `onContextmenu`)
    }
    if (nonKeyModifiers.includes('middle')) {
      key = transformClick(key, `onMouseup`)
    }

    if (nonKeyModifiers.length) {
      // 创建助手函数调用表达式 参数是hanlderExp和nonKeyModifiers
      handlerExp = createCallExpression(context.helper(V_ON_WITH_MODIFIERS), [
        handlerExp,
        JSON.stringify(nonKeyModifiers)
      ])
    }

    if (
      keyModifiers.length &&
      // if event name is dynamic, always wrap with keys guard
      // 如果事件名称是动态的，请始终使用动态key换行
      // 注入助手函数vOnKeysGuard
      (!isStaticExp(key) || isKeyboardEvent(key.content))
    ) {
      handlerExp = createCallExpression(context.helper(V_ON_WITH_KEYS), [
        handlerExp,
        JSON.stringify(keyModifiers)
      ])
    }

    if (eventOptionModifiers.length) {
      // 修饰符大驼峰化 并用空字符拼成字符串 如：['once', 'capture'] => 'OnceCapture'
      const modifierPostfix = eventOptionModifiers.map(capitalize).join('')
      // 根据key的情况 和key进行拼接
      key = isStaticExp(key)
        ? createSimpleExpression(`${key.content}${modifierPostfix}`, true)
        : createCompoundExpression([`(`, key, `) + "${modifierPostfix}"`])
    }

    // 最后返回有个对象
    return {
      props: [createObjectProperty(key, handlerExp)]
    }
  })
}
