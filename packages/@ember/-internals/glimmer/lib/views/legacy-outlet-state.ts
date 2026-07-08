/**
  The legacy `setOutletState` pseudo-manager.

  Legacy callers (the rendering test-helpers, liquid-fire-style addons) hand
  `OutletView.setOutletState` raw render states shaped `{ name, template,
  controller }`. The outlet core, however, has exactly one code path: every
  render must be manager-shaped — `{ wrapper?, invokable, context? }` — so a
  boundary can be built from it. This module plays the role a `RouteManager`
  plays for router-driven renders: it normalizes raw legacy states into that
  shape.

  Concretely, each legacy render is upgraded in place to `{ wrapper:
  undefined, invokable, context: undefined }`:

  - `invokable` is the raw `template` upgraded into a `RouteTemplate` whose
    `self` is the legacy `controller` (so `{{this.foo}}` keeps reading the
    controller), or the value itself when the caller passed a pre-built
    component definition (an intimate API older addons rely on).
  - No `wrapper` is needed: nested legacy `{{outlet}}`s resolve through the
    dynamic-scope entry the `RouteTemplateManager` writes for every route
    template it renders — legacy invokables are always `RouteTemplate`s, so
    keyword resolution is covered without an extra component layer.
  - No `context`: legacy templates read state off their controller `self`,
    never off `@context`.

  The upgrade skips renders that already carry an `invokable` (router-driven
  states, or a legacy render object being set again), which keeps invokable
  identity stable across repeated `setOutletState` calls with the same render
  objects — that identity is what the outlet boundary keys teardown on.
 */

import type { InternalOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import type { Template } from '@glimmer/interfaces';
import { hasInternalComponentManager } from '@glimmer/manager/lib/internal/api';
import { createConstRef } from '@glimmer/reference/lib/reference';
import { makeRouteTemplate } from '../component-managers/route-template';
import type { OutletState } from '../utils/outlet';

function isTemplate(value: unknown): value is Template {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  let template = value as Partial<Template>;
  return template.result === 'ok' || template.result === 'error';
}

/**
  Walks the outlet chain and upgrades every raw legacy render (a `template`
  with no `invokable`) into a manager-shaped render, mutating in place.
 */
export function upgradeLegacyOutletState(owner: InternalOwner, state: OutletState): void {
  let current: OutletState | undefined = state;

  while (current !== undefined) {
    let render = current.render;

    if (render !== undefined && render.invokable === undefined && render.template) {
      render.invokable = invokableForTemplate(
        owner,
        render.name,
        render.template,
        render.controller
      );
    }

    current = current.outlets.main;
  }
}

// Turn a legacy raw `template` into something the outlet can render. A
// caller may also hand us a pre-built component definition instead of a
// template (an intimate API older addons may rely on), in which case we
// use it directly rather than trying to wrap it.
function invokableForTemplate(
  owner: InternalOwner,
  name: string,
  template: object,
  controller: unknown
): object {
  if (hasInternalComponentManager(template)) {
    return template;
  }

  if (DEBUG && !isTemplate(template)) {
    let label: string;
    try {
      label = `\`${String(template)}\``;
    } catch {
      label = 'an unknown object';
    }

    assert(
      `Failed to render the \`${name}\` route: expected a component or Template object, but got ${label}.`
    );
  }

  // The route template renders with the controller as its `self` (`this`).
  // This path is for legacy `setOutletState` callers that provide a raw
  // `template`. We know they use controllers, so we can safely reach for the
  // controller here.
  let self = createConstRef(controller, 'this');
  return makeRouteTemplate(owner, name, template as Template, self);
}
