import type { InternalOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import type {
  CapturedArguments,
  CurriedComponent,
  DynamicScope,
  Template,
} from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference';
import {
  childRefFromParts,
  createComputeRef,
  createConstRef,
  valueForRef,
} from '@glimmer/reference';
import type { CurriedValue } from '@glimmer/runtime';
import { createCapturedArgs, curry, EMPTY_POSITIONAL } from '@glimmer/runtime';
import { dict } from '@glimmer/util';
import { hasInternalComponentManager } from '@glimmer/manager';
import { OutletComponent, type OutletDefinitionState } from '../component-managers/outlet';
import { makeRouteTemplate } from '../component-managers/route-template';
import { internalHelper } from '../helpers/internal-helper';
import type { OutletState } from '../utils/outlet';

/**
  The `{{outlet}}` helper lets you specify where a child route will render in
  your template. An important use of the `{{outlet}}` helper is in your
  application's `application.hbs` file:

  ```app/templates/application.hbs
  <MyHeader />

  <div class="my-dynamic-content">
    <!-- this content will change based on the current route, which depends on the current URL -->
    {{outlet}}
  </div>

  <MyFooter />
  ```

  See the [routing guide](https://guides.emberjs.com/release/routing/rendering-a-template/) for more
  information on how your `route` interacts with the `{{outlet}}` helper.
  Note: Your content __will not render__ if there isn't an `{{outlet}}` for it.

  @method outlet
  @for Ember.Templates.helpers
  @public
*/
export const outletHelper = internalHelper(
  (_args: CapturedArguments, owner?: InternalOwner, scope?: DynamicScope) => {
    assert('Expected owner to be present, {{outlet}} requires an owner', owner);
    assert(
      'Expected dynamic scope to be present. You may have attempted to use the {{outlet}} keyword dynamically. This keyword cannot be used dynamically.',
      scope
    );

    let outletRef = createComputeRef(() => {
      let state = valueForRef(scope.get('outletState') as Reference<OutletState | undefined>);
      return state?.outlets?.main;
    });

    let lastState: OutletDefinitionState | null = null;
    let outlet: CurriedValue | null = null;

    return createComputeRef(() => {
      let outletState = valueForRef(outletRef);
      let state = stateFor(outletRef, outletState);

      // This code is deliberately using the behavior in glimmer-vm where in
      // <@Component />, the component is considered stabled via `===`, and
      // will continue to re-render in-place as long as the `===` holds, but
      // when it changes to a different object, it teardown the old component
      // (running destructors, etc), and render the component in its place (or
      // nothing if the new value is nullish. Here we are carefully exploiting
      // that fact, and returns the same stable object so long as it is the
      // same route, but return a different one when the route changes. On the
      // other hand, changing the model only intentionally do not teardown the
      // component and instead re-render in-place.
      if (!isStable(state, lastState)) {
        lastState = state;

        if (state !== null) {
          // If we are crossing an engine mount point, this is how the owner
          // gets switched.
          let outletOwner = outletState?.render?.owner ?? owner;

          let named = dict<Reference>();

          let component: object;

          // Wrapper-driven path: manager-provided wrapper + uncurried invokable.
          // Curry the wrapper with @Component (the user's invokable), @routeInfo,
          // @model, and @controller. The wrapper template uses these to render
          // the route.
          if (state.wrapper !== undefined && state.invokable !== undefined) {
            let wrapperArgs = dict<Reference>();
            wrapperArgs['Component'] = createConstRef(state.invokable, '@Component');

            // @controller must be a const ref because RouteTemplateManager
            // uses it as the route template's `self`, which is then passed
            // as `caller` to inner internal components (LinkTo, Input, etc.)
            // and those assert isConstRef(caller). Resolve the controller
            // eagerly here from the route on the routeInfo. The route has an
            // idempotent _initController that creates or returns the cached
            // controller instance.
            if (state.bucket?.controller !== undefined) {
              wrapperArgs['controller'] = createConstRef(state.bucket.controller, '@controller');
            }

            // @model is a compute ref over outletRef.render.context.
            // The path-based ref consumes outletStateTag; when setOutletState
            // dirties the tag (each transition / model update), the ref
            // invalidates and re-reads the new context.
            let modelRef = childRefFromParts(outletRef, ['render', 'context']);
            let model = valueForRef(modelRef);
            let frozenState = state;
            wrapperArgs['model'] = createComputeRef(() => {
              if (lastState === frozenState) {
                model = valueForRef(modelRef);
              }
              return model;
            });

            // isResolved=false because the wrapper is a "definition state" that
            // the VM must resolve to a ComponentDefinition via its registered
            // setComponentTemplate / setInternalComponentManager metadata.
            component = curry(
              0 as CurriedComponent,
              state.wrapper,
              outletOwner,
              createCapturedArgs(wrapperArgs, EMPTY_POSITIONAL),
              false
            );
          } else {
            // Legacy path: raw template or already-resolved component (e.g.
            // from test helpers calling setOutletState directly).
            let template = state.template;

            if (hasInternalComponentManager(template)) {
              component = template;
            } else {
              if (DEBUG) {
                let isTemplate = (template: unknown): template is Template => {
                  if (template === null || typeof template !== 'object') {
                    return false;
                  } else {
                    let t = template as Partial<Template>;
                    return t.result === 'ok' || t.result === 'error';
                  }
                };

                if (!isTemplate(template)) {
                  let label: string;

                  try {
                    label = `\`${String(template)}\``;
                  } catch {
                    label = 'an unknown object';
                  }

                  assert(
                    `Failed to render the \`${state.name}\` route: expected ` +
                      `a component or Template object, but got ${label}.`
                  );
                }
              }

              component = makeRouteTemplate(outletOwner, state.name, template as Template);
            }
          }

          named['Component'] = createConstRef(component, '@Component');

          let args = createCapturedArgs(named, EMPTY_POSITIONAL);

          // Package up everything
          outlet = curry(
            0 as CurriedComponent,
            new OutletComponent(owner, state),
            outletOwner,
            args,
            true
          );
        } else {
          outlet = null;
        }
      }

      return outlet;
    });
  }
);

function stateFor(
  ref: Reference<OutletState | undefined>,
  outlet: OutletState | undefined
): OutletDefinitionState | null {
  if (outlet === undefined) return null;
  let render = outlet.render;
  if (render === undefined) return null;

  // Wrapper-driven path: prefer wrapper + invokable + routeInfo when present.
  if (render.wrapper !== undefined && render.invokable !== undefined) {
    return {
      ref,
      name: render.name,
      template: render.invokable,
      invokable: render.invokable,
      wrapper: render.wrapper,
      bucket: render.bucket,
    };
  }

  // Legacy path: raw template, e.g. from setOutletState in tests.
  let template = render.template;
  // The type doesn't actually allow for `null`, but if we make it past this
  // point it is really important that we have _something_ to render. We could
  // assert, but that is probably overly strict for very little to gain.
  if (template === undefined || template === null) return null;

  return {
    ref,
    name: render.name,
    template,
  };
}

function isStable(
  state: OutletDefinitionState | null,
  lastState: OutletDefinitionState | null
): boolean {
  if (state === null || lastState === null) {
    return false;
  }
  // Stability hinges on the wrapper identity when wrapper-driven (same
  // wrapper → outlet stays mounted, wrapper internally re-renders), or on
  // the template identity for the legacy path.
  if (state.wrapper !== undefined || lastState.wrapper !== undefined) {
    return state.wrapper === lastState.wrapper;
  }
  return state.template === lastState.template;
}
