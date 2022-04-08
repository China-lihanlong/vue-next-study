import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression,
  ConstantTypes,
  createBlockStatement,
  createCompoundExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp,
  getVNodeBlockHelper,
  getVNodeHelper,
  findDir
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  FRAGMENT,
  IS_MEMO_SAME
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper, removeHelper } = context
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      // 现在创建循环渲染函数表达式 并在遍历所有子级后在退出函数中添加迭代器
      const renderExp = createCallExpression(helper(RENDER_LIST), [
        forNode.source
      ]) as ForRenderListExpression
      const memo = findDir(node, 'memo')
      const keyProp = findProp(node, `key`)
      // 创建key对象原型
      const keyExp =
        keyProp &&
        (keyProp.type === NodeTypes.ATTRIBUTE
          ? createSimpleExpression(keyProp.value!.content, true)
          : keyProp.exp!)
      const keyProperty = keyProp ? createObjectProperty(`key`, keyExp!) : null

      if (
        !__BROWSER__ &&
        context.prefixIdentifiers &&
        keyProperty &&
        keyProp!.type !== NodeTypes.ATTRIBUTE
      ) {
        // #2085 process :key expression needs to be processed in order for it
        // to behave consistently for <template v-for> and <div v-for>.
        // In the case of `<template v-for>`, the node is discarded and never
        // traversed so its key expression won't be processed by the normal
        // transforms.
        keyProperty.value = processExpression(
          keyProperty.value as SimpleExpressionNode,
          context
        )
      }

      const isStableFragment =
        forNode.source.type === NodeTypes.SIMPLE_EXPRESSION &&
        // forNode.source.constType 永远是 0 那么isStableFragment永远是false
        forNode.source.constType > ConstantTypes.NOT_CONSTANT
      const fragmentFlag = isStableFragment
        ? PatchFlags.STABLE_FRAGMENT
        : keyProp
        ? PatchFlags.KEYED_FRAGMENT
        : PatchFlags.UNKEYED_FRAGMENT

        // 创建codegenNode
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT),
        undefined,
        renderExp,
        fragmentFlag +
          (__DEV__ ? ` /* ${PatchFlagNames[fragmentFlag]} */` : ``),
        undefined,
        undefined,
        true /* isBlock */,
        !isStableFragment /* disableTracking */,
        false /* isComponent */,
        node.loc
      ) as ForCodegenNode

      return () => {
        // finish the codegen now that all children have been traversed
        let childBlock: BlockCodegenNode
        const isTemplate = isTemplateNode(node)
        const { children } = forNode

        // check <template v-for> key placement
        if ((__DEV__ || !__BROWSER__) && isTemplate) {
          node.children.some(c => {
            if (c.type === NodeTypes.ELEMENT) {
              const key = findProp(c, 'key')
              if (key) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                    key.loc
                  )
                )
                return true
              }
            }
          })
        }

        const needFragmentWrapper =
          children.length !== 1 || children[0].type !== NodeTypes.ELEMENT
          // 寻找插槽出口 <slot/> 没找到就是null
        const slotOutlet = isSlotOutlet(node)
          ? node
          : isTemplate &&
            node.children.length === 1 &&
            isSlotOutlet(node.children[0])
          ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
          : null

        if (slotOutlet) {
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            // 需要往renderSlot注入key renderSlot的第三个参数
            injectProp(childBlock, keyProperty, context)
          }
        } else if (needFragmentWrapper) {
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          // 对于文本或者多元素，应为每个循环生成一个Fragment
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children,
            PatchFlags.STABLE_FRAGMENT +
              (__DEV__
                ? ` /* ${PatchFlagNames[PatchFlags.STABLE_FRAGMENT]} */`
                : ``),
            undefined,
            undefined,
            true,
            undefined,
            false /* isComponent */
          )
        } else {
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          // 正常元素v-for 直接使用 children 的codegenNode 但是需要标记为block
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall
          if (isTemplate && keyProperty) {
            injectProp(childBlock, keyProperty, context)
          }
          if (childBlock.isBlock !== !isStableFragment) {
            if (childBlock.isBlock) {
              // 这里永远进不来
              // switch from block to vnode
              removeHelper(OPEN_BLOCK)
              removeHelper(
                getVNodeBlockHelper(context.inSSR, childBlock.isComponent)
              )
            } else {
              // switch from vnode to block
              // 删除在createVNodeCall的时添加的createElementNode 后面会调整为block
              removeHelper(
                getVNodeHelper(context.inSSR, childBlock.isComponent)
              )
            }
          }
          // 标记为block
          childBlock.isBlock = !isStableFragment
          if (childBlock.isBlock) {
            helper(OPEN_BLOCK)
            helper(getVNodeBlockHelper(context.inSSR, childBlock.isComponent))
          } else {
            helper(getVNodeHelper(context.inSSR, childBlock.isComponent))
          }
        }

        if (memo) {
          // v-for的元素带有v-memo
          // 创建循环
          const loop = createFunctionExpression(
            createForLoopParams(forNode.parseResult, [
              createSimpleExpression(`_cached`)
            ])
          )
          // 创建循环主体 注意，这里的v-memo已经被transformMemo处理过了
          loop.body = createBlockStatement([
            createCompoundExpression([`const _memo = (`, memo.exp!, `)`]),
            createCompoundExpression([
              `if (_cached`,
              ...(keyExp ? [` && _cached.key === `, keyExp] : []),
              ` && ${context.helperString(
                IS_MEMO_SAME
              )}(_cached, _memo)) return _cached`
            ]),
            createCompoundExpression([`const _item = `, childBlock as any]),
            createSimpleExpression(`_item.memo = _memo`),
            createSimpleExpression(`return _item`)
          ])
          // renderList 添加参数
          renderExp.arguments.push(
            loop as ForIteratorExpression,
            createSimpleExpression(`_cache`),
            createSimpleExpression(String(context.cached++))
          )
        } else {
          // 只有v-for
          renderExp.arguments.push(
            createFunctionExpression(
              createForLoopParams(forNode.parseResult),
              childBlock,
              true /* force newline */
            ) as ForIteratorExpression
          )
        }
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {
  // 表达式不存在 直接报错 并退出
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  // 解析v-for指令表达式
  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode,
    context
  )

  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  const { addIdentifiers, removeIdentifiers, scopes } = context
  const { source, value, key, index } = parseResult

  // forNode 并替换的原本的Node
  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,
    objectIndexAlias: index,
    parseResult,
    children: isTemplateNode(node) ? node.children : [node]
  }

  context.replaceNode(forNode)

  // bookkeeping
  scopes.vFor++
  // 标记有一个vFor正在处理 在执行processFor的退出函数时移除 说明vFor处理完成
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  const onExit = processCodegen && processCodegen(forNode)

  return () => {
    // 标记作用域
    scopes.vFor--
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    if (onExit) onExit()
  }
}

// 匹配表达式中三个部分 (item, name index) in|of list
const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
// 匹配表达式前部分三个内容 值项、key项、索引项
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
// 匹配表达式中的括号
const stripParensRE = /^\(|\)$/g

export interface ForParseResult {
  source: ExpressionNode
  value: ExpressionNode | undefined
  key: ExpressionNode | undefined
  index: ExpressionNode | undefined
}

export function parseForExpression(
  input: SimpleExpressionNode,
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content
  // 匹配表达式
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  // LHS(item, index) RHS是 list
  const [, LHS, RHS] = inMatch

  // 解析结果
  const result: ForParseResult = {
    // srouce是"(item, index) in list"中的list
    source: createAliasExpression(
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined,
    key: undefined,
    index: undefined
  }
  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }

  // 如果是 (item, index) 那么请将括号去除 这里的结果是 "item, index"
  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  // 匹配位置
  const trimmedOffset = LHS.indexOf(valueContent)

  // 匹配是不是带着索引项和key项
  const iteratorMatch = valueContent.match(forIteratorRE)
  // "item, index" 分析程序
  if (iteratorMatch) {
    // 带着索引项 需要去匹配其中的值项 也就是 "item, index" 中的item
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    // 索引项
    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      // 创建别名表达式 是"(item, index) in list" 中的index
      result.key = createAliasExpression(loc, keyContent, keyOffset)
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    // 第三项 (item, name, index) in list
    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        // 创建别名表达式
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  // 处理值项
  if (valueContent) {
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

function createAliasExpression(
  range: SourceLocation,
  content: string,
  offset: number
): SimpleExpressionNode {
  return createSimpleExpression(
    content,
    false,
    getInnerRange(range, offset, content.length)
  )
}

export function createForLoopParams(
  { value, key, index }: ForParseResult,
  memoArgs: ExpressionNode[] = []
): ExpressionNode[] {
  return createParamsList([value, key, index, ...memoArgs])
}

function createParamsList(
  args: (ExpressionNode | undefined)[]
): ExpressionNode[] {
  let i = args.length
  while (i--) {
    if (args[i]) break
  }
  // 完成参数 防止报错 根据索引大小添加 _
  return args
    .slice(0, i + 1)
    .map((arg, i) => arg || createSimpleExpression(`_`.repeat(i + 1), false))
}
