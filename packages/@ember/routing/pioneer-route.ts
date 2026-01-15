import { PioneerRouteManager, setRouteManager } from '@ember/-internals/routing';

export default class PioneerRoute {
  beforeModel() {}
  model() {}
  afterModel() {}
}

setRouteManager((owner) => {
  return new PioneerRouteManager(owner);
}, PioneerRoute);
