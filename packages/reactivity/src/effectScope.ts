import { ReactiveEffect } from './effect'
import { warn } from './warning'

let activeEffectScope: EffectScope | undefined
const effectScopeStack: EffectScope[] = []

// 形成一个新的作用范围 但是不能让外界直接拿到，会暴露一个接口
export class EffectScope {
  active = true
  // 存储作用范围的所有的effect
  effects: ReactiveEffect[] = []
  // 存储作用范围的所有清除函数
  cleanups: (() => void)[] = []

  parent: EffectScope | undefined
  scopes: EffectScope[] | undefined
  /**
   * track a child scope's index in its parent's scopes array for optimized
   * removal
   */
  private index: number | undefined

  constructor(detached = false) {
    if (!detached && activeEffectScope) {
      this.parent = activeEffectScope
      this.index =
        (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this
        ) - 1
    }
  }

  // 将一个副作用先执行一遍(收集依赖) 添加到当前作用范围
  run<T>(fn: () => T): T | undefined {
    if (this.active) {
      try {
        this.on()
        return fn()
      } finally {
        this.off()
      }
    } else if (__DEV__) {
      warn(`cannot run an inactive effect scope.`)
    }
  }

  // 将要执行的副作用函数进栈 将当前作用范围激活
  on() {
    if (this.active) {
      effectScopeStack.push(this)
      activeEffectScope = this
    }
  }

  // 将副作用函数出栈 (可能是副作用函数执行完毕 出栈)
  off() {
    if (this.active) {
      effectScopeStack.pop()
      activeEffectScope = effectScopeStack[effectScopeStack.length - 1]
    }
  }

  // 停止当前作用范围副作用 执行cleanups中的所有函数
  stop(fromParent?: boolean) {
    if (this.active) {
      this.effects.forEach(e => e.stop())
      this.cleanups.forEach(cleanup => cleanup())
      if (this.scopes) {
        this.scopes.forEach(e => e.stop(true))
      }
      // nested scope, dereference from parent to avoid memory leaks
      if (this.parent && !fromParent) {
        // optimized O(1) removal
        const last = this.parent.scopes!.pop()
        if (last && last !== this) {
          this.parent.scopes![this.index!] = last
          last.index = this.index!
        }
      }
      this.active = false
    }
  }
}

// 产生一个独立的作用范围 方便对所有的effect进行操作 暴露给外界的接口
export function effectScope(detached?: boolean) {
  return new EffectScope(detached)
}

// 记录Effect的作用范围 如果没有传就是当前激活的作用范围
export function recordEffectScope(
  effect: ReactiveEffect,
  scope?: EffectScope | null
) {
  scope = scope || activeEffectScope
  if (scope && scope.active) {
    scope.effects.push(effect)
  }
}

// 拿到激活的作用范围
export function getCurrentScope() {
  return activeEffectScope
}

// 给当前的激活的作用范围添加处理回调 该回调会在相关的effect作用域结束之后被调用。
export function onScopeDispose(fn: () => void) {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn)
  } else if (__DEV__) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`
    )
  }
}
