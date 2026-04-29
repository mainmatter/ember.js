import { getOwner, setOwner } from '@ember/-internals/owner';
import { assert, info } from '@ember/debug';
import { get } from '@ember/-internals/metal';
import { DEBUG } from '@glimmer/env';
import { hasInternalComponentManager } from '@glimmer/manager';
import type { CurriedComponent, Destroyable, Template, TemplateFactory } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference';
import { createComputeRef, createConstRef } from '@glimmer/reference';
import { createCapturedArgs, curry, EMPTY_POSITIONAL } from '@glimmer/runtime';
import { dict } from '@glimmer/util';
import { tracked } from '@glimmer/tracking';
import { makeRouteTemplate } from '@ember/-internals/glimmer/lib/component-managers/route-template';
import type Owner from '@ember/owner';
import type Route from '@ember/routing/route';
import type {
  RouteManager,
  RouteCapabilities,
  NavigationState,
  NavigationActions,
  AsyncNavigationState,
  CreateRouteArgs,
  NavigationStateWithTransition,
} from './route-manager';
import { routeCapabilities } from './route-manager';
import type { RouteStateBucket } from './utils';
import { cancel, scheduleOnce } from '@ember/runloop';
import { Promise } from 'rsvp';
import type { InternalRouteInfo } from 'router_js';
import { STATE_SYMBOL } from 'router_js';

// --- Bucket ---

export class ClassicRouteBucket implements RouteStateBucket {
  route: Route;
  args: CreateRouteArgs;

  @tracked context: unknown = undefined;
  controller: unknown = undefined;
  invokable: object | undefined = undefined;
  // Populated by the router immediately after calling manager.enter(), so that
  // child routes can await the parent's data resolution via getAncestorPromise.
  enterPromise: Promise<unknown> | undefined = undefined;
  // Timer handle for any pending loading substate transition scheduled during
  // willEnter. Stored per-bucket so that concurrent routes each track their
  // own timer and didEnter can cancel the right one without clobbering another
  // route's timer.
  loadingSubstateTimer: unknown = null;

  constructor(route: Route, args: CreateRouteArgs) {
    this.route = route;
    this.args = args;
  }
}

// --- Classic interop args ---

/**
 * Extra args provided to manager methods when classicInterop is enabled.
 * These give the ClassicRouteManager access to router_js internals needed
 * to replicate the classic hook behaviour.
 */
export interface ClassicInteropArgs {
  transition: any;
  routeInfo: any;
}

// --- ClassicRouteManager ---

/**
 * The ClassicRouteManager wraps the classic Route lifecycle so that all
 * routes flow through the RouteManager interface. Every method delegates
 * to the Route instance stored in the bucket.
 *
 * Capabilities: classicInterop = true
 */
export class ClassicRouteManager implements RouteManager<ClassicRouteBucket> {
  capabilities: RouteCapabilities = routeCapabilities('1.0', { classicInterop: true });

  #owner: Owner;

  constructor(owner: Owner) {
    this.#owner = owner;
  }

  createRoute(RouteClass: typeof Route, args: CreateRouteArgs): ClassicRouteBucket {
    let props = {};
    setOwner(props, this.#owner);
    let route = RouteClass.create(props);
    route._setRouteName(args.name);

    const bucket = new ClassicRouteBucket(route, args);
    route.bucket = bucket;
    route.manager = this;

    return bucket;
  }

  getDestroyable(bucket: ClassicRouteBucket): Destroyable | null {
    return bucket.route;
  }

  // --- Enter lifecycle ---

  private _runBeforeModel(route: Route, transition: any): Promise<unknown> {
    let result: unknown;
    if (route.beforeModel !== undefined) {
      result = route.beforeModel(transition);
    }

    if (this._isTransition(result)) {
      result = null;
    }

    return Promise.resolve(result);
  }

  private _getModel(routeInfo: any, transition: any): Promise<unknown> {
    // Delegate to routeInfo.getModel() for polymorphic dispatch:
    // - UnresolvedRouteInfoByParam calls route.deserialize/model with URL params
    // - UnresolvedRouteInfoByObject returns the pre-provided model object directly
    // This is critical when transitionTo() is called with a model object rather than URL params.
    return Promise.resolve(routeInfo.getModel(transition)).then((resolvedModel: unknown) => {
      let name = routeInfo.name;
      transition.resolvedModels = transition.resolvedModels || {};
      transition.resolvedModels[name] = resolvedModel;
      return resolvedModel;
    });
  }

  private _runAfterModel(route: Route, resolvedModel: unknown, transition: any): Promise<unknown> {
    let name = route.routeName || route._internalName;
    transition.resolvedModels = transition.resolvedModels || {};
    transition.resolvedModels[name] = resolvedModel;

    let result: unknown;
    if (route.afterModel !== undefined) {
      result = route.afterModel(resolvedModel, transition);
    }

    result = this._isTransition(result) ? null : result;

    return Promise.resolve(result).then(() => {
      return transition.resolvedModels[name];
    });
  }

  private _isTransition(obj: unknown): boolean {
    return typeof obj === 'object' && obj !== null && (obj as any).isTransition === true;
  }

  willEnter(
    bucket: ClassicRouteBucket,
    args: NavigationState & NavigationActions & NavigationStateWithTransition
  ): void {
    const transition = args.transition;

    if (!transition.isActive) {
      return;
    }

    // Schedule the loading substate detection on the 'routerTransitions' queue.
    // We do not look up the substate name here. Looking up factoryFor a missing
    // template (e.g. on a fast initial visit where no loading template is added)
    // poisons the registry's _failSet, so subsequent factoryFor calls return
    // undefined even after the template is registered. Deferring the lookup until
    // the timer fires mirrors the original _scheduleLoadingEvent timing and lets
    // any addTemplate calls in the test setup land before we look anything up.
    bucket.loadingSubstateTimer = scheduleOnce(
      'routerTransitions',
      this,
      this._enterLoadingSubstate,
      bucket,
      transition
    );
  }

  private _enterLoadingSubstate(bucket: ClassicRouteBucket, transition: any): void {
    if (!bucket.loadingSubstateTimer || !transition.isActive) {
      return;
    }
    bucket.loadingSubstateTimer = null;

    // Walk up the route tree starting from this bucket's route to find a loading
    // substate. Mirrors the original defaultActionHandlers.loading + forEachRouteAbove
    // which received routeInfos sliced to the currently resolving route, not the
    // full transition.
    //   - For the slow route itself, only check substate form (foo_loading). The
    //     state form (foo.loading) is its own child, technically below where we are.
    //   - For ancestor routes, check both state form (foo.loading) and substate
    //     form (foo_loading).
    //   - Stop at the pivot route, do not bubble higher.
    const routeInfos = transition[STATE_SYMBOL]?.routeInfos ?? [];
    const pivotHandler = transition.pivotHandler;

    let slowRouteInfo: InternalRouteInfo<Route> | undefined;
    for (const candidate of routeInfos) {
      if (candidate?.route === bucket.route) {
        slowRouteInfo = candidate;
        break;
      }
    }
    const slowIndex = slowRouteInfo ? routeInfos.indexOf(slowRouteInfo) : -1;
    const startIndex = slowIndex >= 0 ? slowIndex : routeInfos.length - 1;

    let loadingSubstateName = '';
    for (let i = startIndex; i >= 0; i--) {
      const ancestorRouteInfo = routeInfos[i];
      const ancestorRoute = ancestorRouteInfo?.route;
      if (!ancestorRoute) continue;

      const ancestorOwner = getOwner(ancestorRoute);
      assert('Route is unexpectedly missing an owner', ancestorOwner);

      // Skip the state route check (foo.loading) for the slow route itself,
      // since that would be a child route and below where we are.
      if (ancestorRouteInfo !== slowRouteInfo) {
        loadingSubstateName = this._findRouteStateName(ancestorRoute, ancestorOwner, 'loading');
        if (loadingSubstateName) break;
      }

      loadingSubstateName = this._findRouteSubstateName(ancestorRoute, ancestorOwner, 'loading');
      if (loadingSubstateName) break;

      if (pivotHandler === ancestorRoute) break;
    }

    if (!loadingSubstateName) {
      return;
    }

    bucket.route._router.intermediateTransitionTo(loadingSubstateName);
  }

  // Checks whether a substate route of the form `routeName_state` exists.
  private _findRouteSubstateName(route: Route, owner: Owner, state: string): string {
    const { routeName, fullRouteName, _router: router } = route;
    const substateName = `${routeName}_${state}`;
    const substateNameFull = `${fullRouteName}_${state}`;
    return this._routeHasBeenDefined(owner, router, substateName, substateNameFull)
      ? substateNameFull
      : '';
  }

  // Checks whether a state route of the form `routeName.state` exists.
  private _findRouteStateName(route: Route, owner: Owner, state: string): string {
    const { routeName, fullRouteName, _router: router } = route;
    const stateName = routeName === 'application' ? state : `${routeName}.${state}`;
    const stateNameFull = fullRouteName === 'application' ? state : `${fullRouteName}.${state}`;
    return this._routeHasBeenDefined(owner, router, stateName, stateNameFull) ? stateNameFull : '';
  }

  // A route is defined if the router has the route AND the owner has a template or route class.
  private _routeHasBeenDefined(
    owner: Owner,
    router: any,
    localName: string,
    fullName: string
  ): boolean {
    const routerHasRoute = router.hasRoute(fullName);
    const ownerHasRoute =
      owner.factoryFor(`template:${localName}`) || owner.factoryFor(`route:${localName}`);
    return Boolean(routerHasRoute && ownerHasRoute);
  }

  enter(
    bucket: ClassicRouteBucket,
    args: NavigationState & NavigationActions & AsyncNavigationState & NavigationStateWithTransition
  ): Promise<unknown> {
    let route = bucket.route;
    let transition = args.transition;
    let routeInfo = args.to;

    if (transition.trigger) {
      transition.trigger(true, 'willResolveModel', transition, route);
    }

    return (
      this._runBeforeModel(route, transition)
        .then(() => {
          if (transition.isAborted) {
            throw transition.error;
          }
        })
        .then(() => this._getModel(routeInfo, transition))
        // _getModel uses routeInfo.getModel() for polymorphic dispatch
        .then((resolvedModel) => {
          if (transition.isAborted) {
            throw transition.error;
          }
          return resolvedModel;
        })
        .then((resolvedModel) => this._runAfterModel(route, resolvedModel, transition))
        .then((resolvedModel) => {
          bucket.context = resolvedModel;

          return resolvedModel;
        })
    );
  }

  didEnter(bucket: ClassicRouteBucket, _args: NavigationState): void {
    // Cancel the pending loading substate if enter() resolved before it fired.
    if (bucket.loadingSubstateTimer) {
      cancel(bucket.loadingSubstateTimer as any);
      bucket.loadingSubstateTimer = null;
    }

    let route = bucket.route;
    let context = bucket.context;
    // Extract transition and enter flag from args (passed by EmberRouter.onTransitionSettled)
    let transition = (_args as any).transition;
    let enter = (_args as any).enter;

    // Classic enter: activate + trigger 'activate' (only on fresh enter, not updates)
    if (enter) {
      route.activate(transition);
      route.trigger('activate', transition);
    }

    // Set the resolved context on the route object
    route.context = context;
    if (route.contextDidChange !== undefined) {
      route.contextDidChange();
    }

    if (route.setup !== undefined) {
      route.setup(context, transition!);
    }

    // Re-sync controller in case setup() did anything unusual. Normally the
    // controller is the same instance _initController set during getInvokable.
    bucket.controller = route.controller;

    // _setOutlets is no longer scheduled here. Rendering is driven by
    // onRouteInvokableReady in EmberRouter, which fires as soon as getInvokable()
    // resolves, before enter() finishes. By the time didEnter runs, the outlet is
    // already rendering the route template with the reactive @model and @controller refs.
  }

  // --- Exit lifecycle ---

  willExit(bucket: ClassicRouteBucket, _args: NavigationState & NavigationActions): void {
    let route = bucket.route;
    // Extract isExiting and transition from args (passed by router_js)
    let isExiting = (_args as any).isExiting ?? true;
    let transition = (_args as any).transition;
    // _internalReset handles resetting QP delegate on the controller
    route._internalReset(isExiting, transition);
  }

  exit(bucket: ClassicRouteBucket, _args: NavigationState): void {
    let route = bucket.route;
    let transition = (_args as any).transition;
    delete route.context;
    route.deactivate(transition);
    route.trigger('deactivate', transition);
    route.teardownViews();
  }

  didExit(_bucket: ClassicRouteBucket, _args: NavigationState): void {
    // No-op for classic routes
  }

  // --- Template/Component lookup ---

  getInvokable(bucket: ClassicRouteBucket): Promise<object | undefined> {
    // Build the invokable synchronously, then gate on enterPromise. Awaiting
    // enterPromise ensures onRouteInvokableReady does not fire until data is
    // loaded, whether this is a fresh entry or a re-entry where the model hook
    // runs again. During the wait, the deferred scheduleOnce in willEnter fires
    // and enters the loading substate. Once enter() resolves, the invokable is
    // returned and the real route renders, replacing the loading substate.
    const invokable = this._buildInvokable(bucket);
    return (bucket.enterPromise || Promise.resolve()).then(() => invokable);
  }

  // Synchronous invokable construction. Used by getInvokable above and directly
  // by EmberRouter.onIntermediateTransition for substate routes which have no
  // async work and need their didEnter (and therefore activate) to fire before
  // routeWillChange events.
  _buildInvokable(bucket: ClassicRouteBucket): object {
    if (bucket.invokable !== undefined) {
      return bucket.invokable;
    }

    let route = bucket.route;
    let owner = getOwner(route);
    assert('Route is unexpectedly missing an owner', owner);

    let name = route.templateName || route.routeName;
    let templateFactoryOrComponent = owner.lookup(`template:${name}`) as
      | TemplateFactory
      | object
      | undefined;

    let component: object;
    // Track whether the component is already a resolved definition (CurriedValue
    // from makeRouteTemplate) vs a raw component class that needs VM resolution.
    let isResolved = true;

    if (templateFactoryOrComponent) {
      if (hasInternalComponentManager(templateFactoryOrComponent)) {
        // ComponentLike - use directly, will be curried below.
        // Not resolved yet, the VM needs to look up its definition.
        component = templateFactoryOrComponent;
        isResolved = false;
      } else {
        if (DEBUG && typeof templateFactoryOrComponent !== 'function') {
          let label: string;

          try {
            label = `\`${String(templateFactoryOrComponent)}\``;
          } catch {
            label = 'an unknown object';
          }

          assert(
            `Failed to render the ${name} route, expected ` +
              `\`template:${name}\` to resolve into ` +
              `a component or a \`TemplateFactory\`, got: ${label}. ` +
              `Most likely an improperly defined class or an invalid module export.`
          );
        }

        // TemplateFactory -> Template -> RouteTemplate (curried component with no args)
        let template = (templateFactoryOrComponent as TemplateFactory)(owner);
        component = makeRouteTemplate(owner, name, template as Template);
      }
    } else {
      if (DEBUG) {
        let LOG_VIEW_LOOKUPS = get(route._router, 'namespace.LOG_VIEW_LOOKUPS');
        if (LOG_VIEW_LOOKUPS) {
          info(`Could not find "${name}" template. Nothing will be rendered`, {
            fullName: `template:${name}`,
          });
        }
      }
      // Default {{outlet}} template -> RouteTemplate
      let template = route._topLevelViewTemplate(owner);
      component = makeRouteTemplate(owner, name, template as Template);
    }

    // Resolve the controller eagerly (looking up or generating it) so that
    // bucket.controller is set before the route template renders. This is
    // required because LinkTo (and other internal components) assert the
    // caller reference is const, which forces us to curry @controller as a
    // const ref. setup() called later in didEnter is idempotent and will skip
    // the assignment when this.controller is already set.
    let controller = (route as any)._initController();
    bucket.controller = controller;

    // Create curry args. Controller is a const ref because the controller
    // is a singleton per owner and never changes for the route's lifetime.
    // Model is a compute ref over bucket.context (which is @tracked) so the
    // template re-renders when the model changes (e.g. navigating to the same
    // route with different dynamic segments).
    let named = dict<Reference>();
    named['controller'] = createConstRef(controller, 'controller');
    named['model'] = createComputeRef(() => bucket.context);

    let args = createCapturedArgs(named, EMPTY_POSITIONAL);

    // Curry @controller and @model onto the component so the invokable is
    // self-contained. The outlet rendering pipeline no longer needs to know
    // about model or controller.
    let invokable = curry(0 as CurriedComponent, component, owner, args, isResolved);

    bucket.invokable = invokable;

    return invokable;
  }
}
