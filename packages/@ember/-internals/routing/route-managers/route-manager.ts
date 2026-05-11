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

  /**
   * Retrieve the ancestor promise for an ancestor route, to await async ancestor behaviour.
   * If no routeInfo is passed, returns the immediate parent route's promise.
   */
  getAncestorPromise(routeInfo?: RouteInfo): ReturnType<RouteManager<RouteStateBucket>['enter']>;
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

  createRoute(factory: object, args: CreateRouteArgs): R;
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

  /**
   * Returns a module-stable wrapper component the router curries the
   * per-render invokable into. The same value should be returned for every
   * call with the same bucket (and ideally for every bucket sharing the same
   * underlying route definition). The router curries `@Component` (the
   * invokable from getInvokable) and the model and controller onto it; managers
   * may use either of those args to derive whatever they need to render.
   */
  getRouteWrapper(bucket: R): object;

  /**
   * Called per transition. The `enterPromise` arg is the promise returned from
   * the matching call to `enter()`. Managers may await it (classic, to gate
   * rendering on data load) or ignore it (pioneer-style, to render immediately
   * and let the wrapper component coordinate loading state).
   */
  getInvokable(bucket: R, enterPromise: Promise<unknown>): Promise<object | undefined>;
}

// --- Factory type ---

export type Manager = RouteManager<RouteStateBucket>;
export type ManagerFactory<O, D extends Manager = Manager> = (owner: O) => D;
