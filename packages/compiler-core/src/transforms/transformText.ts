import { NodeTransform } from '../transform'
import {
  NodeTypes,
  CompoundExpressionNode,
  createCallExpression,
  CallExpression,
  ElementTypes,
  ConstantTypes
} from '../ast'
import { isText } from '../utils'
import { CREATE_TEXT } from '../runtimeHelpers'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getConstantType } from './hoistStatic'

// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
// 将相邻的和文本的表达式和文本合并为单个表达式
// 比如 <div>abc{{exp1}} {{exp2}}</div> 应该有一个表达式节点作为子节点
export const transformText: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ROOT ||
    node.type === NodeTypes.ELEMENT ||
    node.type === NodeTypes.FOR ||
    node.type === NodeTypes.IF_BRANCH
  ) {
    // perform the transform on node exit so that all expressions have already
    // been processed.
    // 在节点转换退出时执行 确保所有表达式已经被处理
    return () => {
      const children = node.children
      // 当前容器 存储合并后的表达式
      let currentContainer: CompoundExpressionNode | undefined = undefined
      let hasText = false

      for (let i = 0; i < children.length; i++) {
        // 从第一个开始找 如果是文本或者插值表达式 进入
        const child = children[i]
        if (isText(child)) {
          hasText = true
          // 从child[i]后一个开始 必须也要是文本或者表达式
          for (let j = i + 1; j < children.length; j++) {
            const next = children[j]
            if (isText(next)) {
              // 在currentContainer和children[i]赋值上COMPOUND_EXPRESSION
              if (!currentContainer) {
                currentContainer = children[i] = {
                  type: NodeTypes.COMPOUND_EXPRESSION,
                  loc: child.loc,
                  children: [child]
                }
              }
              // merge adjacent text node into current
              // 将相邻的表达式合并到当前容器中 结构类似：[exp1， '+', exp2]
              currentContainer.children.push(` + `, next)
              // 移除children[j] j--
              children.splice(j, 1)
              j--
            } else {
              // 匹配children[i]到不是文本或者表达式 
              // 置空currentContainer 跳出循环 去找下一个children[i]
              currentContainer = undefined
              break
            }
          }
        }
      }

      if (
        !hasText ||
        // if this is a plain element with a single text child, leave it
        // as-is since the runtime has dedicated fast path for this by directly
        // setting textContent of the element.
        // for component root it's always normalized anyway.
        // 如果这是一个带有普通文本的普通元素，请保留它
        // 因为运行时直接为这一点提供了快速通道：设置元素的文本内容
        // 对于 component root 它永远时规范化的
        (children.length === 1 &&
          (node.type === NodeTypes.ROOT ||
            (node.type === NodeTypes.ELEMENT &&
              node.tagType === ElementTypes.ELEMENT &&
              // #3756
              // custom directives can potentially add DOM elements arbitrarily,
              // we need to avoid setting textContent of the element at runtime
              // to avoid accidentally overwriting the DOM elements added
              // by the user through custom directives.
              // 自定义指令可以任意的添加DOM元素
              // 我们需要防止在运行时设置元素的textContent，
              // 避免用户通过自定义指令意外覆盖添加的DOM元素
              // 也就是children只有一个 并且(是根节点或(元素节点且元素标签且没有自定义指令))
              !node.props.find(
                p =>
                  p.type === NodeTypes.DIRECTIVE &&
                  !context.directiveTransforms[p.name]
              ) &&
              // in compat mode, <template> tags with no special directives
              // will be rendered as a fragment so its children must be
              // converted into vnodes.
              // 在兼容模式下，<template> 标签上没有特殊指令
              // 将它渲染成Fragment 所以它的子节点必须是vnode
              !(__COMPAT__ && node.tag === 'template'))))
      ) {
        return
      }

      // pre-convert text nodes into createTextVNode(text) calls to avoid
      // runtime normalization.
      // 将文本节点转换成createTextVNode调用 避免运行时规范化
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isText(child) || child.type === NodeTypes.COMPOUND_EXPRESSION) {
          const callArgs: CallExpression['arguments'] = []
          // createTextVNode defaults to single whitespace, so if it is a
          // single space the code could be an empty call to save bytes.
          // createTextVNode默认是单个空格 因此如果它是单空格代码可以是一个
          // 空调用来保存字节
          if (child.type !== NodeTypes.TEXT || child.content !== ' ') {
            callArgs.push(child)
          }
          // mark dynamic text with flag so it gets patched inside a block
          // 获取文本的ConstantTypes 如果是NOT_CONSTANT
          // 使用flag标记动态文本 便于在块中进行patch
          if (
            !context.ssr &&
            getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
          ) {
            callArgs.push(
              PatchFlags.TEXT +
                (__DEV__ ? ` /* ${PatchFlagNames[PatchFlags.TEXT]} */` : ``)
            )
          }
          // 构建对象
          children[i] = {
            type: NodeTypes.TEXT_CALL,
            content: child,
            loc: child.loc,
            codegenNode: createCallExpression(
              context.helper(CREATE_TEXT),
              callArgs
            )
          }
        }
      }
    }
  }
}
