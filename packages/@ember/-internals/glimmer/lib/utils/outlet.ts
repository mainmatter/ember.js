import type { InternalOwner } from '@ember/-internals/owner';
import type { Template } from '@glimmer/interfaces';
import type { RouteInfo } from 'router_js';
import type { RouteStateBucket } from '../../../routing';

export interface RenderState {
  /**
   * This is usually inherited from the parent (all the way up to the app
   * instance). However, engines uses this to swap out the owner when crossing
   * a mount point.
   */
  owner: InternalOwner;

  /**
   * The name of the route/template
   */
  name: string;

  /**
   * The wrapper component returned from `manager.getRouteWrapper`.
   * The outlet curries `@Component` (the invokable below) and `@routeInfo`
   * onto this wrapper at render time.
   *
   * Manager-driven routes set this. Code that builds OutletState manually
   * (e.g. older versions of @ember/test-helpers, liquid-fire) leaves it
   * undefined and relies on the `template` field below.
   */
  wrapper?: object;

  /**
   * The per-render invokable returned from `manager.getInvokable`. The user's
   * actual route template/component (uncurried). The outlet curries this onto
   * the wrapper as `@Component`.
   */
  invokable?: object;

  bucket?: RouteStateBucket;

  /**
   * The router's per-render handle for this route. The wrapper template can
   * read whatever it needs (model, route, etc.) from this.
   */
  routeInfo?: RouteInfo;

  /**
   * Raw template or already-resolved component for the legacy OutletState path.
   * Only used when `wrapper`/`invokable` are not set, i.e. when external code
   * (older @ember/test-helpers, liquid-fire-style addons) constructs
   * OutletState manually rather than going through a route manager.
   */
  template?: Template | object;
}

export interface OutletState {
  /**
   * Represents what was rendered into this outlet.
   */
  render: RenderState | undefined;

  /**
   * Represents what, if any, should be rendered into the next {{outlet}} found
   * at this level.
   *
   * This used to be a dictionary of children outlets, including the {{outlet}}
   * "main" outlet any {{outlet "named"}} named outlets. Since named outlets
   * are not a thing anymore, this can now just be a single`child`.
   */
  outlets: {
    main: OutletState | undefined;
  };
}
