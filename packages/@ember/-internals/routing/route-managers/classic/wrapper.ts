/**
  The classic route manager's outlet frame — this is the classic manager's
  *implementation of the outlet*.

  The framework keeps the outlet concept (the `{{outlet}}` keyword, the
  OutletState chain, the dynamic-scope cursor; see
  `@ember/-internals/glimmer/lib/outlet.ts`) but does not
  decide what rendering into an outlet means. That meaning lives here: the
  `{{outlet}}` keyword resolves to this frame (via `render.wrapper`), and this
  frame decides how the route's component, model, controller, and child outlet
  compose.

  One frame instance per route definition (bucket), so its identity is
  per-route: when the route at a slot changes, the keyword returns a different
  frame and glimmer tears the old subtree down. That per-route identity is what
  lets each route's subtree keep its own `@model` during teardown (see the
  retaining `context` below). The manager and template on the prototype are
  shared; only the small frame objects are per-bucket.

  The frame's layout forwards the RFC args onto the route's component with no
  currying:

  ```hbs
  <this.Component @model={{this.model}} @controller={{this.controller}} @outlet={{this.outlet}} />
  ```
*/

import type {
  CustomRenderNode,
  DynamicScope,
  Environment,
  InternalComponentCapabilities,
  Reference,
  VMArguments,
  WithCreateInstance,
  WithCustomDebugRenderTree,
  WithSubOwner,
} from '@glimmer/interfaces';
import type { InternalOwner } from '@ember/-internals/owner';
import type EngineInstance from '@ember/engine/instance';
import { setInternalComponentManager } from '@glimmer/manager/lib/internal/api';
import { setComponentTemplate } from '@glimmer/manager/lib/public/template';
import { createConstRef, valueForRef } from '@glimmer/reference/lib/reference';
import { precompileTemplate } from '@ember/template-compilation';
import { enterOutletFrame, outletDebugNodes } from '@ember/-internals/glimmer/lib/outlet';

// Forwards the route's model / controller / child-outlet onto the route's
// component (`this.Component`), read from `this.*` (the frame self) rather than
// from `@args` — the keyword invokes the frame with no args, which is what
// keeps currying out of the outlet path. `@outlet` is `null` when there is no
// child route, so GJS route templates that render `<@outlet />` should guard
// with `{{#if @outlet}}` (invoking `null` is a DEBUG-time error); classic
// templates use the `{{outlet}}` keyword, which renders nothing when empty.
const CLASSIC_OUTLET_TEMPLATE = precompileTemplate(
  `<this.Component @model={{this.model}} @controller={{this.controller}} @outlet={{this.outlet}} />`,
  {
    moduleName: 'packages/@ember/-internals/routing/route-managers/classic/wrapper.hbs',
    strictMode: true,
  }
);

interface ClassicOutletInstance {
  self: Reference;
  owner: InternalOwner;
  engine: { mountPoint: string; instance: EngineInstance } | undefined;
  finalize: () => void;
}

// The self object the frame's template reads. Built once per frame instance;
// its getters read the level's live OutletState so a stable route re-renders
// in place when its model changes.
interface ClassicOutletSelf {
  readonly Component: object;
  readonly model: unknown;
  readonly controller: unknown;
  readonly outlet: unknown;
}

const CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  createArgs: false,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  // Drives the `{{outlet}}` cursor for its subtree (see `create`).
  dynamicScope: true,
  updateHook: false,
  createInstance: true,
  wrapped: false,
  willDestroy: false,
  // The frame owns the owner for its subtree — this is where classic engine
  // mount-point owner-swapping happens now.
  hasSubOwner: true,
};

class ClassicOutletManager
  implements
    WithCreateInstance<ClassicOutletInstance, ClassicRouteOutlet>,
    WithCustomDebugRenderTree<ClassicOutletInstance, ClassicRouteOutlet>,
    WithSubOwner<ClassicOutletInstance>
{
  create(
    parentOwner: InternalOwner,
    definition: ClassicRouteOutlet,
    _args: VMArguments,
    _env: Environment,
    dynamicScope: DynamicScope
  ): ClassicOutletInstance {
    // Enter this level's outlet frame: reads the level the keyword resolved
    // this frame from (its `render.wrapper`), advances the cursor to the child
    // so the route template's own `{{outlet}}`/`<@outlet />` resolves one level
    // deeper, and computes the owner, engine crossing, child frame, and
    // instrumentation.
    let { selfRef, render, owner, childFrameRef, engine, finalize } = enterOutletFrame(
      dynamicScope,
      parentOwner,
      definition.name
    );

    // Fixed for the frame's lifetime: the route's component, the route identity
    // used to detect when this route stops occupying the slot.
    let invokable = render?.invokable as object;

    // `@context` retain-while-occupying: refresh model/controller from the
    // live level only while this route still occupies the slot (its invokable
    // is unchanged). Once a different route (or nothing) takes the slot, hold
    // the last snapshot so this route's outgoing subtree reads its final
    // values during teardown (e.g. a component's `willDestroy`) rather than
    // the incoming route's values.
    let lastContext: { model: unknown; controller: unknown } | undefined;
    let context = (): { model: unknown; controller: unknown } | undefined => {
      let current = valueForRef(selfRef)?.render;
      if (current !== undefined && current.invokable === invokable) {
        lastContext = current.context as { model: unknown; controller: unknown } | undefined;
      }
      return lastContext;
    };

    let self: ClassicOutletSelf = {
      Component: invokable,
      get model() {
        return context()?.model;
      },
      get controller() {
        return context()?.controller;
      },
      get outlet() {
        return valueForRef(childFrameRef);
      },
    };

    return {
      self: createConstRef(self, 'this'),
      owner,
      engine,
      finalize,
    };
  }

  getOwner(instance: ClassicOutletInstance): InternalOwner {
    return instance.owner;
  }

  getSelf(instance: ClassicOutletInstance): Reference {
    return instance.self;
  }

  getDebugName(definition: ClassicRouteOutlet): string {
    return `{{outlet}} for ${definition.name}`;
  }

  // Emit the `outlet` (and, at an engine crossing, `engine`) debug node for
  // this level. The route template rendered as `this.Component` emits the
  // `route-template` node as this frame's child, reproducing the classic
  // `outlet` > (`engine` >) `route-template` shape.
  getDebugCustomRenderTree(
    _definition: ClassicRouteOutlet,
    instance: ClassicOutletInstance
  ): CustomRenderNode[] {
    return outletDebugNodes(instance, instance.engine);
  }

  getCapabilities(): InternalComponentCapabilities {
    return CAPABILITIES;
  }

  didCreate(): void {}
  didUpdate(): void {}

  didRenderLayout(instance: ClassicOutletInstance): void {
    instance.finalize();
  }

  didUpdateLayout(): void {}

  getDestroyable(): null {
    return null;
  }
}

const CLASSIC_OUTLET_MANAGER = /*@__PURE__*/ new ClassicOutletManager();

/**
  A per-bucket outlet frame. The route `name` (stamped by the manager) is
  carried for the debug render tree / backtracking-assertion frame name
  (`{{outlet}} for <route>`).
 */
export class ClassicRouteOutlet {
  name = '';
}

setInternalComponentManager(CLASSIC_OUTLET_MANAGER, ClassicRouteOutlet.prototype);
setComponentTemplate(CLASSIC_OUTLET_TEMPLATE, ClassicRouteOutlet.prototype);

/**
  Builds a classic outlet frame. One per bucket so the frame's identity is
  per-route (see the module comment). The manager stamps the route name.
 */
export function makeClassicOutlet(): ClassicRouteOutlet {
  return new ClassicRouteOutlet();
}
