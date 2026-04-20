export { LinkTo } from '@ember/-internals/glimmer';
export { setRouteManager } from '@ember/-internals/routing/route-managers/utils';
export { ClassicRouteManager } from '@ember/-internals/routing/route-managers/classic-route-manager';
export { routeCapabilities } from '@ember/-internals/routing/route-managers/route-manager';

import type { RouteStateBucket } from '@ember/-internals/routing';
import type { RouteManager as InternalRouteManager } from '@ember/-internals/routing/route-managers/route-manager';

export type RouteManager = InternalRouteManager<RouteStateBucket>;
