import type { Capabilities } from '@glimmer/interfaces';
import type Owner from '../../owner';
import type Route from '@ember/routing/route';
import type { RouteStateBucket } from './utils';

export interface RouteCapabilities extends Capabilities {

}

export interface RouteManager<RouteStateBucket> {
  capabilities: RouteCapabilities
  createRoute(definition: object, args: object): RouteStateBucket;
  enterRoute(): Promise<unknown> | unknown;
}

export type Manager = RouteManager<unknown>; // TODO: do we merge this with @glimmer/manager manager types?
export type ManagerFactory<O, D extends Manager = Manager> = (owner: O) => D;

interface ClassicRouteStateBucket extends RouteStateBucket {
  instance: Route;
  args: object;
}

export class ClassicRouteManager {
  private owner: unknown;

  constructor(owner: Owner) {
    this.owner = owner;
  }

  createRoute(definition: unknown, args: any): ClassicRouteStateBucket {
    let instance = definition.create(this.owner);
    return { instance, args };
  }

  // Just an experiment, by no means final or even WIP
  enterRoute({ instance }: ClassicRouteStateBucket) {
    instance.beforeModel().then(() => {
      return instance.model();
    }).then(() => {
      return instance.afterModel();
    });
  }

  getDestroyable({ instance }: ClassicRouteStateBucket) {
    return instance;
  };
}
