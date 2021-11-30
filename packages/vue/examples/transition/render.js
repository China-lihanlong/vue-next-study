(function anonymous(
) {
const _Vue = Vue

return function render(_ctx, _cache) {
  with (_ctx) {
    const { createCommentVNode: _createCommentVNode, toDisplayString: _toDisplayString, renderList: _renderList, Fragment: _Fragment, openBlock: _openBlock, createElementBlock: _createElementBlock, createElementVNode: _createElementVNode, createTextVNode: _createTextVNode } = _Vue

    return (_openBlock(), _createElementBlock(_Fragment, null, [
      _createCommentVNode("  {{foo}} -- {{bar}}\n  <ul>\n    <li v-for=\"arr in arrs\" :key=\"arr.id\">\n      {{ arr }}\n    </li>\n  </ul> "),
      _createTextVNode(_toDisplayString(count) + " ", 1 /* TEXT */),
      _createElementVNode("ul", null, [
        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(data, (item) => {
          return (_openBlock(), _createElementBlock("li", { key: item }, _toDisplayString(item), 1 /* TEXT */))
        }), 128 /* KEYED_FRAGMENT */))
      ])
    ], 64 /* STABLE_FRAGMENT */))
  }
}
})