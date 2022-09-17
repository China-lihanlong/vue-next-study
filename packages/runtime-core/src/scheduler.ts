import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false
let isFlushPending = false

const queue: SchedulerJob[] = []
let flushIndex = 0

// 等待处理的同步任务
const pendingPreFlushCbs: SchedulerJob[] = []
// 当前正在处理的同步任务
let activePreFlushCbs: SchedulerJob[] | null = null
// 同步任务索引
let preFlushIndex = 0

// 等待处理的异步任务
const pendingPostFlushCbs: SchedulerJob[] = []
// 当前正在处理的异步任务
let activePostFlushCbs: SchedulerJob[] | null = null
// 异步任务索引
let postFlushIndex = 0

// 一个成功的Promise用于开启一个新的批量异步更新
const resolvedPromise: Promise<any> = Promise.resolve()
// 承诺在某个时刻更新的任务 或许可以用于开启一个新的批量异步更新
let currentFlushPromise: Promise<void> | null = null

// 递归调度的中 当前的调度函数的上一层函数
let currentPreFlushParentJob: SchedulerJob | null = null

// 调度递归的最大限制
const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}

// 加入到queue队列中
export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  // (queue是一个数组)正常情况下 Array.includes是包含当前正在允许的调度函数 因此 job是不会允许递归自身
  //  但是如果是watch的调度函数等 用户去手动递归(用户的责任) 调度任务搜索索引加一(不会找到自身)
  if (
    (!queue.length ||
      !queue.includes(
        job,
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {
    // 将调度函数放入同步任务队列(微任务队列)中
    if (job.id == null) {
      queue.push(job)
    } else {
      // 插队
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    queueFlush()
  }
}

function queueFlush() {
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    // 当前同步微任务
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

// 删除队列中的任务，比如组件自身产生了更新任务 但是它的子组件也因为它而产生了更新任务
// 但是由于DOM更新是深度更新，所以在进行这个子组件的时候会先把子组件的更新任务从队列中删除
// 避免重复更新
export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

// 将任务加入队列中
function queueCb(
  cb: SchedulerJobs,
  activeQueue: SchedulerJob[] | null,
  pendingQueue: SchedulerJob[],
  index: number
) {
  if (!isArray(cb)) {
    if (
      !activeQueue ||
      !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)
    ) {
      // 没有正在执行的队列或者是正在执行的队列中没有这个任务 可以将其加入等待队列中
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    // 如果cb是一个数组，那么它就是和组件生命周期挂钩，只能由一个任务触发，并且该任务已经在队列中去重
    // 我们可以跳过重复检查以提高性能
    // 通过queuePostRenderEffect(也就是queuePostFlushCb)将组件生命周期函数的任务加入到队列中
    pendingQueue.push(...cb)
  }
  queueFlush()
}

// 加入到pre队列中 通常是将watch产生的任务加入到pre队列中
export function queuePreFlushCb(cb: SchedulerJob) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

// 加入到post队列中 通常是将一部分的组件生命周期函数加入post队列中 比如 updated
// 当组件是Suspense时，则会使用Suspense.ts中的函数queueEffectWithSuspense
// 在queueEffectWithSuspense中符合某种条件会将任务作为Suspense的依赖
// 不符合则会加入到post队列中
export function queuePostFlushCb(cb: SchedulerJobs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

// 执行pre队列中的任务
export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    // 去重
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]
    pendingPreFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      // 执行队列中的任务
      activePreFlushCbs[preFlushIndex]()
    }
    // 清空Pre队列
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // recursively flush until it drains
    // 递归执行，当前任务作为父任务(pre等待队列中的新任务是由当前任务执行产生的)
    flushPreFlushCbs(seen, parentJob)
  }
}

// 执行post队列中的任务
export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    // 去重
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 已经存在一个正在执行的队列 那就是嵌套执行flushPostFlushCbs
    // 请将任务添加到正在执行的队列末尾， 等待执行
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    // 清空activePost队列中的任务
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

// 开始执行队列中的任务
function flushJobs(seen?: CountMap) {
  // seen 记录的是任务
  // 等待执行任务的标记变为false
  isFlushPending = false
  // 正在执行标记为true
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // 执行pre队列中的任务
  flushPreFlushCbs(seen)

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  // 执行队列中的任务之前进行排序
  // 确保是由父组件到子组件的更新(父组件对象总是比子组件先创建，所以优先标记应该更小) 排序是从小到大排序
  // 如果父组件更新过程中卸载了组件，那么可以跳过更新
  queue.sort((a, b) => getId(a) - getId(b))

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      // job.active=false 为失效任务不会执行 
      // 比如在卸载组件的时候，会去触发stop函数，这个函数内部就会停止这个组件的产生的任务
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        // 这里就是执行调度函数的入口
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    // 执行post队列中任务
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    // posst任务队列执行过程中产生新的任务加入到队列中
    // 继续执行，知道全部完成
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
    // 队列中还有任务在等待 请继续执行
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
