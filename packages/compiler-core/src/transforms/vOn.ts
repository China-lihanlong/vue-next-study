import { DirectiveTransform, DirectiveTransformResult } from '../transform'
import {
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  SimpleExpressionNode
} from '../ast'
import { camelize, toHandlerKey } from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { hasScopeRef, isMemberExpression } from '../utils'
import { TO_HANDLER_KEY } from '../runtimeHelpers'

// 匹配是不是函数表达式
const fnExpRE =
  /^\s*([\w$_]+|(async\s*)?\([^)]*?\))\s*=>|^\s*(async\s+)?function(?:\s+[\w$]+)?\s*\(/

export interface VOnDirectiveNode extends DirectiveNode {
  // v-on without arg is handled directly in ./transformElements.ts due to it affecting
  // codegen for the entire props object. This transform here is only for v-on
  // *with* args.
  arg: ExpressionNode
  // exp is guaranteed to be a simple expression here because v-on w/ arg is
  // skipped by transformExpression as a special case.
  exp: SimpleExpressionNode | undefined
}

export const transformOn: DirectiveTransform = (
  dir,
  node,
  context,
  augmentor
) => {
  const { loc, modifiers, arg } = dir as VOnDirectiveNode
  // 表达式和修饰符必须有一个存在
  if (!dir.exp && !modifiers.length) {
    context.onError(createCompilerError(ErrorCodes.X_V_ON_NO_EXPRESSION, loc))
  }
  let eventName: ExpressionNode
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      const rawName = arg.content
      // for all event listeners, auto convert it to camelCase. See issue #2249
      // 将所有的事件监听器 都转换成统一格式：arg大驼峰化后在前面拼上"on"  比如 v-on:test-event 变成 onTestEvent
      // 应该工作的是onTestEvent
      eventName = createSimpleExpression(
        toHandlerKey(camelize(rawName)),
        true,
        arg.loc
      )
    } else {
      // #2388
      // 处理动态事件名
      eventName = createCompoundExpression([
        `${context.helperString(TO_HANDLER_KEY)}(`,
        arg,
        `)`
      ])
    }
  } else {
    // already a compound expression.
    // 已经是复合表达式(SSR)
    eventName = arg
    eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`)
    eventName.children.push(`)`)
  }

  // handler processing
  // 处理程序处理
  let exp: ExpressionNode | undefined = dir.exp as
    | SimpleExpressionNode
    | undefined
    // 处理程序不存在 默认undefined
  if (exp && !exp.content.trim()) {
    exp = undefined
  }
  // 应该缓存？
  let shouldCache: boolean = context.cacheHandlers && !exp && !context.inVOnce
  if (exp) {
    // 简单检查是不是MemberExpression
    const isMemberExp = isMemberExpression(exp.content, context)
    // fnExpRE.test(exp.content)：匹配时不是函数表达式
    // isInlineStatement：是不是内联语句
    const isInlineStatement = !(isMemberExp || fnExpRE.test(exp.content))
    // 存在多条语句？(判断是否存在分号)
    const hasMultipleStatements = exp.content.includes(`;`)

    // process the expression since it's been skipped
    // 在非浏览器模式且是前缀模式下 跳过已经解析过的表达式
    if (!__BROWSER__ && context.prefixIdentifiers) {
      isInlineStatement && context.addIdentifiers(`$event`)
      exp = dir.exp = processExpression(
        exp,
        context,
        false,
        hasMultipleStatements
      )
      isInlineStatement && context.removeIdentifiers(`$event`)
      // with scope analysis, the function is hoistable if it has no reference
      // to scope variables.
      // 根据作用域分析，函数可以提前声明，因为它没有引用到作用域变量
      shouldCache =
        context.cacheHandlers &&
        // unnecessary to cache inside v-once
        // 在v-once中不需要缓存
        !context.inVOnce &&
        // runtime constants don't need to be cached
        // (this is analyzed by compileScript in SFC <script setup>)
        // 运行时常量不需要缓存 这是通过编译SFC <script setup>中分析的来的
        !(exp.type === NodeTypes.SIMPLE_EXPRESSION && exp.constType > 0) &&
        // #1541 bail if this is a member exp handler passed to a component -
        // we need to use the original function to preserve arity,
        // e.g. <transition> relies on checking cb.length to determine
        // transition end handling. Inline function is ok since its arity
        // is preserved even when cached.
        // 如果时传递给组件的成员e表达式处理程序，那么我们需要使用原始函数来保持参数的一致性
        !(isMemberExp && node.tagType === ElementTypes.COMPONENT) &&
        // bail if the function references closure variables (v-for, v-slot)
        // it must be passed fresh to avoid stale values.
        // 如果函数引用闭包变量(v-for, v-slot)，则必须以新的方式传递它，以避免过时的值
        !hasScopeRef(exp, context.identifiers)
      // If the expression is optimizable and is a member expression pointing
      // to a function, turn it into invocation (and wrap in an arrow function
      // below) so that it always accesses the latest value when called - thus
      // avoiding the need to be patched.
      // 如果表达式是可优化的，并且是指向函数的成员表达式，那么转换为调用(并在下面包装成箭头函数)
      // 因此调用时它总是访问最新值 避免进行patch
      if (shouldCache && isMemberExp) {
        if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          exp.content = `${exp.content} && ${exp.content}(...args)`
        } else {
          exp.children = [...exp.children, ` && `, ...exp.children, `(...args)`]
        }
      }
    }

    // 简答的浏览器表达式验证
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        exp as SimpleExpressionNode,
        context,
        false,
        hasMultipleStatements
      )
    }

    // 是内联语句或者(应该缓存且是MemberExp) 请包装成一个箭头函数
    if (isInlineStatement || (shouldCache && isMemberExp)) {
      // wrap inline statement in a function expression
      // 包装成一个箭头函数 现在还是数组
      exp = createCompoundExpression([
        `${
          isInlineStatement
            ? !__BROWSER__ && context.isTS
            // ts和jsx模式下的内联语句
              ? `($event: any)`
              : `$event`
            : `${
              // ts和jsx模式下的箭头函数
                !__BROWSER__ && context.isTS ? `\n//@ts-ignore\n` : ``
              }(...args)`
        } => ${hasMultipleStatements ? `{` : `(`}`,
        exp,
        hasMultipleStatements ? `}` : `)`
      ])
    }
  }

  // 事件绑定处理成props
  let ret: DirectiveTransformResult = {
    props: [
      createObjectProperty(
        eventName,
        //exp 不存在时，返回箭头函数
        exp || createSimpleExpression(`() => {}`, false, loc)
      )
    ]
  }

  // apply extended compiler augmentor
  // 扩展编译增强器
  if (augmentor) {
    ret = augmentor(ret)
  }

  if (shouldCache) {
    // cache handlers so that it's always the same handler being passed down.
    // this avoids unnecessary re-renders when users use inline handlers on
    // components.
    // 缓存处理程序，这样每次就不会重新渲染，当用户在组件上使用内联处理程序时。
    ret.props[0].value = context.cache(ret.props[0].value)
  }

  // mark the key as handler for props normalization check
  // 标记key为props正常化检查的处理程序
  // 因为在普通的props中，key是不会被解析的，所以我们需要标记它，以便在props规范化时
  // 我们可以知道他是一个事件处理程序
  ret.props.forEach(p => (p.key.isHandlerKey = true))
  // 返回结果
  return ret
}
