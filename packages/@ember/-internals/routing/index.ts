export {
  controllerFor,
  generateController,
  generateControllerFactory,
  DSL as RouterDSL,
} from '@ember/routing/-internals';

export { ClassicRouteManager } from './route-managers/classic';
export { PioneerRouteManager } from './route-managers/pioneer';
export { setRouteManager } from './route-managers/utils';
