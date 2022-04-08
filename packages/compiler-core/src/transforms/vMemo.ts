import { NodeTransform } from '../transform'
import { findDir, makeBlock } from '../utils'
import {
  createCallExpression,
  createFunctionExpression,
  ElementTypes,
  MemoExpression,
  NodeTypes,
  PlainElementNode
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet()

export const transformMemo: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT) {
    // 缓存已经带有v-memo的节点 已经缓存过的不再缓存
    const dir = findDir(node, 'memo')
    if (!dir || seen.has(node)) {
      return
    }
    seen.add(node)
    return () => {
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        // 非组件子树应该变成一个块
        if (node.tagType !== ElementTypes.COMPONENT) {
          makeBlock(codegenNode, context)
        }
        // 包裹函数 withMemo
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!,
          createFunctionExpression(undefined, codegenNode),
          `_cache`,
          String(context.cached++)
        ]) as MemoExpression
      }
    }
  }
}
