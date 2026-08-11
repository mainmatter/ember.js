/**
  The factory used for `route:basic` — the base class auto-generated routes
  extend, and the one registration engines clone from their parent.

  It is a slot rather than a direct import so that `@ember/application` does
  not have to import `@ember/routing/route`: that module registers the classic
  route manager as an import-time side effect, so importing it from application
  setup would force every app — including one whose routes are all driven by
  app-defined route managers — to load the whole classic route implementation.

  Classic fills the slot itself, at the bottom of `@ember/routing/route`. Any
  app with a single classic route file therefore fills it before boot, and an
  app with none never loads classic at all.

  @private
*/

import type { InternalFactory } from '@ember/-internals/owner';

// The slot value is only ever handed straight back to `register`, so the
// factory contract is all it needs to satisfy.
type RouteFactory = InternalFactory<object>;

let DEFAULT_ROUTE_FACTORY: RouteFactory | undefined;

export function setDefaultRouteFactory(factory: RouteFactory): void {
  DEFAULT_ROUTE_FACTORY = factory;
}

export function getDefaultRouteFactory(): RouteFactory | undefined {
  return DEFAULT_ROUTE_FACTORY;
}
