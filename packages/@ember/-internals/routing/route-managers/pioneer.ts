import type Owner from '../../owner';
import type { RouteStateBucket } from './utils';
import type PioneerRoute from '@ember/routing/pioneer-route';
import { once } from '@ember/runloop';
import type { TemplateFactory } from '@glimmer/interfaces';
import { hasInternalComponentManager } from '@glimmer/manager';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import { getOwner } from '../../owner';
import type { RenderState } from '../../glimmer';

const RENDER_STATE = Symbol('render-state');

interface PioneerRouteStateBucket extends RouteStateBucket {
  instance: PioneerRoute;
  args: object;
}

export class PioneerRouteManager {
  private owner: unknown;
  private router: unknown;
  activate;

  constructor(owner: Owner) {
    this.owner = owner;
  }

  createRoute(definition: unknown, args: any): PioneerRouteStateBucket {
    let instance = new definition.class(this.owner);
    let bucket = { instance, args };
    instance.model = () => this.enter(bucket);
    return bucket;
  }

  // Just an experiment, by no means final or even WIP
  async enter(bucket: PioneerRouteStateBucket) {
    const { instance } = bucket;

    // we need to wait a tick here to make ViewTransitions work
    //await new Promise((resolve) => setTimeout(resolve, 0));
    //await Promise.resolve();
    let loadPromise = await instance.load();
    //await new Promise((resolve) => requestAnimationFrame(resolve));

    instance.currentModel = loadPromise;
    bucket[RENDER_STATE] = buildRenderState(instance);
    console.log('scheduling render');
    once(getOwner(instance).lookup('router:main'), '_setOutlets');
  }

  // activate() {
  //   console.log('activate called');
  //   return this.enter();
  // }

  getRenderState({ [RENDER_STATE]: renderState }: PioneerRouteStateBucket): RenderState | undefined {
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
