(...args) => {
  // If a user calls a compiled slot inside a template expression (#1745), it
  // can mess up block tracking, so by default we disable block tracking and
  // force bail out when invoking a compiled slot (indicated by the ._d flag).
  // This isn't necessary if rendering a compiled `<slot>`, so we flip the
  // ._d flag off when invoking the wrapped fn inside `renderSlot`.
  if (renderFnWithContext._d) {
      setBlockTracking(-1);
  }
  const prevInstance = setCurrentRenderingInstance(ctx);
  const res = fn(...args);
  setCurrentRenderingInstance(prevInstance);
  if (renderFnWithContext._d) {
      setBlockTracking(1);
  }
  {
      devtoolsComponentUpdated(ctx);
  }
  return res;
}


function fallback(fallbackVNode) {
  if (!suspense.pendingBranch) {
      return;
  }
  const { vnode, activeBranch, parentComponent, container, isSVG } = suspense;
  // invoke @fallback event
  triggerEvent(vnode, 'onFallback');
  const anchor = next(activeBranch);
  const mountFallback = () => {
      if (!suspense.isInFallback) {
          return;
      }
      // mount the fallback tree
      patch(null, fallbackVNode, container, anchor, parentComponent, null, // fallback tree will not have suspense context
      isSVG, slotScopeIds, optimized);
      setActiveBranch(suspense, fallbackVNode);
  };
  const delayEnter = fallbackVNode.transition && fallbackVNode.transition.mode === 'out-in';
  if (delayEnter) {
      activeBranch.transition.afterLeave = mountFallback;
  }
  suspense.isInFallback = true;
  // unmount current active branch
  unmount(activeBranch, parentComponent, null, // no suspense so unmount hooks fire now
  true // shouldRemove
  );
  if (!delayEnter) {
      mountFallback();
  }
}