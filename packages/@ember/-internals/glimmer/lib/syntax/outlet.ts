import type { InternalOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import type { CapturedArguments, DynamicScope } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference/lib/reference';
import { currentOutletStateRef, outletFrameRef } from '../outlet';
import { internalHelper } from '../helpers/internal-helper';

/**
  The `{{outlet}}` helper lets you specify where a child route will render in
  your template. An important use of the `{{outlet}}` helper is in your
  application's `application.gjs` file:

  ```app/templates/application.gjs
  import MyHeader from '../components/my-header';
  import MyFooter from '../components/my-footer';

  <template>
    <MyHeader />

    <div class="my-dynamic-content">
      <!-- this content will change based on the current route, which depends on the current URL -->
      {{outlet}}
    </div>

    <MyFooter />
  </template>
  ```

  See the [routing guide](https://guides.emberjs.com/release/routing/rendering-a-template/) for more
  information on how your `route` interacts with the `{{outlet}}` helper.
  Note: Your content __will not render__ if there isn't an `{{outlet}}` for it.

  `outlet` is built-in and does not need to be imported.

  @method outlet
  @for Ember.Templates.helpers
  @public
*/
export const outletHelper = /*@__PURE__*/ internalHelper(
  (_args: CapturedArguments, _owner?: InternalOwner, scope?: DynamicScope) => {
    assert(
      'Expected dynamic scope to be present. You may have attempted to use the {{outlet}} keyword dynamically. This keyword cannot be used dynamically.',
      scope
    );

    // The keyword renders the route at the cursor's current level: it reads
    // the child OutletState from dynamic scope (a route frame advanced the
    // cursor there before rendering its body) and returns that level's frame —
    // the manager's outlet frame (`render.wrapper`) or, wrapper-less, the
    // invokable itself — or `null` when there is nothing to render. The value
    // is a component the VM invokes directly; the framework does not decide
    // how the route composes, that is the returned frame's job (the classic
    // manager's outlet frame lives in `route-managers/classic/wrapper.ts`).
    let ref = outletFrameRef(currentOutletStateRef(scope));

    if (DEBUG) {
      // Suppress this ref's debug label. Dynamic component resolution stamps
      // the resolving ref's label onto the component definition as its debug
      // name, which would put "(result of a `unknown` helper)" frames in
      // backtracking-rerender assertion messages. With no label, the frame's
      // own manager debug name (`{{outlet}} for <route>`) is used instead —
      // the frame the outlet has always shown.
      (ref as Reference).debugLabel = undefined;
    }

    return ref;
  }
);
