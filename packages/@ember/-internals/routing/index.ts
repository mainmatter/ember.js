export {
  controllerFor,
  generateController,
  generateControllerFactory,
  DSL as RouterDSL,
} from '@ember/routing/-internals';

export { setRouteManager, getRouteManager } from './route-managers/utils';
export type { RouteStateBucket } from './route-managers/utils';
export { ClassicRouteManager } from './route-managers/classic-route-manager';
export type { ClassicRouteBucket } from './route-managers/classic-route-manager';
export type {
  RouteManager,
  RouteCapabilities,
  NavigationState,
  NavigationActions,
  AsyncNavigationState,
  CreateRouteArgs,
} from './route-managers/route-manager';
export { routeCapabilities } from './route-managers/route-manager';
