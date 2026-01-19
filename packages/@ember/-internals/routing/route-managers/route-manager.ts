import type { Capabilities } from '@glimmer/interfaces';
import type { RouteStateBucket } from './utils';

export interface RouteManager<R extends RouteStateBucket> {
  capabilities: Capabilities;
  createRoute(definition: object, args: object): R;
  enterRoute(): Promise<unknown> | unknown;
}

export type Manager = RouteManager<unknown>; // TODO: do we merge this with @glimmer/manager manager types?
export type ManagerFactory<O, D extends Manager = Manager> = (owner: O) => D;
