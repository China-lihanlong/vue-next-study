const _Vue = Vue
const { createElementVNode: _createElementVNode } = _Vue

const _hoisted_1 = { id: "app" }
const _hoisted_2 = ["onClick"]

return function render(_ctx, _cache, $props, $setup, $data, $options) {
  with (_ctx) {
    const { toDisplayString: _toDisplayString, createElementVNode: _createElementVNode, openBlock: _openBlock, createElementBlock: _createElementBlock } = _Vue

    return (_openBlock(), _createElementBlock("div", _hoisted_1, [
      _createElementVNode("p", { onClick: addCount }, _toDisplayString(count), 9 /* TEXT, PROPS */, _hoisted_2)
    ]))
  }
}

// Check the console for the AST