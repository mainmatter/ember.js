import { getOwner, setOwner } from '@ember/-internals/owner';
import { assert, info } from '@ember/debug';
import { get } from '@ember/-internals/metal';
import { DEBUG } from '@glimmer/env';
import { hasInternalComponentManager } from '@glimmer/manager';
import type { CurriedComponent, Destroyable, Template, TemplateFactory } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference';
import { createComputeRef } from '@glimmer/reference';
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
import { once } from '@ember/runloop';
import { Promise } from 'rsvp';

// --- Bucket ---

export class ClassicRouteBucket implements RouteStateBucket {
  route: Route;
  @tracked context: unknown;
  controller: unknown;
  invokable: object | undefined;
  instance: object;
  args: CreateRouteArgs;

  constructor(route: Route, args: CreateRouteArgs) {
    this.route = route;
    this.context = undefined;
    this.controller = undefined;
    this.invokable = undefined;
    this.instance = route;
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

    return new ClassicRouteBucket(route, args);
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

  willEnter(_bucket: ClassicRouteBucket, _args: NavigationState & NavigationActions): void {
    // No-op for classic routes
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
    let route = bucket.route;
    let context = bucket.context;
    // Extract transition and enter flag from args (passed by router_js)
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

    // Sync the controller onto the bucket so that the
    // the invokable (see getInvokable) picks it up.
    bucket.controller = route.controller;

    if (route._environment?.options?.shouldRender !== false) {
      once(route._router, '_setOutlets');
    }
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
    // Return cached invokable if already built
    if (bucket.invokable !== undefined) {
      return Promise.resolve(bucket.invokable);
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
        // Not resolved yet — the VM needs to look up its definition.
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

    // Create refs that read from the bucket. The bucket fields are populated
    // later (context during enter(), controller during didEnter()), so these
    // refs start as undefined and resolve lazily.
    //
    // Controller: a tag-free compute ref. It's read lazily (first read happens
    // during rendering, after didEnter has set bucket.controller).
    //
    // Model: bucket.context is @tracked, so this compute ref auto-tracks it
    // and re-evaluates when the model changes (e.g. navigating to the same
    // route with different dynamic segments).
    let named = dict<Reference>();
    named['controller'] = createComputeRef(() => bucket.controller);
    named['model'] = createComputeRef(() => bucket.context);

    let args = createCapturedArgs(named, EMPTY_POSITIONAL);

    // Curry @controller and @model onto the component so the invokable is
    // self-contained. The outlet rendering pipeline no longer needs to know
    // about model or controller.
    let invokable = curry(0 as CurriedComponent, component, owner, args, isResolved);

    bucket.invokable = invokable;
    return Promise.resolve(invokable);
  }
}
