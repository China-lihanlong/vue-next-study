import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { ElementNode, ForNode, IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

// 节点带有v-once指令 在该节点上下文中标记inVOnce为true
export const transformOnce: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    if (seen.has(node) || context.inVOnce) {
      return
    }
    // 缓存其node节点 下次相同节点进来可以直接退出
    seen.add(node)
    context.inVOnce = true
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      // 退出transform执行
      context.inVOnce = false
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) {
        // 缓存产生的代码
        cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */)
      }
    }
  }
}
