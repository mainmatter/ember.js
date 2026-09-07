import type Router from './router';
import type TransitionState from './transition-state';

export type OpaqueIntent = TransitionIntent;

export abstract class TransitionIntent {
  data: object;
  router: Router;
  constructor(router: Router, data: object = {}) {
    this.router = router;
    this.data = data;
  }
  preTransitionState?: TransitionState;
  abstract applyToState(oldState: TransitionState, isIntermediate: boolean): TransitionState;
}
