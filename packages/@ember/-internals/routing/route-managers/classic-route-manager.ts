import { getOwner, setOwner } from '@ember/-internals/owner';
import { assert, info } from '@ember/debug';
import { get } from '@ember/-internals/metal';
import { DEBUG } from '@glimmer/env';
import {
  hasInternalComponentManager,
  setComponentTemplate,
  setInternalComponentManager,
} from '@glimmer/manager';
import type {
  CustomRenderNode,
  Destroyable,
  InternalComponentCapabilities,
  InternalComponentManager,
  Template,
  TemplateFactory,
  WithCustomDebugRenderTree,
} from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference';
import { NULL_REFERENCE } from '@glimmer/reference';
import { makeRouteTemplate } from '@ember/-internals/glimmer/lib/component-managers/route-template';
import { precompileTemplate } from '@ember/template-compilation';
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
import type Controller from '@ember/controller';

// --- Bucket ---

export class ClassicRouteBucket implements RouteStateBucket {
  route: Route;
  args: CreateRouteArgs;

  // Cached invokable returned from getInvokable. Stable for the bucket's
  // lifetime so the outlet's wrapper-driven rendering can reuse the same
  // resolved component definition across re-renders without re-resolving the
  // template.
  invokable: object | undefined = undefined;

  wrapper: object | undefined = undefined;

  // Timer handle for any pending loading substate transition scheduled during
  // willEnter. Stored per-bucket so that concurrent routes each track their
  // own timer and didEnter can cancel the right one without clobbering another
  // route's timer.
  loadingSubstateTimer: unknown = null;

  controller: Controller | undefined = undefined;

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

// --- Classic route wrapper component ---

/**
 * Shared wrapper template. We pair this template with a fresh
 * `ClassicRouteWrapperDefinition` per bucket inside `getRouteWrapper`, so that
 * two routes (potentially sharing a Route class) get distinct wrapper
 * component identities for the outlet stability check.
 *
 * The wrapper renders the per-render invokable (the route's template/component,
 * returned from getInvokable) and forwards `@model` and `@controller` onto it.
 *
 * The outlet helper curries `@Component`, `@routeInfo`, `@model`, and
 * `@controller` onto this wrapper at render time, see the outlet pipeline in
 * `@ember/-internals/glimmer/lib/syntax/outlet`. `@controller` is resolved
 * there to a const ref, because RouteTemplateManager uses it as the inner
 * template's `self` and inner internal components (LinkTo, Input, etc.) assert
 * `isConstRef(caller)`.
 */
const CLASSIC_WRAPPER_TEMPLATE = precompileTemplate(
  `<@Component @model={{@model}} @controller={{@controller}} />`,
  {
    moduleName: 'packages/@ember/-internals/routing/route-managers/classic-route-wrapper.hbs',
    strictMode: true,
  }
);

/**
 * Capabilities for `ClassicRouteWrapperManager`. Match `templateOnlyComponent`'s
 * defaults: no element, no args capture, no instance state.
 */
const CLASSIC_WRAPPER_CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  createArgs: false,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  dynamicScope: false,
  updateHook: false,
  createInstance: false,
  wrapped: false,
  willDestroy: false,
  hasSubOwner: false,
};

/**
 * Component manager for the classic wrapper. Functionally identical to glimmer's
 * `TemplateOnlyComponentManager` except that `getDebugCustomRenderTree` returns
 * an empty array, so the wrapper does not appear as its own node in the render
 * tree. This keeps the render-tree shape the same as before the wrapper layer
 * was introduced.
 */
class ClassicRouteWrapperManager
  implements
    InternalComponentManager<null, ClassicRouteWrapperDefinition>,
    WithCustomDebugRenderTree<null, ClassicRouteWrapperDefinition>
{
  getCapabilities(): InternalComponentCapabilities {
    return CLASSIC_WRAPPER_CAPABILITIES;
  }

  getDebugName(): string {
    return '';
  }

  getDebugCustomRenderTree(): CustomRenderNode[] {
    return [];
  }

  getSelf(): Reference {
    return NULL_REFERENCE;
  }

  getDestroyable(): null {
    return null;
  }
}

const CLASSIC_WRAPPER_MANAGER = new ClassicRouteWrapperManager();
class ClassicRouteWrapperDefinition {
  constructor(public name: string) {}
}

setInternalComponentManager(CLASSIC_WRAPPER_MANAGER, ClassicRouteWrapperDefinition.prototype);
setComponentTemplate(CLASSIC_WRAPPER_TEMPLATE, ClassicRouteWrapperDefinition.prototype);

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

    bucket.controller = bucket.route._initController();

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
    );
  }

  didEnter(
    bucket: ClassicRouteBucket,
    args: NavigationState & NavigationStateWithTransition
  ): void {
    // Cancel the pending loading substate if enter() resolved before it fired.
    if (bucket.loadingSubstateTimer) {
      cancel(bucket.loadingSubstateTimer as any);
      bucket.loadingSubstateTimer = null;
    }

    let route = bucket.route;
    // Read context from the routeInfo (args.to). The routeInfo is the per-render
    // handle
    let context = (args.to as any).context;
    let transition = args.transition;
    let enter = (args as any).enter;

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

  getRouteWrapper(bucket: ClassicRouteBucket): object {
    if (bucket.wrapper !== undefined) {
      return bucket.wrapper;
    }
    // Fresh ClassicRouteWrapperDefinition per bucket so outlet stability
    // checks (`wrapper === lastWrapper`) correctly distinguish two different
    // routes which may share a Route class.
    const wrapper = new ClassicRouteWrapperDefinition(bucket.args.name);
    bucket.wrapper = wrapper;
    return wrapper;
  }

  getInvokable(
    bucket: ClassicRouteBucket,
    enterPromise: Promise<unknown>
  ): Promise<object | undefined> {
    // Build the invokable synchronously, then gate on enterPromise. Awaiting
    // enterPromise ensures onRouteInvokableReady does not fire until data is
    // loaded, whether this is a fresh entry or a re-entry where the model hook
    // runs again. During the wait, the deferred scheduleOnce in willEnter fires
    // and enters the loading substate. Once enter() resolves, the invokable is
    // returned and the real route renders, replacing the loading substate.
    const invokable = this._buildInvokable(bucket);
    return (enterPromise || Promise.resolve()).then(() => invokable);
  }

  // Build the route's user-facing invokable: the user's
  // route template/component (uncurried). Currying with `@model` and
  // `@controller` happens in the wrapper component returned from
  // getRouteWrapper, so this method just looks up the template.
  //
  // Synchronous so EmberRouter.onIntermediateTransition can call it directly
  // for substate routes (loading/error) without awaiting enterPromise.
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

    let invokable: object;

    if (templateFactoryOrComponent) {
      if (hasInternalComponentManager(templateFactoryOrComponent)) {
        // ComponentLike, used as the invokable directly. The VM will resolve
        // its definition when the wrapper renders <@Component />.
        invokable = templateFactoryOrComponent;
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

        // TemplateFactory -> Template -> RouteTemplate (component with no args)
        let template = (templateFactoryOrComponent as TemplateFactory)(owner);
        invokable = makeRouteTemplate(owner, name, template as Template);
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
      invokable = makeRouteTemplate(owner, name, template as Template);
    }

    bucket.invokable = invokable;

    return invokable;
  }
}
