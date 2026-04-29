import { Promise } from 'rsvp';
import type { Dict } from './core';
import type { Route } from './route-info';
import type InternalRouteInfo from './route-info';
import type Transition from './transition';
import { forEach, promiseLabel } from './utils';
import { throwIfAborted } from './transition-aborted-error';

interface IParams {
  [key: string]: unknown;
}

function handleError<R extends Route>(
  currentState: TransitionState<R>,
  transition: Transition<R>,
  error: Error
): never {
  // This is the only possible
  // reject value of TransitionState#resolve
  let routeInfos = currentState.routeInfos;
  let errorHandlerIndex =
    transition.resolveIndex >= routeInfos.length ? routeInfos.length - 1 : transition.resolveIndex;

  let wasAborted = transition.isAborted;

  throw new TransitionError(
    error,
    currentState.routeInfos[errorHandlerIndex]!.route!,
    wasAborted,
    currentState
  );
}

function resolveOneRouteInfo<R extends Route>(
  currentState: TransitionState<R>,
  transition: Transition<R>
): void | Promise<void> {
  if (transition.resolveIndex === currentState.routeInfos.length) {
    // All routes in this transition have had their getInvokable() resolved.
    // This is the only fulfill value of TransitionState#resolve.
    return;
  }

  let routeInfo = currentState.routeInfos[transition.resolveIndex]!;

  let callback = proceed.bind(null, currentState, transition) as (
    readyRouteInfo: InternalRouteInfo<R>
  ) => void | Promise<void>;

  return routeInfo.resolve(transition).then(callback, null, currentState.promiseLabel('Proceed'));
}

function proceed<R extends Route>(
  currentState: TransitionState<R>,
  transition: Transition<R>,
  readyRouteInfo: InternalRouteInfo<R>
): void | Promise<void> {
  const routeIndex = transition.resolveIndex;
  currentState.routeInfos[transition.resolveIndex++] = readyRouteInfo;

  // Notify the router that this route's invokable is ready. EmberRouter uses
  // this to place the route at routeIndex in currentRouteInfos, replacing any
  // loading/error substate that was entered for this position, and schedules
  // _setOutlets so the outlet tree is updated before enter() finishes.
  transition.router.onRouteInvokableReady(readyRouteInfo, transition, routeIndex);

  // Skip redirect for intermediate transitions (loading/error substates). Their
  // routeInfos come from applyToState already resolved and never run the model
  // hook in this transition, so a redirect callback would be inappropriate.
  if (!transition.isIntermediate) {
    // Call the redirect hook now that the route's model has resolved. Calling
    // it here, between resolution and the next route's resolution, lets a
    // redirect into a child route skip re-running this route's model hook.
    const route = readyRouteInfo.route;
    if (route !== undefined && route.redirect) {
      route.redirect(readyRouteInfo.context, transition);
    }
  }

  throwIfAborted(transition);

  return resolveOneRouteInfo(currentState, transition);
}

export default class TransitionState<R extends Route> {
  routeInfos: InternalRouteInfo<R>[] = [];
  queryParams: Dict<unknown> = {};
  params: IParams = {};

  promiseLabel(label: string) {
    let targetName = '';
    forEach(this.routeInfos, function (routeInfo) {
      if (targetName !== '') {
        targetName += '.';
      }
      targetName += routeInfo.name;
      return true;
    });
    return promiseLabel("'" + targetName + "': " + label);
  }

  resolve(transition: Transition<R>): Promise<TransitionState<R>> {
    // First, calculate params for this state. This is useful
    // information to provide to the various route hooks.
    let params = this.params;
    forEach(this.routeInfos, (routeInfo) => {
      params[routeInfo.name] = routeInfo.params || {};
      return true;
    });

    transition.resolveIndex = 0;

    let callback = resolveOneRouteInfo.bind(null, this, transition);
    let errorHandler = handleError.bind(null, this, transition);

    // The prelude RSVP.resolve() async moves us into the promise land.
    return Promise.resolve(null, this.promiseLabel('Start transition'))
      .then(callback, null, this.promiseLabel('Resolve route'))
      .catch(errorHandler, this.promiseLabel('Handle error'))
      .then(() => this);
  }
}

export class TransitionError {
  constructor(
    public error: Error,
    public route: Route,
    public wasAborted: boolean,
    public state: TransitionState<any>
  ) {}
}
