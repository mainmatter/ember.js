import type Owner from '../../owner';
import { getOwner, setOwner } from '../../owner';
import type { RouteStateBucket } from './utils';
import type PioneerRoute from '@ember/routing/pioneer-route';
import { once } from '@ember/runloop';
import type { TemplateFactory } from '@glimmer/interfaces';
import { hasInternalComponentManager } from '@glimmer/manager';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import type { RenderState } from '../../glimmer';
import { destroy } from '@glimmer/destroyable';
import EngineInstance from '@ember/engine/instance';

const RENDER_STATE = Symbol('render-state');

interface ClassicRouteInstance {
  _setRouteName: (name: string) => void;
}

interface PioneerRouteStateBucket extends RouteStateBucket {
  definition: typeof PioneerRoute;
  instance: ClassicRouteInstance;
  routeInstance?: PioneerRoute;
  args: object;

  routeName: string;
  _setRouteName: (name: string) => void;
}


export class PioneerRouteManager {
  private owner: unknown;
  private router: unknown;
  activate;

  #routes = new WeakMap<unknown, PioneerRoute>();

  constructor(owner: Owner) {
    this.owner = owner;
  }

  // This would not create an instance for our new fancy route, just the state bucket with the
  // data/references needed for the other methods to work.
  createRoute(definition: unknown, args: any): PioneerRouteStateBucket {
    console.log('creating pioneer route');
    let bucket: PioneerRouteStateBucket;

    if (this.#routes.has(definition)) {
      bucket = this.#routes.get(definition);
      bucket.args = args;
    } else {
      let classicRouteInstance = {
        definition,
        routeName: '',
        fullRouteName: '',
        _setRouteName(name) {
          this.routeName = name;
          let owner = getOwner(this);
          assert('Expected route to have EngineInstance as owner', owner instanceof EngineInstance);
          //this.fullRouteName = getEngineRouteName(owner, name);
        },
        _router: this.owner.lookup('router:main'),
        _stashNames() {},
      };
      setOwner(classicRouteInstance, this.owner);
      bucket = { definition, args, instance: classicRouteInstance }; // TDOO: hacky way for now to make these old functions available where the current router expects it
      this.#routes.set(definition, bucket);
    }

    let instance = this.#routes.get(definition);
    // Hacky solution to make this work
    bucket.instance.model = (...args) => this.enter(bucket, args);
    return bucket;
  }

  willEnter(bucket: PioneerRouteStateBucket) {
    const { definition, args } = bucket;
    bucket.routeInstance = new definition.class(this.owner, args);

    myRoute.beforeModel({ cancel: this.router.cancel});
  }

  // Just an experiment, by no means final or even WIP
  // This should create an instance.
  // eslint-disable-next-line disable-features/disable-async-await
  async enter(bucket: PioneerRouteStateBucket, [_params, transition]) {
    console.log('entering pioneer route', _params, transition);
    const { definition, args } = bucket;
    bucket.routeInstance = new definition.class(this.owner, args);
    bucket.routeInstance.routeName = bucket.instance.routeName;
    let instance = bucket.routeInstance;

    // we need to wait a tick here to make ViewTransitions work
    //await new Promise((resolve) => setTimeout(resolve, 0));
    //await Promise.resolve();
    // TODO: pass params
    let {queryParams, ...params} = _params;
    let loadPromise = await instance.load(params);
    //await new Promise((resolve) => requestAnimationFrame(resolve));

    instance.currentModel = loadPromise;
    bucket[RENDER_STATE] = buildRenderState(instance);
    console.log('scheduling render');
    once(getOwner(instance).lookup('router:main'), '_setOutlets');
  }

  exit(bucket) {
    console.log('destroying pioneer route');
    let instance = this.getDestroyable(bucket);
    //instance?.willDestroy()
    //this.#routes.delete(bucket.definition);
    destroy(instance);
    bucket.routeInstance = undefined;
    // TODO: when do we delete the reference kept in #routes?
  }

  // activate() {
  //   console.log('activate called');
  //   return this.enter();
  // }

  getRenderState({
    [RENDER_STATE]: renderState,
  }: PioneerRouteStateBucket): RenderState | undefined {
    return renderState;
  }

  getDestroyable({ instance }: PioneerRouteStateBucket) {
    return instance;
  }
}

function buildRenderState(route: PioneerRoute): RenderState {
  let owner = getOwner(route);
  assert('Route is unexpectedly missing an owner', owner);

  let name = route.routeName;

  let model = route.currentModel;

  let templateFactoryOrComponent = owner.lookup(`template:${route.templateName || name}`) as
    | TemplateFactory
    | object // This is meant to be a component
    | undefined;

  // Now we support either a component or a template to be returned by this
  // resolver call, but if it's a `TemplateFactory`, we need to instantiate
  // it into a `Template`, since that's what `RenderState` wants. We can't
  // easily change it, it's intimate API used by @ember/test-helpers and the
  // like. We could compatibly allow `Template` | `TemplateFactory`, and that's
  // what it used to do but we _just_ went through deprecations to get that
  // removed. It's also not ideal since once you mix the two types, they are
  // not exactly easy to tell apart.
  //
  // It may also be tempting to just normalize `Template` into `RouteTemplate`
  // here, and we could. However, this is not the only entrypoint where this
  // `RenderState` is made – @ember/test-helpers punches through an impressive
  // amount of private API to set it directly, and this feature would also be
  // useful for them. So, even if we had normalized here, we'd still have to
  // check and do that again during render anyway.
  let template: object;

  if (templateFactoryOrComponent) {
    if (hasInternalComponentManager(templateFactoryOrComponent)) {
      template = templateFactoryOrComponent;
    } else {
      if (DEBUG && typeof templateFactoryOrComponent !== 'function') {
        let label: string;

        try {
          label = `\`${String(templateFactoryOrComponent)}\``;
        } catch {
          label = 'an unknown object';
        }

        assert(
          `Failed to render the ${name} route, expected ` +
            `\`template:${route.templateName || name}\` to resolve into ` +
            `a component or a \`TemplateFactory\`, got: ${label}. ` +
            `Most likely an improperly defined class or an invalid module export.`
        );
      }

      template = (templateFactoryOrComponent as TemplateFactory)(owner);
    }
  } else {
    // default `{{outlet}}`
    template = owner.lookup('template:-outlet'); //route._topLevelViewTemplate(owner);
  }

  let render: RenderState = {
    owner,
    name,
    controller: undefined,
    model,
    template,
  };

  // if (DEBUG) {
  //   let LOG_VIEW_LOOKUPS = get(route._router, 'namespace.LOG_VIEW_LOOKUPS');
  //   // This is covered by tests and the existing code was deliberately
  //   // targeting the value prior to normalization, but is this message actually
  //   // accurate? It seems like we will always default the `{{outlet}}` template
  //   // so I'm not sure about "Nothing will be rendered?" (who consumes these
  //   // logs anyway? as lookups happen more infrequently now I doubt this is all
  //   // that useful)
  //   if (LOG_VIEW_LOOKUPS && !templateFactoryOrComponent) {
  //     info(`Could not find "${name}" template. Nothing will be rendered`, {
  //       fullName: `template:${name}`,
  //     });
  //   }
  // }

  return render;
}
