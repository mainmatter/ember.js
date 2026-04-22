import type { Capabilities, Destroyable } from '@glimmer/interfaces';
import type { RouteStateBucket } from './utils';
import type { RouteInfo } from '@ember/routing/-internals';
import type Transition from '../../../routing/transition';

// --- Capabilities ---

export interface RouteCapabilitiesVersions {
  '1.0': {
    classicInterop?: boolean;
  };
}

export interface RouteCapabilities extends Capabilities {
  classicInterop: boolean;
}

export function routeCapabilities<Version extends keyof RouteCapabilitiesVersions>(
  _managerAPI: Version,
  options: RouteCapabilitiesVersions[Version] = {}
): RouteCapabilities {
  let capabilities = {
    classicInterop: Boolean(options.classicInterop),
  };

  Object.freeze(capabilities);

  // The Capabilities brand is structural (a unique symbol that only exists in the
  // type system). We cast here the same way @glimmer/manager's buildCapabilities does.
  return capabilities as RouteCapabilities;
}

// --- Navigation args ---

export interface NavigationState {
  from?: RouteInfo;
  to: RouteInfo;
}

export interface NavigationActions {
  /** Cancels the current navigation */
  cancel: () => void;
}

export interface AsyncNavigationState {
  /** Signal for the current navigation */
  signal?: AbortSignal;

  /** Retrieve the ancestor promise for an ancestor route, to await async ancestor behaviour. */
  getAncestorPromise(routeInfo: RouteInfo): ReturnType<RouteManager<RouteStateBucket>['enter']>;
}

export interface NavigationStateWithTransition extends NavigationState {
  transition: Transition;
}

export interface CreateRouteArgs {
  name: string;
}

// --- RouteManager interface ---

export interface RouteManager<R extends RouteStateBucket> {
  capabilities: RouteCapabilities;

  createRoute(definition: object, args: CreateRouteArgs): R;
  getDestroyable(bucket: R): Destroyable | null;

  willEnter(
    bucket: R,
    args: NavigationState & NavigationActions & NavigationStateWithTransition
  ): void;
  enter(
    bucket: R,
    args: NavigationState & NavigationActions & AsyncNavigationState & NavigationStateWithTransition
  ): Promise<unknown>;
  didEnter(bucket: R, args: NavigationState & NavigationStateWithTransition): void;

  willExit(
    bucket: R,
    args: NavigationState & NavigationActions & NavigationStateWithTransition
  ): void;
  exit(bucket: R, args: NavigationState & NavigationStateWithTransition): void;
  didExit(bucket: R, args: NavigationState & NavigationStateWithTransition): void;

  getInvokable(bucket: R): Promise<object | undefined>;
}

// --- Factory type ---

export type Manager = RouteManager<RouteStateBucket>;
export type ManagerFactory<O, D extends Manager = Manager> = (owner: O) => D;
