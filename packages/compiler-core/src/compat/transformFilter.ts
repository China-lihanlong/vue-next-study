import { RESOLVE_FILTER } from '../runtimeHelpers'
import {
  AttributeNode,
  DirectiveNode,
  NodeTransform,
  NodeTypes,
  SimpleExpressionNode,
  toValidAssetId,
  TransformContext
} from '@vue/compiler-core'
import {
  CompilerDeprecationTypes,
  isCompatEnabled,
  warnDeprecation
} from './compatConfig'
import { ExpressionNode } from '../ast'

const validDivisionCharRE = /[\w).+\-_$\]]/

export const transformFilter: NodeTransform = (node, context) => {
  // 检查编译器是否兼容filter
  if (!isCompatEnabled(CompilerDeprecationTypes.COMPILER_FILTERS, context)) {
    return
  }

  if (node.type === NodeTypes.INTERPOLATION) {
    // filter rewrite is applied before expression transform so only
    // simple expressions are possible at this stage
    // 过滤器在表达式transform之前应用，所以在此阶段只能使用简单的表达式
    rewriteFilter(node.content, context)
  }

  if (node.type === NodeTypes.ELEMENT) {
    node.props.forEach((prop: AttributeNode | DirectiveNode) => {
      if (
        prop.type === NodeTypes.DIRECTIVE &&
        prop.name !== 'for' &&
        prop.exp
      ) {
        rewriteFilter(prop.exp, context)
      }
    })
  }
}

function rewriteFilter(node: ExpressionNode, context: TransformContext) {
  if (node.type === NodeTypes.SIMPLE_EXPRESSION) {
    parseFilter(node, context)
  } else {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (typeof child !== 'object') continue
      if (child.type === NodeTypes.SIMPLE_EXPRESSION) {
        parseFilter(child, context)
      } else if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
        rewriteFilter(node, context)
      } else if (child.type === NodeTypes.INTERPOLATION) {
        rewriteFilter(child.content, context)
      }
    }
  }
}

// 解析过滤器 将过滤器转换成表达式
function parseFilter(node: SimpleExpressionNode, context: TransformContext) {
  const exp = node.content
  // 是不是单引号
  let inSingle = false
  // 是不是双引号
  let inDouble = false
  // 是不是模板字符串
  let inTemplateString = false
  // 正则表达式？
  let inRegex = false
  // 打开的花括号的数量
  let curly = 0
  // 打开的中括号的数量
  let square = 0
  // 打开的小括号的数量
  let paren = 0
  let lastFilterIndex = 0
  let c,
    prev,
    i: number,
    expression,
    filters: string[] = []

  for (i = 0; i < exp.length; i++) {
    prev = c
    c = exp.charCodeAt(i)
    // 匹配到对应标识符的结束 代表关闭对应状态
    if (inSingle) {
      if (c === 0x27 && prev !== 0x5c) inSingle = false
    } else if (inDouble) {
      if (c === 0x22 && prev !== 0x5c) inDouble = false
    } else if (inTemplateString) {
      if (c === 0x60 && prev !== 0x5c) inTemplateString = false
    } else if (inRegex) {
      if (c === 0x2f && prev !== 0x5c) inRegex = false
    } else if (
      c === 0x7c && // pipe
      exp.charCodeAt(i + 1) !== 0x7c &&
      exp.charCodeAt(i - 1) !== 0x7c &&
      !curly &&
      !square &&
      !paren
    ) {
      // 匹配到竖线 说明一个表达式结束 请将其放入filters数组中
      if (expression === undefined) {
        // first filter, end of expression
        lastFilterIndex = i + 1
        expression = exp.slice(0, i).trim()
      } else {
        pushFilter()
      }
    } else {
      // 匹配对应的标识进行操作
      // 比如匹配到{ 表示进入花括号状态 并且打开的花括号的数量加一 curly++
      // 如果后面匹配到} 表示退出花括号状态 并且打开的花括号的数量减一 curly--
      switch (c) {
        case 0x22:
          inDouble = true
          break // "
        case 0x27:
          inSingle = true
          break // '
        case 0x60:
          inTemplateString = true
          break // `
        case 0x28:
          paren++
          break // (
        case 0x29:
          paren--
          break // )
        case 0x5b:
          square++
          break // [
        case 0x5d:
          square--
          break // ]
        case 0x7b:
          curly++
          break // {
        case 0x7d:
          curly--
          break // }
      }
      if (c === 0x2f) {
        // /
        // 匹配到 / 说明是正则 检查正则表达式
        let j = i - 1
        let p
        // find first non-whitespace prev char
        // 找到第一个非空格的前一个字符
        for (; j >= 0; j--) {
          p = exp.charAt(j)
          if (p !== ' ') break
        }
        // 如果前一个字符不是正则的开始符号
        // 则说明是正常的正则表达式
        // 如果只是 / 还不能说明是正则表达式
        if (!p || !validDivisionCharRE.test(p)) {
          inRegex = true
        }
      }
    }
  }

  if (expression === undefined) {
    expression = exp.slice(0, i).trim()
  } else if (lastFilterIndex !== 0) {
    pushFilter()
  }

  function pushFilter() {
    filters.push(exp.slice(lastFilterIndex, i).trim())
    lastFilterIndex = i + 1
  }

  if (filters.length) {
    __DEV__ &&
      warnDeprecation(
        CompilerDeprecationTypes.COMPILER_FILTERS,
        context,
        node.loc
      )
    for (i = 0; i < filters.length; i++) {
      expression = wrapFilter(expression, filters[i], context)
    }
    node.content = expression
  }
}

function wrapFilter(
  exp: string,
  filter: string,
  context: TransformContext
): string {
  context.helper(RESOLVE_FILTER)
  const i = filter.indexOf('(')
  if (i < 0) {
    // 没有出现括号，不是filter() 直接处理filter名称后返回
    context.filters!.add(filter)
    return `${toValidAssetId(filter, 'filter')}(${exp})`
  } else {
    // 出现括号 需要处理参数再返回
    const name = filter.slice(0, i)
    const args = filter.slice(i + 1)
    // exp存在则是 filterName(exp, arg)
    // 不存在则是 filterName(arg)
    context.filters!.add(name)
    return `${toValidAssetId(name, 'filter')}(${exp}${
      args !== ')' ? ',' + args : args
    }`
  }
}
