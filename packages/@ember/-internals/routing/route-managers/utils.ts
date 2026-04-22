import type { ManagerFactory, RouteManager } from './route-manager';
import { DEBUG } from '@glimmer/env';
import { debugAssert } from '@glimmer/global-context';

export interface RouteStateBucket {
  invokable?: object;
  route?: object & { manager: RouteManager<RouteStateBucket> };
  context?: unknown;
  args: object;
}

const ROUTE_MANAGERS = new WeakMap<object, ManagerFactory<any, RouteManager<any>>>();

/**
 * There is also Reflect.getPrototypeOf,
 * which errors when non-objects are passed.
 *
 * Since our conditional for figuring out whether to render primitives or not
 * may contain non-object values, we don't want to throw errors when we call this.
 */
const getPrototypeOf = Object.getPrototypeOf;

function setManager<Def extends object>(
  map: WeakMap<object, object>,
  manager: object,
  obj: Def
): Def {
  if (DEBUG) {
    debugAssert(
      obj !== null && (typeof obj === 'object' || typeof obj === 'function'),

      `Attempted to set a manager on a non-object value. Managers can only be associated with objects or functions. Value was ${
        obj
      }`
    );

    debugAssert(
      !map.has(obj),
      `Attempted to set the same type of manager multiple times on a value. You can only associate one manager of each type with a given value. Value was ${
        obj
      }`
    );
  }

  map.set(obj, manager);
  return obj;
}

function getManager<M extends ManagerFactory<any, RouteManager<RouteStateBucket>>>(
  map: WeakMap<object, M>,
  obj: object
): ManagerFactory<any, RouteManager<RouteStateBucket>> | undefined {
  let pointer: object | null = obj;
  while (pointer !== null) {
    const manager = map.get(pointer);

    if (manager !== undefined) {
      return manager;
    }

    pointer = getPrototypeOf(pointer) as object | null;
  }

  return undefined;
}

export function setRouteManager<T extends object>(
  factory: ManagerFactory<any, RouteManager<RouteStateBucket>>,
  definition: T
): T {
  setManager(ROUTE_MANAGERS, factory, definition);

  return definition;
}

export function getRouteManager<T extends object>(
  definition: T
): ManagerFactory<any, RouteManager<RouteStateBucket>> | undefined {
  let factory = getManager(ROUTE_MANAGERS, definition);

  if (factory === undefined) {
    if (DEBUG) {
      debugAssert(
        false,
        `Attempted to load a route, but there wasn't a route manager associated with the definition. The definition was: ${
          definition
        }`
      );
    }
  }

  return factory;
}
