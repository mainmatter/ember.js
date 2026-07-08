import type { InternalOwner } from '@ember/-internals/owner';
import type {
  CapturedArguments,
  CompilableProgram,
  ComponentDefinition,
  CurriedComponent,
  CustomRenderNode,
  Destroyable,
  DynamicScope,
  Environment,
  InternalComponentCapabilities,
  Template,
  VMArguments,
  WithCreateInstance,
  WithCustomDebugRenderTree,
  WithSubOwner,
} from '@glimmer/interfaces';
import type { Nullable } from '@ember/-internals/utility-types';
import type EngineInstance from '@ember/engine/instance';
import { capabilityFlagsFrom } from '@glimmer/manager/lib/util/capabilities';
import type { Reference } from '@glimmer/reference/lib/reference';
import { UNDEFINED_REFERENCE, valueForRef } from '@glimmer/reference/lib/reference';
import { curry, type CurriedValue } from '@glimmer/runtime/lib/curried-value';
import { createCapturedArgs } from '@glimmer/runtime/lib/vm/arguments';
import { unwrapTemplate } from './unwrap-template';
import { enterOutletFrame, outletDebugNodes } from '../outlet';

interface RouteTemplateInstanceState {
  self: Reference;
  // The owner for this template's subtree. When this template renders
  // wrapper-less (see `create`) it is the outlet frame for its level, so it
  // owns the owner-swap; otherwise it inherits the wrapper's owner.
  owner: InternalOwner;
  // Set only on the wrapper-less path: the outlet debug node's key, and the
  // engine info when the level crosses an engine mount point. `undefined`
  // when a wrapper is present (the wrapper already emitted the `outlet` node).
  outletBucket: object | undefined;
  engine: { mountPoint: string; instance: EngineInstance } | undefined;
  // `render.outlet` instrumentation finalize, on the wrapper-less path only
  // (the wrapper runs it otherwise); a no-op when a wrapper is present.
  finalize: () => void;
}

export interface RouteTemplateDefinitionState {
  name: string;
  self: Reference;
}

const CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  createArgs: true,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  // Advances the `{{outlet}}` cursor for its subtree (see `create`).
  dynamicScope: true,
  updateHook: false,
  createInstance: true,
  wrapped: false,
  willDestroy: false,
  // When rendered wrapper-less, this template is its level's outlet frame and
  // owns the owner-swap; see `create` / `getOwner`.
  hasSubOwner: true,
};

const CAPABILITIES_MASK = /*@__PURE__*/ capabilityFlagsFrom(CAPABILITIES);

class RouteTemplateManager
  implements
    WithCreateInstance<RouteTemplateInstanceState, RouteTemplateDefinitionState>,
    WithCustomDebugRenderTree<RouteTemplateInstanceState, RouteTemplateDefinitionState>,
    WithSubOwner<RouteTemplateInstanceState>
{
  create(
    parentOwner: InternalOwner,
    definition: RouteTemplateDefinitionState,
    args: VMArguments,
    _env: Environment,
    dynamicScope: DynamicScope
  ): RouteTemplateInstanceState {
    // A route template receives `@outlet` only when a manager's outlet frame
    // (e.g. the classic wrapper) rendered it: that frame already advanced the
    // cursor and emitted the `outlet` debug node, and set the owner. Here the
    // cursor already points at this template's child, so `{{outlet}}` in the
    // body resolves it directly — nothing to do.
    if (args.named.has('outlet')) {
      return {
        self: definition.self,
        owner: parentOwner,
        outletBucket: undefined,
        engine: undefined,
        finalize: NOOP,
      };
    }

    // No `@outlet`: this template is rendered wrapper-less (a manager that
    // opted out of a wrapper, a legacy `setOutletState` render, or the root
    // `-outlet` template), so it is the outlet frame for its own level.
    // Entering the frame advances the cursor to the child (so its `{{outlet}}`
    // resolves one level deeper) and takes over the owner-swap; it also emits
    // the `outlet` debug node itself (see `getDebugCustomRenderTree`).
    let { owner, engine, finalize } = enterOutletFrame(dynamicScope, parentOwner, definition.name);

    return {
      self: definition.self,
      owner,
      outletBucket: {},
      engine,
      finalize,
    };
  }

  getOwner(state: RouteTemplateInstanceState): InternalOwner {
    return state.owner;
  }

  getSelf({ self }: RouteTemplateInstanceState): Reference {
    return self;
  }

  getDebugName({ name }: RouteTemplateDefinitionState) {
    return `route-template (${name})`;
  }

  getDebugCustomRenderTree(
    { name }: RouteTemplateDefinitionState,
    state: RouteTemplateInstanceState,
    args: CapturedArguments
  ): CustomRenderNode[] {
    let routeTemplateNode: CustomRenderNode = {
      bucket: state,
      type: 'route-template',
      name,
      args: withoutFrameworkArgs(args),
      instance: valueForRef(state.self),
    };

    // Wrapper-less: this template is also the level's outlet frame, so it
    // emits the `outlet` (and, at an engine crossing, `engine`) node as this
    // route-template node's parent — reproducing the `outlet` > `route-template`
    // shape a wrapped route gets from its wrapper.
    if (state.outletBucket !== undefined) {
      return [...outletDebugNodes(state.outletBucket, state.engine), routeTemplateNode];
    }

    return [routeTemplateNode];
  }

  getCapabilities(): InternalComponentCapabilities {
    return CAPABILITIES;
  }

  didRenderLayout(state: RouteTemplateInstanceState): void {
    state.finalize();
  }

  didUpdateLayout() {}

  didCreate() {}
  didUpdate() {}

  getDestroyable(): Nullable<Destroyable> {
    return null;
  }
}

const NOOP = (): void => {};

// Named args the outlet boundary (and the classic wrapper) plumb through the
// render path. They are framework wiring, not route-template inputs; hide
// them from the debug render tree so a route-template node keeps its classic
// args shape (`model`/`controller` only) for the Ember Inspector.
const FRAMEWORK_ARG_NAMES = ['Component', 'context', 'bucket', 'outlet'];

function withoutFrameworkArgs(args: CapturedArguments): CapturedArguments {
  let named: Record<string, Reference> = {};

  for (let key of Object.keys(args.named)) {
    if (!FRAMEWORK_ARG_NAMES.includes(key)) {
      named[key] = args.named[key] as Reference;
    }
  }

  return createCapturedArgs(named, args.positional);
}

const ROUTE_TEMPLATE_MANAGER = /*@__PURE__*/ new RouteTemplateManager();

/**
 * This "upgrades" a route template into a invokable component. Conceptually
 * it can be 1:1 for each unique `Template`, but it's also cheap to construct,
 * so unless the stability is desirable for other reasons, it's probably not
 * worth caching this.
 */
export class RouteTemplate implements ComponentDefinition<
  RouteTemplateDefinitionState,
  RouteTemplateInstanceState,
  RouteTemplateManager
> {
  // handle is not used by this custom definition
  public handle = -1;
  public resolvedName: string;
  public state: RouteTemplateDefinitionState;
  public manager = ROUTE_TEMPLATE_MANAGER;
  public capabilities = CAPABILITIES_MASK;
  public compilable: CompilableProgram;

  constructor(name: string, template: Template, self: Reference) {
    let unwrapped = unwrapTemplate(template);
    // TODO This actually seems inaccurate – it ultimately came from the
    // outlet's name. Also, setting this overrides `getDebugName()` in that
    // message. Is that desirable?
    this.resolvedName = name;
    this.state = { name, self };
    this.compilable = unwrapped.asLayout();
  }
}

// TODO a lot these fields are copied from the adjacent existing components
// implementation, haven't looked into who cares about `ComponentDefinition`
// and if it is appropriate here. It seems like this version is intended to
// be used with `curry` which probably isn't necessary here. It could be the
// case that we just want to do something more similar to `InternalComponent`
// (the one we used to implement `Input` and `LinkTo`). For now it follows
// the same pattern to get things going.
export function makeRouteTemplate(
  owner: InternalOwner,
  name: string,
  template: Template,
  self: Reference = UNDEFINED_REFERENCE
): CurriedValue {
  let routeTemplate = new RouteTemplate(name, template, self);
  return curry(0 as CurriedComponent, routeTemplate, owner, null, true);
}
