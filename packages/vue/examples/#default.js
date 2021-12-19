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