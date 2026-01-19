import type { Owner } from '@glimmer/interfaces';
import type { ManagerFactory, RouteManager } from './classic';
import { DEBUG } from '@glimmer/env';
import { debugToString } from '@glimmer/debug-util';
import { debugAssert } from '@glimmer/global-context';

export interface RouteStateBucket {
  instance: unknown;
  args: object;
}

const ROUTE_MANAGERS = new WeakMap<object, RouteManager<unknown>>();

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

      `Attempted to set a manager on a non-object value. Managers can only be associated with objects or functions. Value was ${debugToString!(
        obj
      )}`
    );

    debugAssert(
      !map.has(obj),
      `Attempted to set the same type of manager multiple times on a value. You can only associate one manager of each type with a given value. Value was ${debugToString!(
        obj
      )}`
    );
  }

  map.set(obj, manager);
  return obj;
}

function getManager<M extends InternalManager>(
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

export function setRouteManager<O extends Owner, T extends object>(
  factory: ManagerFactory<O | undefined, RouteManager<unknown>>,
  obj: T
): T {
  console.log('Setting route manager', obj, factory);
  setManager(ROUTE_MANAGERS, factory(obj), obj);
  ROUTE_MANAGERS.set(obj, factory);
  return obj;
}

export function getRouteManager<T extends object>(definition: T): RouteManager<unknown> | undefined {
  console.log(Object.entries(ROUTE_MANAGERS));
  const manager = getManager(ROUTE_MANAGERS, definition);

  if (manager === undefined) {
    console.log(definition);
    if (DEBUG) {
      debugAssert(
        false,
        `Attempted to load a route, but there wasn't a route manager associated with the definition. The definition was: ${debugToString!(
          definition
        )}`
      );
    }


    return null;
  }

  return manager;
}
