import { DirectiveTransform } from '../transform'
import {
  createObjectProperty,
  createSimpleExpression,
  ExpressionNode,
  NodeTypes
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'

// v-bind without arg is handled directly in ./transformElements.ts due to it affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
// 没有带有arg的v-bind指令在transformElememnt中处理，因为他会影响到整个props对象
// 这里的转换只适用于带有arg的
export const transformBind: DirectiveTransform = (dir, _node, context) => {
  const { exp, modifiers, loc } = dir
  const arg = dir.arg!

  if (arg.type !== NodeTypes.SIMPLE_EXPRESSION) {
    // 这里需要是带有前缀模式 浏览器并不支持前缀模式
    arg.children.unshift(`(`)
    arg.children.push(`) || ""`)
  } else if (!arg.isStatic) {
    // 不是静态的 拼成或短路语句
    arg.content = `${arg.content} || ""`
  }

  // .sync is replaced by v-model:arg
  // .sync修饰符被v-model
  if (modifiers.includes('camel')) {
    // 带有camel修饰符 如果arg是静态的 请进行驼峰化
    // 不是静态的那么请在渲染函数运行时驼峰化
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        arg.content = camelize(arg.content)
      } else {
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }

  if (!context.inSSR) {
    // 添加对应前缀 .是设置为prop ^是设置为attr
    if (modifiers.includes('prop')) {
      injectPrefix(arg, '.')
    }
    if (modifiers.includes('attr')) {
      injectPrefix(arg, '^')
    }
  }

  // 表达式存在 默认返回空表达式 并报错
  if (
    !exp ||
    (exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content.trim())
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc))
    return {
      props: [createObjectProperty(arg, createSimpleExpression('', true, loc))]
    }
  }

  // 返回props
  return {
    props: [createObjectProperty(arg, exp)]
  }
}

// 注入前缀
const injectPrefix = (arg: ExpressionNode, prefix: string) => {
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    // 稳定表达式且是静态的可以直接字符串拼接
    if (arg.isStatic) {
      arg.content = prefix + arg.content
    } else {
      // 如果不是静态的则需要拼接成模板字符串
      arg.content = `\`${prefix}\${${arg.content}}\``
    }
  } else {
    arg.children.unshift(`'${prefix}' + (`)
    arg.children.push(`)`)
  }
}
