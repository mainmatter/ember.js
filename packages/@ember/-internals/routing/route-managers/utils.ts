import type { Owner } from '@glimmer/interfaces';
import type { ManagerFactory, RouteManager } from './route-manager';

export interface RouteStateBucket {
  instance?: unknown;
  args: object;
}

const ROUTE_MANAGERS = new WeakMap<object, RouteManager<RouteStateBucket>>();

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
  map.set(obj, manager);
  return obj;
}

function getManager<M extends RouteManager<RouteStateBucket>>(
  map: WeakMap<object, M>,
  obj: object
): M | undefined {
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

export function setRouteManager<O extends Owner, T extends object | Function>(
  factory: ManagerFactory<O | undefined, RouteManager<RouteStateBucket>>,
  definition: T
): T {
  let manager = factory(undefined);
  setManager(ROUTE_MANAGERS, manager, definition);

  return definition;
}

export function getRouteManager<T extends object>(
  definition: T
): RouteManager<RouteStateBucket> | undefined {
  if (!definition) {
    return undefined;
  }

  return getManager(ROUTE_MANAGERS, definition);
}
