import { get } from '@ember/-internals/metal/lib/property_get';
import getProperties from '@ember/-internals/metal/lib/get_properties';
import { isProxy } from '@ember/-internals/utils/lib/is_proxy';
import { assert } from '@ember/debug';

/**
  The implementation behind `Route#serialize`.

  It lives here, rather than on the classic `Route` class, because the router
  needs both this function and `hasDefaultSerialize` while it must *not* pull
  in `@ember/routing/route` — importing that module registers the classic route
  manager, which apps that define their own route managers should never pay
  for.

  The function uses no `this`, so `Route.prototype.serialize` can be this exact
  function object (see the `Route.reopen` call in `@ember/routing/route`). That
  identity is load-bearing: `hasDefaultSerialize` is how the router detects a
  route which has *not* overridden `serialize`.

  @private
*/
export function defaultSerialize<Model>(
  model: Model,
  params: string[]
): { [key: string]: unknown } | undefined {
  if (params.length < 1 || !model) {
    return;
  }

  let object: Record<string, unknown> = {};
  if (params.length === 1) {
    let [name] = params;
    assert('has name', name);
    if (typeof model === 'object' && name in model) {
      object[name] = get(model, name);
    } else if (/_id$/.test(name)) {
      object[name] = get(model, 'id');
    } else if (isProxy(model)) {
      object[name] = get(model, name);
    }
  } else {
    object = getProperties(model, params);
  }

  return object;
}

/**
  Whether `route` still uses `defaultSerialize`, i.e. has not defined its own
  `serialize`. Compares by identity, so `defaultSerialize` must be installed on
  the prototype unwrapped.

  @private
*/
export function hasDefaultSerialize(route: { serialize?: unknown }): boolean {
  return route.serialize === defaultSerialize;
}

/**
  Whether `route` supplies a `serialize` of its own.

  Deliberately not `!hasDefaultSerialize(route)`. A route class that has no
  `serialize` at all — anything not descended from classic `Route` — has not
  overridden anything; it simply never had one, and the router serializes it
  through `defaultSerialize` anyway. Only a route that carries a `serialize`
  which is not `defaultSerialize` has actually made a choice.

  @private
*/
export function overridesSerialize(route: { serialize?: unknown }): boolean {
  return route.serialize !== undefined && route.serialize !== defaultSerialize;
}
