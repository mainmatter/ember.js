import { getOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import { hasInternalComponentManager } from '@glimmer/manager';
import type { Destroyable, TemplateFactory } from '@glimmer/interfaces';
import type Route from '@ember/routing/route';
import type {
  RouteManager,
  RouteCapabilities,
  NavigationState,
  NavigationActions,
  AsyncNavigationState,
  CreateRouteArgs,
} from './route-manager';
import { routeCapabilities } from './route-manager';
import type { RouteStateBucket } from './utils';

// --- Bucket ---

export interface ClassicRouteBucket extends RouteStateBucket {
  route: Route;
  context: unknown;
  invokable: object | undefined;
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

  createRoute(routeInstance: object, args: CreateRouteArgs): ClassicRouteBucket {
    let route = routeInstance as Route;
    route._setRouteName(args.name);

    return {
      route,
      context: undefined,
      invokable: undefined,
      instance: route,
      args,
    };
  }

  getDestroyable(bucket: ClassicRouteBucket): Destroyable | null {
    return bucket.route;
  }

  // --- Enter lifecycle ---

  willEnter(_bucket: ClassicRouteBucket, _args: NavigationState & NavigationActions): void {
    // No-op for classic routes
  }

  enter(
    bucket: ClassicRouteBucket,
    _args: NavigationState & NavigationActions & AsyncNavigationState
  ): Promise<unknown> {
    let route = bucket.route;

    // The classic resolve chain: beforeModel -> model -> afterModel
    // These are called from the router_js resolve phase via resolveViaClassicHooks().
    //
    // For the ClassicRouteManager, `enter()` is called from the manager-driven
    // resolve path in route-info.ts. It runs the three classic hooks in sequence,
    // checking for abort between each step.
    //
    // NOTE: In the current additive migration, the classic hooks are still called
    // via resolveViaClassicHooks() in route-info.ts (the fallback path). Once all
    // routes go through the manager, this method will be the sole entry point for
    // the classic beforeModel/model/afterModel chain.
    //
    // For now, this returns the resolved model (context) and stores it on the bucket.
    // The actual hook calls are handled by the resolveViaClassicHooks path since
    // they need access to the transition and route-info internals.

    // Return the already-resolved context from the bucket (set by resolveViaClassicHooks)
    return Promise.resolve(bucket.context);
  }

  didEnter(bucket: ClassicRouteBucket, _args: NavigationState): void {
    let route = bucket.route;
    let context = bucket.context;
    // Extract transition and enter flag from args (passed by router_js)
    let transition = (_args as any).transition;
    let enter = (_args as any).enter;

    // Classic enter: activate + trigger 'activate' (only on fresh enter, not updates)
    if (enter) {
      route.enter(transition);
    }

    // Set the resolved context on the route object
    route.context = context;
    route.contextDidChange();

    // Run setup (controller wiring, QP handling, rendering)
    route.setup(context, transition);
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
    route.exit(transition);
  }

  didExit(_bucket: ClassicRouteBucket, _args: NavigationState): void {
    // No-op for classic routes
  }

  // --- Template/Component lookup ---

  getInvokable(bucket: ClassicRouteBucket): Promise<object | undefined> {
    let route = bucket.route;
    let owner = getOwner(route);
    assert('Route is unexpectedly missing an owner', owner);

    let name = route.templateName || route.routeName;
    let templateFactoryOrComponent = owner.lookup(`template:${name}`) as
      | TemplateFactory
      | object
      | undefined;

    let template: object;

    if (templateFactoryOrComponent) {
      if (hasInternalComponentManager(templateFactoryOrComponent)) {
        // ComponentLike - pass through directly
        template = templateFactoryOrComponent;
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

        // TemplateFactory -> Template
        template = (templateFactoryOrComponent as TemplateFactory)(owner);
      }
    } else {
      // Default {{outlet}} template
      template = route._topLevelViewTemplate(owner);
    }

    bucket.invokable = template;
    return Promise.resolve(template);
  }
}
