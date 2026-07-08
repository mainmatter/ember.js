import type { InternalOwner } from '@ember/-internals/owner';
import type { Reference } from '@glimmer/reference/lib/reference';

export interface RenderState {
  // --- Router-driven fields ------------------------------------------------
  // Every manager render (`RouteManager.getRenderState`) provides these; they
  // are the only render state the framework outlet core reads. Notably there
  // is no `model`/`controller` here: per-instance state is carried opaquely in
  // `context`, so model and controller stay internal to the route manager.

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
   * Opaque per-instance value supplied by the route manager via
   * `getRenderState`. The outlet forwards it to the render target as
   * `@context` without inspecting it — its shape is the manager's concern.
   */
  context?: unknown;

  /**
   * The manager's outlet frame for this route (its outlet implementation),
   * from `RouteManager.getRouteWrapper`. The `{{outlet}}` keyword resolves to
   * this value; it is what renders the route and composes its child outlet.
   * `undefined` when the manager renders wrapper-less (the keyword then
   * resolves the invokable directly).
   */
  wrapper: object | undefined;

  /**
   * The per-render invokable returned by `RouteManager.getInvokable` — the
   * route's component. The outlet frame renders it as `<this.Component>`.
   */
  invokable: object | undefined;

  // --- Legacy `setOutletState` inputs only ---------------------------------
  // Populated solely by legacy callers (older test-helpers, liquid-fire-style
  // addons) that hand `OutletView.setOutletState` a raw `{ name, template,
  // controller }`. `upgradeLegacyOutletState` normalizes these into an
  // `invokable` before the outlet core sees the render; the router-driven
  // path never sets them.

  /**
   * The controller used as the `self` (`this`) of a route template built from
   * a raw legacy `template`.
   */
  controller?: unknown;

  /**
   * Legacy template. Usually a `Template`, but a pre-built component
   * definition is also accepted (see `legacy-outlet-state`).
   */
  template?: object;
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

/**
  The root outlet state owned by `OutletView`. The `ref` is the head of the
  outlet-state ref chain the cursor walks (see the outlet primitive in
  `../outlet.ts`); `invokable` is the upgraded root template (the `-outlet`
  template whose whole body is the `{{outlet}}` keyword). It is the one render
  whose frame the renderer seeds directly.
 */
export interface OutletDefinitionState {
  ref: Reference<OutletState | undefined>;
  name: string;
  invokable?: object;
}
