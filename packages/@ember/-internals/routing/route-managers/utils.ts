import type { Owner } from '@glimmer/interfaces';
import { DEBUG } from '@glimmer/env';
import { debugAssert } from '@glimmer/global-context';
import type { ManagerFactory, RouteManager } from './route-manager';

export interface RouteStateBucket {
  instance?: unknown;
  args: object;
}

const ROUTE_MANAGERS = new Map<object, RouteManager<unknown>>();

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
        obj}`
    );
  }

  map.set(obj, manager);
  return obj;
}

function getManager<M extends RouteManager<unknown>>(
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
  factory: ManagerFactory<O | undefined, RouteManager<unknown>>,
  definition: T
): T {
  console.log('Setting route manager', definition, factory);
  setManager(ROUTE_MANAGERS, factory(definition), definition);
  ROUTE_MANAGERS.set(definition, factory);
  //debugger;
  return definition;
}

export function getRouteManager<T extends object>(definition: T): RouteManager<unknown> | undefined {
  console.log("ember-source route manager", Object.entries(ROUTE_MANAGERS));

  let manager;

  if(!definition) {
    let [_,_manager] = [...ROUTE_MANAGERS.entries()].find(([definition, manager]) => {
      return definition.prototype.isFunctional;
    });
    manager = _manager;
  } else {
    manager = getManager(ROUTE_MANAGERS, definition);
  }

  if (manager === undefined) {
    console.log(definition);
    if (DEBUG) {
      debugAssert(
        false,
        `Attempted to load a route, but there wasn't a route manager associated with the definition. The definition was: ${
          definition
        }`
      );
    }


    return null;
  }

  return manager;
}
