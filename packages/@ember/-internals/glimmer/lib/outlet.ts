/**
  The outlet primitive.

  The outlet stays a first-class concept, but the framework no longer decides
  what it *means* — the route manager does (see the classic manager's outlet
  frame in `@ember/-internals/routing/route-managers/classic/wrapper.ts`). This
  module — and it alone — is the thin primitive a manager's outlet frame
  implements against. Its whole exported surface is four operations:

  - `currentOutletStateRef` / `outletFrameRef` — the dynamic-scope cursor read
    and the resolution of an OutletState level to the value the `{{outlet}}`
    keyword renders (a manager's `wrapper`, else the `invokable`). The
    `{{outlet}}` keyword is the only caller of these (the OutletState chain
    shape lives with the other state types in `utils/outlet.ts`).
  - `enterOutletFrame` — the one operation a manager's outlet frame performs
    (see below).
  - `outletDebugNodes` — the shared `outlet`/`engine` debug-render-tree node
    shapes a frame emits for its level.

  There is intentionally no framework "outlet component" here. The per-level
  frame is the manager's wrapper (classic routes) or, when a manager renders
  wrapper-less, the route template itself (`component-managers/route-template.ts`).

  ## The wrapper contract

  An outlet frame — the value a manager returns from `getRouteWrapper` — is an
  ordinary component whose manager, in its `create` hook, calls
  `enterOutletFrame(dynamicScope, parentOwner, name)`. That single call reads
  the frame's own OutletState level from the cursor, advances the cursor to the
  child (so a nested `{{outlet}}`/`<@outlet />` resolves one level deeper),
  resolves the child frame value for `@outlet`, computes the (engine-swapped)
  owner, and starts outlet instrumentation — returning all of that as an
  `OutletFrameEntry`. The frame then only has to:

  1. build whatever `self`/args it renders its route with, from the returned
     `render` and `childFrameRef`;
  2. report `owner` from `getOwner` and `finalize` from `didRenderLayout`;
  3. emit `outletDebugNodes(bucket, engine)` from `getDebugCustomRenderTree`.

  Everything else — how the route's component, context, and child outlet
  actually compose — is the frame's own business, not the framework's. The
  classic wrapper (`route-managers/classic/wrapper.ts`) is the reference
  implementation; the wrapper-less route template is the second.
 */

import type { InternalOwner } from '@ember/-internals/owner';
import type EngineInstance from '@ember/engine/instance';
import { _instrumentStart } from '@ember/instrumentation';
import type { CustomRenderNode, DynamicScope } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference/lib/reference';
import { createComputeRef, valueForRef } from '@glimmer/reference/lib/reference';
import { EMPTY_ARGS } from '@glimmer/runtime/lib/vm/arguments';

import type { OutletState, RenderState } from './utils/outlet';

/**
  The dynamic-scope cursor.

  Invariant: at any point during rendering, the `outletState` dynamic-scope
  entry is a ref to the OutletState the *next* frame renders — i.e. the level
  a `{{outlet}}` here would resolve. A frame advances the cursor from its own
  level to its child before rendering its body, so a nested `{{outlet}}` (or
  `<@outlet />`) resolves one level deeper.
 */

/** The ref to the OutletState the current frame renders (its own level). */
export function currentOutletStateRef(
  dynamicScope: DynamicScope
): Reference<OutletState | undefined> {
  return dynamicScope.get('outletState') as Reference<OutletState | undefined>;
}

/**
  Advances the cursor to this level's child and returns the child ref. The
  frame's body (and any `{{outlet}}` in it) then resolves the child. Internal:
  frames reach this through `enterOutletFrame`.
 */
function advanceOutletCursor(
  dynamicScope: DynamicScope,
  selfRef: Reference<OutletState | undefined>
): Reference<OutletState | undefined> {
  let childRef = createComputeRef(() => valueForRef(selfRef)?.outlets?.main);
  dynamicScope.set('outletState', childRef);
  return childRef;
}

/**
  The directly-invokable value the `{{outlet}}` keyword (and `@outlet`) resolve
  to for `stateRef`'s level: the manager's wrapper when it provides one, else
  the invokable itself, or `null` when there is nothing to render. No currying
  anywhere — the value is a component the VM invokes directly.
 */
export function outletFrameRef(stateRef: Reference<OutletState | undefined>): Reference {
  return createComputeRef(() => {
    let render = valueForRef(stateRef)?.render;
    if (render === undefined || render.invokable === undefined) {
      return null;
    }
    return render.wrapper ?? render.invokable;
  });
}

/**
  What `enterOutletFrame` hands back: everything a frame needs to render its
  level, computed from the cursor in one shot.
 */
export interface OutletFrameEntry {
  /** A live ref to this frame's own OutletState level (read for `render`). */
  selfRef: Reference<OutletState | undefined>;
  /**
    This level's render state, captured at `create` time (its `invokable`,
    `name`, and opaque `context`). A frame that must observe later changes to
    the level (e.g. a stable route whose context updates in place) should
    re-read `valueForRef(selfRef)?.render` rather than close over this.
   */
  render: RenderState | undefined;
  /** The owner for this frame's subtree (engine-swapped at a mount point). */
  owner: InternalOwner;
  /**
    A ref to the child level's frame value, for a frame that hands the child
    outlet to its layout as `@outlet`. Resolves to `null` when there is no
    child route.
   */
  childFrameRef: Reference;
  /** Engine-crossing info for the `engine` debug node, or `undefined`. */
  engine: { mountPoint: string; instance: EngineInstance } | undefined;
  /** `render.outlet` instrumentation finalize; call from `didRenderLayout`. */
  finalize: () => void;
}

/**
  Enter an outlet frame: the single operation a manager's outlet frame performs
  in its component manager's `create`. It reads the frame's own OutletState
  level from the cursor, advances the cursor to that level's child (so a nested
  `{{outlet}}`/`<@outlet />` in the frame's body resolves one level deeper),
  resolves the child frame value for `@outlet`, computes the (possibly
  engine-swapped) owner, and starts `render.outlet` instrumentation.

  This is the whole of the framework's outlet mechanics; how the frame then
  composes its route (its `self`, which args it forwards, its debug nodes) is
  the frame's own concern. See "The wrapper contract" above.
 */
export function enterOutletFrame(
  dynamicScope: DynamicScope,
  parentOwner: InternalOwner,
  name: string
): OutletFrameEntry {
  let selfRef = currentOutletStateRef(dynamicScope);
  let render = valueForRef(selfRef)?.render;
  let owner = ((render?.owner as InternalOwner | undefined) ?? parentOwner) as InternalOwner;
  let childRef = advanceOutletCursor(dynamicScope, selfRef);

  return {
    selfRef,
    render,
    owner,
    childFrameRef: outletFrameRef(childRef),
    engine: engineCrossing(owner, parentOwner),
    finalize: startOutletInstrumentation(name),
  };
}

/**
  Whether crossing from `parentOwner` into `owner` crosses an engine mount
  point, and if so the info needed for the `engine` debug node. `owner` is the
  level's own owner (`render.owner`); `parentOwner` is the owner the frame
  renders under (its `create` owner). They differ exactly at a mounted
  engine's boundary. Internal: frames reach this through `enterOutletFrame`.
 */
function engineCrossing(
  owner: InternalOwner,
  parentOwner: InternalOwner | undefined
): { mountPoint: string; instance: EngineInstance } | undefined {
  if (parentOwner === undefined || parentOwner === owner) {
    return undefined;
  }

  if (!('buildChildEngineInstance' in owner)) {
    return undefined;
  }

  let instance = owner as EngineInstance;
  let { mountPoint } = instance;
  return mountPoint ? { mountPoint, instance } : undefined;
}

function instrumentationPayload(name: string) {
  // "main" used to be the outlet name, kept for compatibility.
  return { object: `${name}:main` };
}

/**
  Starts the legacy `render.outlet` instrumentation for one outlet level and
  returns the finalize callback the frame calls once its layout has rendered.
  Kept because instrumentation subscribers still rely on it (see the View
  Instrumentation test). Internal: frames reach this through `enterOutletFrame`.
 */
function startOutletInstrumentation(name: string): () => void {
  return _instrumentStart('render.outlet', instrumentationPayload, name);
}

/**
  The `outlet` debug render-tree node for one level (name `"main"`, no args),
  plus the `engine` node when the level crosses an engine mount point. These
  are the exact shapes the tree has always emitted; the manager's frame owns
  the `outlet` node's debug identity now. `outletBucket` is a stable per-frame
  object used as the node's debug key.
 */
export function outletDebugNodes(
  outletBucket: object,
  engine: { mountPoint: string; instance: EngineInstance } | undefined
): CustomRenderNode[] {
  let nodes: CustomRenderNode[] = [
    {
      bucket: outletBucket,
      type: 'outlet',
      // "main" used to be the outlet name, kept for compatibility.
      name: 'main',
      args: EMPTY_ARGS,
      instance: undefined,
    },
  ];

  if (engine) {
    nodes.push({
      // Key the node on the per-frame `engine` object, not the engine
      // instance: two frames can legitimately cross into the *same* engine at
      // once (e.g. a loading substate and the real route overlapping during
      // teardown), and a shared bucket would collide in the debug tree.
      bucket: engine,
      type: 'engine',
      name: engine.mountPoint,
      args: EMPTY_ARGS,
      instance: engine.instance,
    });
  }

  return nodes;
}
