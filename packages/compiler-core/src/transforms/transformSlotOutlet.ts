import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  CallExpression,
  createCallExpression,
  ExpressionNode,
  SlotOutletNode,
  createFunctionExpression
} from '../ast'
import { isSlotOutlet, isBindKey, isStaticExp } from '../utils'
import { buildProps, PropsExpression } from './transformElement'
import { createCompilerError, ErrorCodes } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'
import { camelize } from '@vue/shared/'

// 转换插槽出口
export const transformSlotOutlet: NodeTransform = (node, context) => {
  // 只有是<slot />才可以进入
  if (isSlotOutlet(node)) {
    const { children, loc } = node
    // 解析插槽出口 返回的是slotName和slotProps
    const { slotName, slotProps } = processSlotOutlet(node, context)

    // 产生slotArgs对象
    const slotArgs: CallExpression['arguments'] = [
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
      slotName,
      '{}',
      'undefined',
      'true'
    ]
    // 预期的参数数量 默认只会有$slots和slotName这两个实际参数
    let expectedLen = 2

    // slotProps存在 参数加一
    if (slotProps) {
      slotArgs[2] = slotProps
      expectedLen = 3
    }

    // 存在children 也就是备用内容 参数加一
    if (children.length) {
      slotArgs[3] = createFunctionExpression([], children, false, false, loc)
      expectedLen = 4
    }

    // 存在scopeId且没有使用 css :slotted伪类选择器
    // scopeId只存在SSR中
    if (context.scopeId && !context.slotted) {
      expectedLen = 5
    }
    // 移除没有使用到1参数
    slotArgs.splice(expectedLen) // remove unused arguments

    // 产生slot 的 codegenNode
    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

// 解析插槽出口
export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext
): SlotOutletProcessResult {
  // 默认认为是default插槽出口
  let slotName: string | ExpressionNode = `"default"`
  // 作用域插槽传递的props
  let slotProps: PropsExpression | undefined = undefined

  const nonNameProps = []
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    // 处理prop和attr
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.value) {
        // attr的value存在 name是'name' 说明是slotName 就会使用value字符串序列化之后做为slotName
        if (p.name === 'name') {
          slotName = JSON.stringify(p.value.content)
        } else {
          // 不是插槽名字的attr正常驼峰化名字后放入nonNameProps中
          p.name = camelize(p.name)
          nonNameProps.push(p)
        }
      }
    } else {
      // slotName也可能通过bind绑定 判断arg是name之后 拿到exp作为slotName
      if (p.name === 'bind' && isBindKey(p.arg, 'name')) {
        if (p.exp) slotName = p.exp
      } else {
        // 使用bind绑定的参数 且arg是静态的 那么需要进行驼峰化
        if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) {
          p.arg.content = camelize(p.arg.content)
        }
        nonNameProps.push(p)
      }
    }
  }

  // 存在作用域插槽传递
  if (nonNameProps.length > 0) {
    // 构建 props 得到slotProps
    const { props, directives } = buildProps(node, context, nonNameProps)
    slotProps = props

    // <slot /> 不支持运行时指令
    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc
        )
      )
    }
  }

  // 返回slotName和slotProps
  return {
    slotName,
    slotProps
  }
}
