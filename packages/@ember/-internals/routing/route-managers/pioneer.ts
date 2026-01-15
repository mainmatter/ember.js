import type Owner from '../../owner';

interface PioneerRouteStateBucket {
  instance: unknown;
  args: object;
}

export class PioneerRouteManager {
  private owner: unknown;

  constructor(owner: Owner) {
    this.owner = owner;
  }

  createRoute(definition: unknown, args: any): PioneerRouteStateBucket {
    let instance = new definition.class(this.owner);
    return { instance, args };
  }

  // Just an experiment, by no means final or even WIP
  enterRoute({ instance }: PioneerRouteStateBucket) {
    instance
      .beforeModel()
      .then(() => {
        return instance.model();
      })
      .then(() => {
        return instance.afterModel();
      });
  }

  getDestroyable({ instance }: PioneerRouteStateBucket) {
    return instance;
  }
}
