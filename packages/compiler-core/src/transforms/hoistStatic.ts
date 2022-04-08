import {
  ConstantTypes,
  RootNode,
  NodeTypes,
  TemplateChildNode,
  SimpleExpressionNode,
  ElementTypes,
  PlainElementNode,
  ComponentNode,
  TemplateNode,
  VNodeCall,
  ParentNode,
  JSChildNode,
  CallExpression,
  createArrayExpression
} from '../ast'
import { TransformContext } from '../transform'
import { PatchFlags, isString, isSymbol, isArray } from '@vue/shared'
import { getVNodeBlockHelper, getVNodeHelper, isSlotOutlet } from '../utils'
import {
  OPEN_BLOCK,
  GUARD_REACTIVE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_PROPS,
  NORMALIZE_STYLE
} from '../runtimeHelpers'

export function hoistStatic(root: RootNode, context: TransformContext) {
  walk(
    root,
    context,
    // Root node is unfortunately non-hoistable due to potential parent
    // fallthrough attributes.
    isSingleElementRoot(root, root.children[0])
  )
}

export function isSingleElementRoot(
  root: RootNode,
  child: TemplateChildNode
): child is PlainElementNode | ComponentNode | TemplateNode {
  const { children } = root
  return (
    children.length === 1 &&
    child.type === NodeTypes.ELEMENT &&
    !isSlotOutlet(child)
  )
}

function walk(
  node: ParentNode,
  context: TransformContext,
  doNotHoistNode: boolean = false
) {
  // Some transforms, e.g. transformAssetUrls from @vue/compiler-sfc, replaces
  // static bindings with expressions. These expressions are guaranteed to be
  // constant so they are still eligible for hoisting, but they are only
  // available at runtime and therefore cannot be evaluated ahead of time.
  // This is only a concern for pre-stringification (via transformHoist by
  // @vue/compiler-dom), but doing it here allows us to perform only one full
  // walk of the AST and allow `stringifyStatic` to stop walking as soon as its
  // stringification threshold is met.
  let canStringify = true

  const { children } = node
  const originalCount = children.length
  let hoistedCount = 0

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    // only plain elements & text calls are eligible for hoisting.
    if (
      child.type === NodeTypes.ELEMENT &&
      child.tagType === ElementTypes.ELEMENT
    ) {
      const constantType = doNotHoistNode
        ? ConstantTypes.NOT_CONSTANT
        : getConstantType(child, context)
      if (constantType > ConstantTypes.NOT_CONSTANT) {
        if (constantType < ConstantTypes.CAN_STRINGIFY) {
          canStringify = false
        }
        if (constantType >= ConstantTypes.CAN_HOIST) {
          ;(child.codegenNode as VNodeCall).patchFlag =
            PatchFlags.HOISTED + (__DEV__ ? ` /* HOISTED */` : ``)
          child.codegenNode = context.hoist(child.codegenNode!)
          hoistedCount++
          continue
        }
      } else {
        // node may contain dynamic children, but its props may be eligible for
        // hoisting.
        const codegenNode = child.codegenNode!
        if (codegenNode.type === NodeTypes.VNODE_CALL) {
          const flag = getPatchFlag(codegenNode)
          if (
            (!flag ||
              flag === PatchFlags.NEED_PATCH ||
              flag === PatchFlags.TEXT) &&
            getGeneratedPropsConstantType(child, context) >=
              ConstantTypes.CAN_HOIST
          ) {
            const props = getNodeProps(child)
            if (props) {
              codegenNode.props = context.hoist(props)
            }
          }
          if (codegenNode.dynamicProps) {
            codegenNode.dynamicProps = context.hoist(codegenNode.dynamicProps)
          }
        }
      }
    } else if (child.type === NodeTypes.TEXT_CALL) {
      const contentType = getConstantType(child.content, context)
      if (contentType > 0) {
        if (contentType < ConstantTypes.CAN_STRINGIFY) {
          canStringify = false
        }
        if (contentType >= ConstantTypes.CAN_HOIST) {
          child.codegenNode = context.hoist(child.codegenNode)
          hoistedCount++
        }
      }
    }

    // walk further
    if (child.type === NodeTypes.ELEMENT) {
      const isComponent = child.tagType === ElementTypes.COMPONENT
      if (isComponent) {
        context.scopes.vSlot++
      }
      walk(child, context)
      if (isComponent) {
        context.scopes.vSlot--
      }
    } else if (child.type === NodeTypes.FOR) {
      // Do not hoist v-for single child because it has to be a block
      walk(child, context, child.children.length === 1)
    } else if (child.type === NodeTypes.IF) {
      for (let i = 0; i < child.branches.length; i++) {
        // Do not hoist v-if single child because it has to be a block
        walk(
          child.branches[i],
          context,
          child.branches[i].children.length === 1
        )
      }
    }
  }

  if (canStringify && hoistedCount && context.transformHoist) {
    context.transformHoist(children, context, node)
  }

  // all children were hoisted - the entire children array is hoistable.
  if (
    hoistedCount &&
    hoistedCount === originalCount &&
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    node.codegenNode &&
    node.codegenNode.type === NodeTypes.VNODE_CALL &&
    isArray(node.codegenNode.children)
  ) {
    node.codegenNode.children = context.hoist(
      createArrayExpression(node.codegenNode.children)
    )
  }
}

// 获取常量类型 
export function getConstantType(
  node: TemplateChildNode | SimpleExpressionNode,
  context: TransformContext
): ConstantTypes {
  const { constantCache } = context
  switch (node.type) {
    case NodeTypes.ELEMENT:
      // 元素节点类型但不是元素标记 返回NOT_CONSTANT
      if (node.tagType !== ElementTypes.ELEMENT) {
        return ConstantTypes.NOT_CONSTANT
      }
      // 去找静态内容缓存 找到了可以直接返回
      const cached = constantCache.get(node)
      if (cached !== undefined) {
        return cached
      }
      const codegenNode = node.codegenNode!
      // 元素节点类型但codegen不是vnode_call 返回NOT_CONSTANT
      if (codegenNode.type !== NodeTypes.VNODE_CALL) {
        return ConstantTypes.NOT_CONSTANT
      }
      // 获取patchFlag
      const flag = getPatchFlag(codegenNode)
      if (!flag) {
        // 默认是字符串化
        let returnType = ConstantTypes.CAN_STRINGIFY

        // Element itself has no patch flag. However we still need to check:
        // 元素本身没有 patch flag 然后我们仍然需要检查

        // 1. Even for a node with no patch flag, it is possible for it to contain
        // non-hoistable expressions that refers to scope variables, e.g. compiler
        // injected keys or cached event handlers. Therefore we need to always
        // check the codegenNode's props to be sure.
        // 即使对于没有 patch flag 也有可能引用不可提升的表达式，例如编译器注入的key或者缓存的事件处理程序
        // 因此我们需要检查codegen的props 来确保
        const generatedPropsType = getGeneratedPropsConstantType(node, context)
        if (generatedPropsType === ConstantTypes.NOT_CONSTANT) {
          // 获取到是NOT_CONSTANT 并且缓存且返回NOT_CONSTANT
          constantCache.set(node, ConstantTypes.NOT_CONSTANT)
          return ConstantTypes.NOT_CONSTANT
        }
        // 如果获取到的小于默认的，重新赋值默认的
        if (generatedPropsType < returnType) {
          returnType = generatedPropsType
        }

        // 2. its children.
        // 2. 它的children
        for (let i = 0; i < node.children.length; i++) {
          // 获取每一个元素的ConstantTypes 只有是NOT_CONSTANT 缓存之后返回
          //如果获取到的小于默认的，重新赋值默认的
          const childType = getConstantType(node.children[i], context)
          if (childType === ConstantTypes.NOT_CONSTANT) {
            constantCache.set(node, ConstantTypes.NOT_CONSTANT)
            return ConstantTypes.NOT_CONSTANT
          }
          if (childType < returnType) {
            returnType = childType
          }
        }

        // 3. if the type is not already CAN_SKIP_PATCH which is the lowest non-0
        // type, check if any of the props can cause the type to be lowered
        // we can skip can_patch because it's guaranteed by the absence of a
        // patchFlag.
        // 检查每一个元素上的bind指令，是否存在NOT_CONSTANT 如果存在缓存之后返回
        // 可以跳过patch 因为它没有patach flag
        if (returnType > ConstantTypes.CAN_SKIP_PATCH) {
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]
            if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.exp) {
              const expType = getConstantType(p.exp, context)
              if (expType === ConstantTypes.NOT_CONSTANT) {
                constantCache.set(node, ConstantTypes.NOT_CONSTANT)
                return ConstantTypes.NOT_CONSTANT
              }
              if (expType < returnType) {
                returnType = expType
              }
            }
          }
        }

        // only svg/foreignObject could be block here, however if they are
        // static then they don't need to be blocks since there will be no
        // nested updates.
        // 这里只有svg/foreignObject 可以阻止 因为它们是block
        // 如果他们是静态的，那么不会阻止 因为不会嵌套更新
        if (codegenNode.isBlock) {
          context.removeHelper(OPEN_BLOCK)
          context.removeHelper(
            getVNodeBlockHelper(context.inSSR, codegenNode.isComponent)
          )
          codegenNode.isBlock = false
          context.helper(getVNodeHelper(context.inSSR, codegenNode.isComponent))
        }

        constantCache.set(node, returnType)
        return returnType
      } else {
        // 拿到了patch flag 那肯定是NOT_CONSTANT 缓存后返回
        constantCache.set(node, ConstantTypes.NOT_CONSTANT)
        return ConstantTypes.NOT_CONSTANT
      }
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      // 文本 注释 返回CAN_STRINGIFY
      return ConstantTypes.CAN_STRINGIFY
    case NodeTypes.IF:
    case NodeTypes.FOR:
    case NodeTypes.IF_BRANCH:
      // if for if分支直接返回NOT_CONSTANT
      return ConstantTypes.NOT_CONSTANT
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      // 插值 text_call 需要再次确认
      return getConstantType(node.content, context)
    case NodeTypes.SIMPLE_EXPRESSION:
      // 稳定表达式返回自己本身的
      return node.constType
    case NodeTypes.COMPOUND_EXPRESSION:
      // 调用表达式 去确认child的Constant 遇到NOT_CONSTANT 缓存返回
      // 没有遇到 返回默认的
      let returnType = ConstantTypes.CAN_STRINGIFY
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (isString(child) || isSymbol(child)) {
          continue
        }
        const childType = getConstantType(child, context)
        if (childType === ConstantTypes.NOT_CONSTANT) {
          return ConstantTypes.NOT_CONSTANT
        } else if (childType < returnType) {
          returnType = childType
        }
      }
      return returnType
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      // 啥也没匹配到 默认返回NOT_CONSTANT
      return ConstantTypes.NOT_CONSTANT
  }
}

const allowHoistedHelperSet = new Set([
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  GUARD_REACTIVE_PROPS
])

function getConstantTypeOfHelperCall(
  value: CallExpression,
  context: TransformContext
): ConstantTypes {
  if (
    value.type === NodeTypes.JS_CALL_EXPRESSION &&
    !isString(value.callee) &&
    allowHoistedHelperSet.has(value.callee)
  ) {
    const arg = value.arguments[0] as JSChildNode
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      return getConstantType(arg, context)
    } else if (arg.type === NodeTypes.JS_CALL_EXPRESSION) {
      // in the case of nested helper call, e.g. `normalizeProps(guardReactiveProps(exp))`
      return getConstantTypeOfHelperCall(arg, context)
    }
  }
  return ConstantTypes.NOT_CONSTANT
}

// 获取道具的常量类型
function getGeneratedPropsConstantType(
  node: PlainElementNode,
  context: TransformContext
): ConstantTypes {
  let returnType = ConstantTypes.CAN_STRINGIFY
  const props = getNodeProps(node)
  if (props && props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    const { properties } = props
    for (let i = 0; i < properties.length; i++) {
      const { key, value } = properties[i]
      const keyType = getConstantType(key, context)
      if (keyType === ConstantTypes.NOT_CONSTANT) {
        return keyType
      }
      if (keyType < returnType) {
        returnType = keyType
      }
      let valueType: ConstantTypes
      if (value.type === NodeTypes.SIMPLE_EXPRESSION) {
        valueType = getConstantType(value, context)
      } else if (value.type === NodeTypes.JS_CALL_EXPRESSION) {
        // some helper calls can be hoisted,
        // such as the `normalizeProps` generated by the compiler for pre-normalize class,
        // in this case we need to respect the ConstantType of the helper's argments
        valueType = getConstantTypeOfHelperCall(value, context)
      } else {
        valueType = ConstantTypes.NOT_CONSTANT
      }
      if (valueType === ConstantTypes.NOT_CONSTANT) {
        return valueType
      }
      if (valueType < returnType) {
        returnType = valueType
      }
    }
  }
  return returnType
}

function getNodeProps(node: PlainElementNode) {
  const codegenNode = node.codegenNode!
  if (codegenNode.type === NodeTypes.VNODE_CALL) {
    return codegenNode.props
  }
}

function getPatchFlag(node: VNodeCall): number | undefined {
  const flag = node.patchFlag
  return flag ? parseInt(flag, 10) : undefined
}
