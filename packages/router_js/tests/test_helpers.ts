import type { Route, Transition } from '../index';
import Router from '../index';
import type { Dict } from '../lib/core';
import type { IModel } from '../lib/route-info';
import RouteInfo, { UnresolvedRouteInfoByParam } from '../lib/route-info';
import type { PublicTransition } from '../lib/transition';
import { logAbort } from '../lib/transition';
import type { TransitionError } from '../lib/transition-state';
import type { UnrecognizedURLError } from '../lib/unrecognized-url-error';
import { isTransitionAborted, throwIfAborted } from '../lib/transition-aborted-error';
import { Promise } from 'rsvp';

// A useful function to allow you to ignore transition errors in a testing context
export async function ignoreTransitionError(transition: Transition) {
  try {
    await transition;
  } catch {
    // if it errors we don't do anything
  }
}

function assertAbort(assert: Assert) {
  return function _assertAbort(e: Error) {
    assert.ok(isTransitionAborted(e), 'transition was redirected/aborted');
  };
}

function transitionToWithAbort(assert: Assert, router: Router<Route>, path: string) {
  return router.transitionTo(path).then(shouldNotHappen(assert), assertAbort(assert));
}

function replaceWith(router: Router<Route>, path: string) {
  return router.transitionTo.apply(router, [path]).method('replace');
}

function shouldNotHappen(assert: Assert, _message?: string) {
  let message = _message || 'this .then handler should not be called';
  return function _shouldNotHappen(error: any) {
    console.error(error.stack); // eslint-disable-line
    assert.ok(false, message);
    return error;
  };
}

export function isExiting(route: Route | string, routeInfos: RouteInfo<Route>[]) {
  for (let i = 0, len = routeInfos.length; i < len; ++i) {
    let routeInfo = routeInfos[i];
    if (routeInfo!.name === route || routeInfo!.route === route) {
      return false;
    }
  }
  return true;
}

function stubbedHandlerInfoFactory(name: string, props: Dict<unknown>) {
  let obj = Object.create(props);
  obj._handlerInfoType = name;
  return obj;
}

export {
  transitionToWithAbort,
  replaceWith,
  shouldNotHappen,
  stubbedHandlerInfoFactory,
  assertAbort,
};

// Minimal structural copies of the route manager types. The real interfaces
// live in @ember/-internals/routing/route-managers/route-manager. We copy
// them here so router_js tests stay independent of the ember-source side.
interface RouteCapabilities {
  classicInterop: boolean;
}

interface NavigationArgs {
  transition: any;
  to: any;
  cancel: () => void;
  signal?: AbortSignal;
  getAncestorPromise: (routeInfo?: any) => Promise<unknown>;
}

interface RouteManagerLike {
  capabilities: RouteCapabilities;
  createRoute(definition: any, args: { name: string }): TestRouteBucket;
  getDestroyable(bucket: TestRouteBucket): unknown;
  willEnter(bucket: TestRouteBucket, args: NavigationArgs): void;
  enter(bucket: TestRouteBucket, args: NavigationArgs): Promise<unknown>;
  didEnter(bucket: TestRouteBucket, args: NavigationArgs & { enter?: boolean }): void;
  willExit(bucket: TestRouteBucket, args: NavigationArgs & { isExiting?: boolean }): void;
  exit(bucket: TestRouteBucket, args: NavigationArgs): void;
  didExit(bucket: TestRouteBucket, args: NavigationArgs): void;
  getRouteWrapper(bucket: TestRouteBucket): object;
  getInvokable(
    bucket: TestRouteBucket,
    enterPromise: Promise<unknown>
  ): Promise<object | undefined>;
}

// Bucket carries module-stable per-route state. Mirrors ClassicRouteBucket
// without ember-side decorators. Per-render data (context, enterPromise) lives
// on the routeInfo on this branch.
class TestRouteBucket {
  route: Route;
  args: { name: string };
  invokable: object | undefined = undefined;

  constructor(route: Route, args: { name: string }) {
    this.route = route;
    this.args = args;
  }
}

// In-test route manager that runs the classic beforeModel/model/afterModel
// chain without depending on EmberObject, owners, or the glimmer module graph.
// router_js tests expect plain object handlers with model/setup/etc. hooks,
// so this manager dispatches directly to those hooks.
class TestRouteManager implements RouteManagerLike {
  capabilities: RouteCapabilities = { classicInterop: true };

  createRoute(handler: Route, args: { name: string }): TestRouteBucket {
    const bucket = new TestRouteBucket(handler, args);
    handler.bucket = bucket as any;
    handler.manager = this as any;
    return bucket;
  }

  getDestroyable(bucket: TestRouteBucket): unknown {
    return bucket.route;
  }

  willEnter(_bucket: TestRouteBucket, _args: NavigationArgs): void {}

  enter(bucket: TestRouteBucket, args: NavigationArgs): Promise<unknown> {
    const transition = args.transition;
    const routeInfo = args.to;
    // Source the route from routeInfo.route (the value the router resolved),
    // not bucket.route. createHandlerInfo and friends sometimes attach a route
    // to the routeInfo via prototype assignment that doesn't match the route
    // the bucket was constructed with; routeInfo.route is the authoritative one.
    const route = (routeInfo?.route ?? bucket.route) as Route<any>;

    if (transition && typeof transition.trigger === 'function') {
      transition.trigger(true, 'willResolveModel', transition, route);
    }

    const name = routeInfo?.name ?? bucket.args.name;
    // If a hook returns a Transition (e.g. router.transitionTo from inside
    // beforeModel/afterModel), null it out so the chain doesn't pause waiting
    // on a "transition" thenable. Mirrors classic-route-manager's _isTransition
    // guards. UnresolvedRouteInfoByParam.getModel already handles this for
    // route.model itself.
    const isTransitionLike = (obj: unknown): boolean =>
      typeof obj === 'object' && obj !== null && (obj as any).isTransition === true;

    const beforeModelResult = route?.beforeModel?.(transition);
    return Promise.resolve(isTransitionLike(beforeModelResult) ? null : beforeModelResult)
      .then(() => routeInfo.getModel(transition))
      .then((model: unknown) => {
        // Stash the model on transition.resolvedModels BEFORE afterModel so
        // afterModel can swap it (test: "resolved models can be swapped out
        // within afterModel"). Mirrors classic-route-manager._getModel +
        // _runAfterModel order.
        if (transition) {
          transition.resolvedModels = transition.resolvedModels || {};
          transition.resolvedModels[name] = model;
        }
        const afterModelResult = route?.afterModel?.(model as any, transition);
        const safeAfterModel = isTransitionLike(afterModelResult) ? null : afterModelResult;
        return Promise.resolve(safeAfterModel).then(() => {
          // afterModel may have swapped transition.resolvedModels[name]; pick
          // up the (possibly new) value rather than the original model.
          return transition?.resolvedModels?.[name] ?? model;
        });
      });
  }

  didEnter(bucket: TestRouteBucket, args: NavigationArgs & { enter?: boolean }): void {
    const transition = args.transition;
    const routeInfo = args.to;
    const route = (routeInfo?.route ?? bucket.route) as Route<any>;
    // Read context from the routeInfo. routeInfo is the per-render handle;
    // bucket.context is being phased out.
    const context = routeInfo?.context;

    if (route) {
      // Fire route.enter() for fresh entries (not for context-updates), mirroring
      // classic setupContexts which gated enter on the `enter` flag passed in.
      if (args.enter !== false && route.enter) {
        route.enter(transition);
      }
      // If enter triggered a redirect (router.transitionTo from inside enter),
      // the transition is now aborted. Throw so the outer didEnter loop bails
      // before calling setup or invoking later routes' enter, mirroring the
      // throwIfAborted between enter and setup in main's setupContexts.
      throwIfAborted(transition);
      route.context = context as any;
      if (route.setup) {
        route.setup(context as any, transition);
      }
      // Same guard between setup and the next route, so a redirect from setup
      // also stops further enters/setups in this loop iteration.
      throwIfAborted(transition);
    }
  }

  willExit(_bucket: TestRouteBucket, _args: NavigationArgs & { isExiting?: boolean }): void {}

  exit(bucket: TestRouteBucket, args: NavigationArgs): void {
    // Mirror classic setupContexts: fire route.exit and clear route.context
    // when the route is leaving the active hierarchy.
    const transition = args.transition;
    const route = bucket.route;
    if (route) {
      delete route.context;
      if (route.exit) {
        route.exit(transition);
      }
    }
  }

  didExit(_bucket: TestRouteBucket, _args: NavigationArgs): void {}

  // Sentinel wrapper. router_js tests never actually render so the value is
  // unused, we just need to satisfy the manager interface.
  getRouteWrapper(_bucket: TestRouteBucket): object {
    return TEST_WRAPPER_SENTINEL;
  }

  // Gate on enterPromise so the resolution loop stays sequential, mirroring
  // classic behaviour. Most existing tests assume a route's model resolves
  // before its child route's model starts.
  getInvokable(
    _bucket: TestRouteBucket,
    enterPromise: Promise<unknown>
  ): Promise<object | undefined> {
    return (enterPromise ?? Promise.resolve()).then(() => undefined);
  }
}

const TEST_WRAPPER_SENTINEL = {};

const SHARED_TEST_MANAGER = new TestRouteManager();

export function createHandler<T extends IModel>(name: string, options?: Dict<unknown>): Route<T> {
  const handler = Object.assign(
    { name, routeName: name, context: {}, names: [], handler: name, _internalName: name },
    options
  ) as unknown as Route<T>;
  // Attach a manager+bucket so resolveViaManager has something to work with.
  // Without this, route.manager is undefined and the resolution loop blows up.
  SHARED_TEST_MANAGER.createRoute(handler as unknown as Route, { name });
  return handler;
}

export class TestRouter<R extends Route = Route> extends Router<R> {
  didTransition() {}
  willTransition() {}
  updateURL(_url: string): void {}
  replaceURL(_url: string): void {}
  triggerEvent(
    _handlerInfos: RouteInfo<R>[],
    _ignoreFailure: boolean,
    _name: string,
    _args: any[]
  ) {}
  routeDidChange() {}
  routeWillChange() {}
  transitionDidError(error: TransitionError, transition: PublicTransition) {
    if (error.wasAborted || transition.isAborted) {
      return logAbort(transition);
    } else {
      transition.trigger(false, 'error', error.error, this, error.route);
      transition.abort();
      return error.error;
    }
  }
  getRoute(name: string): any {
    // Return a handler with a manager attached so resolveViaManager has
    // something to work with. Bare {} would crash on route.manager access.
    return createHandler(name);
  }
  getSerializer(_name: string): any {
    return () => {};
  }

  // As each route's getInvokable resolves, write the resolved routeInfo into
  // currentRouteInfos at its slot. Mirrors EmberRouter.onRouteInvokableReady.
  onRouteInvokableReady(
    routeInfo: InternalRouteInfoLike,
    _transition: any,
    routeIndex: number
  ): void {
    const current = (this.currentRouteInfos as any[]) ?? [];
    current[routeIndex] = routeInfo;
    (this as any).currentRouteInfos = current;
  }

  // Mirrors EmberRouter.onIntermediateTransition. Substate routes have no
  // model hook to await, so we synchronously fire didEnter on each entered
  // route (after splicing currentRouteInfos), so route.enter/route.setup run.
  // For async getRoute scenarios the route may not be resolved yet at this
  // point (becomeResolved was called before fetchRoute); chain on routePromise
  // so didEnter still fires once the handler is available, mirroring main's
  // routeEnteredOrUpdated path that defers via routePromise.then.
  onIntermediateTransition(newState: any, transition: any): void {
    const partition = this.partitionRoutes(this.state!, newState);

    const currentRouteInfos = [...partition.unchanged, ...partition.entered];
    (this as any).currentRouteInfos = currentRouteInfos;

    this.oldState = this.state;
    this.state = newState;

    const fireDidEnter = (routeInfo: any, route: any) => {
      if (!route?.manager) return;
      route.manager.didEnter(route.bucket, { transition, to: routeInfo, enter: true } as any);
    };

    for (const routeInfo of partition.entered) {
      const route = (routeInfo as any).route;
      if (route) {
        fireDidEnter(routeInfo, route);
      } else {
        // Async route: trigger fetchRoute via routePromise and defer didEnter
        // until it resolves. Without this faq.setup never fires in scenarios
        // where getRoute returns a Promise.
        (routeInfo as any).routePromise.then((resolved: any) => {
          fireDidEnter(routeInfo, resolved);
        });
      }
    }
  }

  // Mirrors EmberRouter.onTransitionSettled, the orchestrator that fires
  // willExit/exit/didEnter/didExit, awaits enterPromises, finalizes QPs, and
  // updates the URL. Without this, classic route.enter/route.exit hooks never
  // run for tests that use a manager-driven router.
  onTransitionSettled(activeTransition: any, newState: any): Promise<void> {
    const partition = this.partitionRoutes(this.state!, newState);

    // Capture pre-transition state so we can revert on didEnter throws.
    // Mirrors classic setupContexts: a throw inside enter/setup must roll
    // back router state so the next transition sees the routes as still-
    // unentered and re-fires their enter hooks.
    const preTransitionState = this.state;
    this.oldState = this.state;
    this.state = newState;

    // willExit + exit on routes leaving the hierarchy.
    for (const exitingRouteInfo of partition.exited) {
      const route = (exitingRouteInfo as any).route;
      if (route?.manager) {
        route.manager.willExit(route.bucket, { transition: activeTransition } as any);
        route.manager.exit(route.bucket, { transition: activeTransition } as any);
      }
    }

    // Filter exited routes out of currentRouteInfos. Cannot truncate to
    // unchanged.length because onRouteInvokableReady may have already written
    // entering routes at higher indices.
    const exitedRouteObjects = new Set(partition.exited.map((ri: any) => ri.route));
    if (this.currentRouteInfos) {
      this.currentRouteInfos = this.currentRouteInfos.filter(
        (cri: any) => !exitedRouteObjects.has(cri.route)
      ) as any;
    }

    // Reset routes whose context changed but which are not exiting.
    for (const resetRouteInfo of partition.reset) {
      const route = (resetRouteInfo as any).route;
      if (route?.manager && route.bucket !== undefined) {
        route.manager.willExit(route.bucket, {
          transition: activeTransition,
          isExiting: false,
        } as any);
      }
    }

    // Wait for all entering routes' enter() promises before firing didEnter.
    // Swallow rejections so a single failed transition does not poison the
    // global RSVP unhandled rejection handler.
    const enteringRouteInfos = [...partition.entered, ...partition.updatedContext];
    const enterPromises = enteringRouteInfos.map((routeInfo: any) => {
      const p = routeInfo.enterPromise ?? Promise.resolve(undefined);
      return (p as any).catch ? (p as any).catch(() => undefined) : p;
    });

    return (Promise as any).all(enterPromises).then(() => {
      if (activeTransition.isAborted) return;

      try {
        for (const enteredRouteInfo of partition.entered) {
          const route = (enteredRouteInfo as any).route;
          if (!route) continue;
          route.manager.didEnter(route.bucket, {
            transition: activeTransition,
            to: enteredRouteInfo,
            enter: true,
          } as any);
        }

        for (const updatedRouteInfo of partition.updatedContext) {
          const route = (updatedRouteInfo as any).route;
          if (!route) continue;
          route.manager.didEnter(route.bucket, {
            transition: activeTransition,
            to: updatedRouteInfo,
            enter: false,
          } as any);
        }
      } catch (error) {
        // Roll back state to the pre-transition values so the next transition
        // sees these routes as still-unentered and re-fires their enter hooks.
        // Mirrors classic setupContexts' rollback behaviour on throw.
        // Copy the routeInfos array (don't alias) so subsequent transitions
        // that mutate currentRouteInfos via onRouteInvokableReady don't also
        // write back into preTransitionState.routeInfos, corrupting the state
        // baseline used by partitionRoutes for the next transition.
        this.state = preTransitionState;
        this.currentRouteInfos = preTransitionState
          ? (preTransitionState.routeInfos.slice() as any)
          : undefined;
        const errorRoute = (newState.routeInfos[newState.routeInfos.length - 1] as any)?.route;
        const reason = this.transitionDidError(
          { error, route: errorRoute, wasAborted: false } as any,
          activeTransition
        );
        throw reason;
      }

      // If a route's enter or setup hook redirected (called router.transitionTo),
      // the original transition is now aborted. Reject so the original handleURL/
      // transitionTo promise rejects with a TransitionAborted, mirroring main's
      // setupContexts post-check before _updateURL fires.
      if (activeTransition.isAborted) {
        throw logAbort(activeTransition);
      }

      // didExit on routes that left the hierarchy.
      for (const exitedRouteInfo of partition.exited) {
        const route = (exitedRouteInfo as any).route;
        if (route?.manager) {
          route.manager.didExit(route.bucket, { transition: activeTransition } as any);
        }
      }

      // Replace currentRouteInfos with the authoritative settled list.
      this.currentRouteInfos = newState.routeInfos.slice();

      // Finalize query params with the settled route infos.
      this.state!.queryParams = this.finalizeQueryParamChange(
        this.currentRouteInfos!,
        newState.queryParams,
        activeTransition
      );

      this._updateURL(activeTransition, newState);

      activeTransition.isActive = false;
      this.activeTransition = undefined;

      this.triggerEvent(this.currentRouteInfos!, true, 'didTransition', []);
      this.didTransition(this.currentRouteInfos!);
      this.toInfos(activeTransition, newState.routeInfos, true);
      this.routeDidChange(activeTransition);

      // Resolve the transition's promise with the leaf route to mirror the
      // original router_js finalizeTransition contract that tests rely on.
      return (newState.routeInfos[newState.routeInfos.length - 1] as any)?.route;
    });
  }
}

// Loose alias for InternalRouteInfo to keep TestRouter signatures legible.
type InternalRouteInfoLike = RouteInfo<Route>;

export function createHandlerInfo(name: string, options: Dict<unknown> = {}): RouteInfo<Route> {
  class Stub extends RouteInfo<Route> {
    constructor(name: string, router: Router<Route>, handler?: Route) {
      super(router, name, [], handler);
    }
    getModel(_transition: Transition) {
      return {} as any;
    }
    getUnresolved() {
      return new UnresolvedRouteInfoByParam(this.router, 'empty', [], {});
    }
  }

  // Tests pass the route under either `handler` or `route`; both are valid
  // ergonomics. Pull whichever is set, fall back to a fresh handler.
  let handler =
    (options['handler'] as Route) || (options['route'] as Route) || createHandler('foo');
  delete options['handler'];
  delete options['route'];

  Object.assign(Stub.prototype, options);
  let stub = new Stub(name, new TestRouter(), handler);
  return stub;
}

export function trigger(
  handlerInfos: RouteInfo<Route>[],
  ignoreFailure: boolean,
  name: string,
  ...args: any[]
) {
  if (!handlerInfos) {
    if (ignoreFailure) {
      return;
    }
    throw new Error("Could not trigger event '" + name + "'. There are no active handlers");
  }

  let eventWasHandled = false;

  for (let i = handlerInfos.length - 1; i >= 0; i--) {
    let currentHandlerInfo = handlerInfos[i]!,
      currentHandler = currentHandlerInfo.route;

    // If there is no handler, it means the handler hasn't resolved yet which
    // means that we should trigger the event later when the handler is available
    if (!currentHandler) {
      currentHandlerInfo.routePromise!.then(function (resolvedHandler) {
        if (resolvedHandler.events?.[name]) {
          resolvedHandler.events[name].apply(resolvedHandler, args);
        }
      });
      continue;
    }

    if (currentHandler.events && currentHandler.events[name]) {
      if (currentHandler.events[name].apply(currentHandler, args) === true) {
        eventWasHandled = true;
      } else {
        return;
      }
    }
  }

  // In the case that we got an UnrecognizedURLError as an event with no handler,
  // let it bubble up
  if (name === 'error' && (args[0] as UnrecognizedURLError)!.name === 'UnrecognizedURLError') {
    throw args[0];
  } else if (!eventWasHandled && !ignoreFailure) {
    throw new Error("Nothing handled the event '" + name + "'.");
  }
}
