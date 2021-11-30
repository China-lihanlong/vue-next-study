const isObject = (target) => {
  return typeof target === 'object' && target !== null
}

function reactive(target) {

  if (!isObject(target)) {
    return
  }

  return new Proxy(target, {
    get(target, key, receiver) {
      const res = Reflect.get(target, key, receiver)
      track(target, key)
      return isObject(res) ? reactive(res) : res

    },
    set(target, key, value, receiver) {
      const res = Reflect.set(target, key, value, receiver)
      trigger(target, key)
      return res
    },
    deleteProperty(target, key) {
      const res = Reflect.deleteProperty(target, key)
      trigger(target, key)
      return res
    }
  })
}

/* const state = reactive({ foo: 'foo', bar: { n: 100 } , arr: [1, 2, 3]})

state.arr.push(10)
console.log(state.arr) */

const stackEffect = []

function effect(fn) {
  const e = createReactiveEffect(fn)

  e()

  return e
}

function createReactiveEffect(fn) {
  const effect = function () {
    try {
      stackEffect.push(effect)
      return fn()
    } finally {
      stackEffect.pop()
    }
  }

  return effect
}

const targetMap = new WeakMap()

function track(target, key) {
  const effect = stackEffect[stackEffect.length - 1]

  if (!effect) {
    return
  }

  let depMap = targetMap.get(target)
  if (!depMap) {
    targetMap.set(target, (depMap = new Map()))
  }

  let deps = depMap.get(key)
  if (!deps) {
    depMap.set(key, (deps = new Set()))
  }

  deps.add(effect)
}

function trigger(target, key) {
  const depMap = targetMap.get(target)
  if (!depMap) {
    return
  }

  const deps = depMap.get(key)
  if (deps) {
    deps.forEach(dep => dep())
  }
}

const state = reactive({ foo: 'foo', bar: { n: 100 }, arr: [1, 2, 3] })

effect(() => {
  console.log(state.foo, 'fooo')
})

state.foo = 'foooo____'
