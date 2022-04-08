import {
  createStructuralDirectiveTransform,
  TransformContext,
  traverseNode
} from '../transform'
import {
  NodeTypes,
  ElementTypes,
  ElementNode,
  DirectiveNode,
  IfBranchNode,
  SimpleExpressionNode,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  createObjectProperty,
  createObjectExpression,
  IfConditionalExpression,
  BlockCodegenNode,
  IfNode,
  createVNodeCall,
  AttributeNode,
  locStub,
  CacheExpression,
  ConstantTypes,
  MemoExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { FRAGMENT, CREATE_COMMENT } from '../runtimeHelpers'
import {
  injectProp,
  findDir,
  findProp,
  isBuiltInType,
  makeBlock
} from '../utils'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getMemoedVNodeCall } from '..'

export const transformIf = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  (node, dir, context) => {
    return processIf(node, dir, context, (ifNode, branch, isRoot) => {
      // #1587: We need to dynamically increment the key based on the current
      // node's sibling nodes, since chained v-if/else branches are
      // rendered at the same depth
      // 为多个同等级的v-if/else生成不同的key
      const siblings = context.parent!.children
      let i = siblings.indexOf(ifNode)
      let key = 0
      while (i-- >= 0) {
        const sibling = siblings[i]
        if (sibling && sibling.type === NodeTypes.IF) {
          key += sibling.branches.length
        }
      }

      // Exit callback. Complete the codegenNode when all children have been
      // 这里转换的是v-if，但是后面可能会有v-else-if v-else，需要解析完当前父节点的所有的子节点后再执行
      // transformed.
      return () => {
        if (isRoot) {
          ifNode.codegenNode = createCodegenNodeForBranch(
            branch,
            key,
            context
          ) as IfConditionalExpression
        } else {
          // attach this branch's codegen node to the v-if root.
          // 将此分支的codegen连接到v-if根
          const parentCondition = getParentCondition(ifNode.codegenNode!)
          parentCondition.alternate = createCodegenNodeForBranch(
            branch,
            key + ifNode.branches.length - 1,
            context
          )
        }
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processIf(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean
  ) => (() => void) | undefined
) {
  
  if (
    dir.name !== 'else' &&
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim())
  ) {
    // 不是v-else 却不带表达式 报错：出现错误的v-if表达式 并给一个默认表达式true
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc)
    )
    dir.exp = createSimpleExpression(`true`, false, loc)
  }

  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // 此转换适用于非浏览器版本
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (__DEV__ && __BROWSER__ && dir.exp) {
    // 浏览器内简单的表达式验证
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (dir.name === 'if') {
    // 进入这里说明是v-if
    // 创建ifNode 也就是根分支
    const branch = createIfBranch(node, dir)
    const ifNode: IfNode = {
      type: NodeTypes.IF,
      loc: node.loc,
      branches: [branch]
    }
    // 替换原始node
    context.replaceNode(ifNode)
    if (processCodegen) {
      // processCodegen 其实是transformIf中传递的函数，用于产生退出函数
      return processCodegen(ifNode, branch, true)
    }
  } else {
    // locate the adjacent v-if
    // 进入这里说明是v-else-if或者是v-else
    // 会试图找到最近的v-if
    const siblings = context.parent!.children
    const comments = []
    let i = siblings.indexOf(node)
    while (i-- >= -1) {
      // 往上找最近的v-if
      const sibling = siblings[i]
      if (__DEV__ && sibling && sibling.type === NodeTypes.COMMENT) {
        // 移除注释节点 并保存在comments中 后面根据情况重新放入分支的children中
        context.removeNode(sibling)
        comments.unshift(sibling)
        continue
      }

      if (
        sibling &&
        sibling.type === NodeTypes.TEXT &&
        !sibling.content.trim().length
      ) {
        // 文本节点是空文本直接删除
        context.removeNode(sibling)
        continue
      }

      if (sibling && sibling.type === NodeTypes.IF) {
        // Check if v-else was followed by v-else-if
        // 检查v-else后面是否跟着v-else-if
        if (
          dir.name === 'else-if' &&
          sibling.branches[sibling.branches.length - 1].condition === undefined
        ) {
          // v-if后面已经跟着v-else 不能再跟着v-else-if
          context.onError(
            createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
          )
        }

        // move the node to the if node's branches
        // 创建条件分支 并移动到if分支中
        context.removeNode()
        const branch = createIfBranch(node, dir)
        if (
          __DEV__ &&
          comments.length &&
          // #3619 ignore comments if the v-if is direct child of <transition>
          // 如果带有v-if的节点是<transform>的直接子级，请忽略注释节点
          // 不然请将注释节点重新放入分支中
          !(
            context.parent &&
            context.parent.type === NodeTypes.ELEMENT &&
            isBuiltInType(context.parent.tag, 'transition')
          )
        ) {
          branch.children = [...comments, ...branch.children]
        }

        // check if user is forcing same key on different branches
        // 检查用户是否在不同的分支强制使用相同的key
        if (__DEV__ || !__BROWSER__) {
          const key = branch.userKey
          if (key) {
            sibling.branches.forEach(({ userKey }) => {
              if (isSameKey(userKey, key)) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_IF_SAME_KEY,
                    branch.userKey!.loc
                  )
                )
              }
            })
          }
        }

        // 添加进根分支中
        sibling.branches.push(branch)
        // 执行processCodegen 产生属于这个分支的退出函数
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        // 分支已经从原先的地方删除 必须要进行遍历 进行转换分支
        traverseNode(branch, context)
        // call on exit
        // 因为已经确定自己归属那个分支 可以执行退出函数
        if (onExit) onExit()
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        context.currentNode = null
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
        )
      }
      break
    }
  }
}

function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp,
    children:
      node.tagType === ElementTypes.TEMPLATE && !findDir(node, 'for')
        ? node.children
        : [node],
    userKey: findProp(node, `key`)
  }
}

function createCodegenNodeForBranch(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): IfConditionalExpression | BlockCodegenNode | MemoExpression {
  if (branch.condition) {
    return createConditionalExpression(
      branch.condition,
      // 需要视情况看是否需要创建VNODE_CALL 最后返回的是VNODE_CALL
      createChildrenCodegenNode(branch, keyIndex, context),
      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      createCallExpression(context.helper(CREATE_COMMENT), [
        __DEV__ ? '"v-if"' : '""',
        'true'
      ])
    ) as IfConditionalExpression
  } else {
    return createChildrenCodegenNode(branch, keyIndex, context)
  }
}

function createChildrenCodegenNode(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): BlockCodegenNode | MemoExpression {
  const { helper } = context
  // 创建key原型
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(
      `${keyIndex}`,
      false,
      locStub,
      ConstantTypes.CAN_HOIST
    )
  )
  // v-if分支的children是带有v-if指令元素
  const { children } = branch
  const firstChild = children[0]
  // 是否需要Fragment容器
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT
  if (needFragmentWrapper) {
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) {
      // optimize away nested fragments when child is a ForNode
      // 子节点是v-for产生的嵌套fragment 进行优化
      // <template v-if="exp" v-for="item in list"></template>
      const vnodeCall = firstChild.codegenNode!
      // 注入分支key
      injectProp(vnodeCall, keyProperty, context)
      return vnodeCall
    } else {
      /*
        	<div v-for="item in list" :key="item.id">
			      <template v-if="exp" ></template>	
		      </div>
      */
      let patchFlag = PatchFlags.STABLE_FRAGMENT
      let patchFlagText = PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
      // check if the fragment actually contains a single valid child with
      // the rest being comments
      // 检查fragment中包含一个有效的子元素
      if (
        __DEV__ &&
        children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
      ) {
        patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
        patchFlagText += `, ${PatchFlagNames[PatchFlags.DEV_ROOT_FRAGMENT]}`
      }

      return createVNodeCall(
        context,
        helper(FRAGMENT),
        createObjectExpression([keyProperty]),
        children,
        patchFlag + (__DEV__ ? ` /* ${patchFlagText} */` : ``),
        undefined,
        undefined,
        true,
        false,
        false /* isComponent */,
        branch.loc
      )
    }
  } else {
    const ret = (firstChild as ElementNode).codegenNode as
      | BlockCodegenNode
      | MemoExpression
    // 可能带有v-mome指令
    const vnodeCall = getMemoedVNodeCall(ret)
    // Change createVNode to createBlock.
    // v-if的元素是一个block 将createVNode转换成createBlock
    if (vnodeCall.type === NodeTypes.VNODE_CALL) {
      makeBlock(vnodeCall, context)
    }
    // inject branch key
    // 注入分支 key
    injectProp(vnodeCall, keyProperty, context)
    return ret
  }
}

// 判断分支key是否相同
function isSameKey(
  a: AttributeNode | DirectiveNode | undefined,
  b: AttributeNode | DirectiveNode
): boolean {
  if (!a || a.type !== b.type) {
    return false
  }
  if (a.type === NodeTypes.ATTRIBUTE) {
    if (a.value!.content !== (b as AttributeNode).value!.content) {
      return false
    }
  } else {
    // directive
    const exp = a.exp!
    const branchExp = (b as DirectiveNode).exp!
    if (exp.type !== branchExp.type) {
      return false
    }
    if (
      exp.type !== NodeTypes.SIMPLE_EXPRESSION ||
      exp.isStatic !== (branchExp as SimpleExpressionNode).isStatic ||
      exp.content !== (branchExp as SimpleExpressionNode).content
    ) {
      return false
    }
  }
  return true
}

// 找到自己前面的分支
function getParentCondition(
  node: IfConditionalExpression | CacheExpression
): IfConditionalExpression {
  while (true) {
    if (node.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
      if (node.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
        node = node.alternate
      } else {
        return node
      }
    } else if (node.type === NodeTypes.JS_CACHE_EXPRESSION) {
      node = node.value as IfConditionalExpression
    }
  }
}
