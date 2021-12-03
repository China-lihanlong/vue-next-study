// vue3中可能会出现的节点类型
export const enum ShapeFlags {
  ELEMENT = 1, // 元素
  FUNCTIONAL_COMPONENT = 1 << 1, // 函数式组件
  STATEFUL_COMPONENT = 1 << 2, // 有状态的组件
  TEXT_CHILDREN = 1 << 3, // 文本子元素
  ARRAY_CHILDREN = 1 << 4, // 数组子元素(有多个子元素)
  SLOTS_CHILDREN = 1 << 5, // 插槽子元素
  TELEPORT = 1 << 6, // 组成应用程序UI的树
  SUSPENSE = 1 << 7, // 这是一个在异步组件解析时渲染的后备内容
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8, // 这是将要缓存的组件
  COMPONENT_KEPT_ALIVE = 1 << 9, // 路由缓存了的组件
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT // 组件(包含函数式组件和有状态的组件)
}
