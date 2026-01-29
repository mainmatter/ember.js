import { PioneerRouteManager, setRouteManager } from '@ember/-internals/routing';
import type Owner from '@ember/-internals/owner';
import { getOwner, setOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import EngineInstance from '@ember/engine/instance';
import type { ExtendedInternalRouteInfo } from './route';


export default class PioneerRoute {
  private _names: unknown;
  _router;
  routeName: string;
  fullRouteName: string;
  templateName?: string;

  _setRouteName(name: string) {
    this.routeName = name;
    let owner = getOwner(this);
    assert('Expected route to have EngineInstance as owner', owner instanceof EngineInstance);
    this.fullRouteName = getEngineRouteName(owner, name)!;
  }

  /**
   @private

   @method _stashNames
   */
  _stashNames(
    routeInfo: ExtendedInternalRouteInfo<this>,
    dynamicParent: ExtendedInternalRouteInfo<this>
  ) {
    //debugger;
    if (this._names) {
      return;
    }
    let names = (this._names = routeInfo['_names'])!;

    if (!names.length) {
      routeInfo = dynamicParent;
      names = (routeInfo && routeInfo['_names']) || [];
    }

    // SAFETY: Since `_qp` is protected we can't infer the type
    //let qps = (get(this, '_qp') as Route<Model>['_qp']).qps;

    let namePaths = new Array(names.length);
    for (let a = 0; a < names.length; ++a) {
      namePaths[a] = `${routeInfo.name}.${names[a]}`;
    }

    // for (let qp of qps) {
    //   if (qp.scope === 'model') {
    //     qp.parts = namePaths;
    //   }
    // }
  }

  constructor(owner: Owner) {
    setOwner(this, owner);
    this._router = owner.lookup('router:main');
  }

  // eslint-disable-next-line disable-features/disable-async-await
  async load() {}
}

setRouteManager((owner) => {
  return new PioneerRouteManager(owner);
}, PioneerRoute);

function getEngineRouteName(engine: EngineInstance, routeName: string) {
  if (engine.routable) {
    let prefix = engine.mountPoint;

    if (routeName === 'application') {
      return prefix;
    } else {
      return `${prefix}.${routeName}`;
    }
  }

  return routeName;
}

