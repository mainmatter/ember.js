// We use the `InternalOwner` notion here because we actually need all of its
// API for using with renderers (normally, it will be `EngineInstance`).
// We use `getOwner` from our internal home for it rather than the narrower
// public API for the same reason.
import { type InternalOwner, getOwner } from '@ember/-internals/owner';
import type { BootOptions } from '@ember/engine/instance';
import { assert } from '@ember/debug';
import { schedule } from '@ember/runloop';
import type { Template, TemplateFactory } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference/lib/reference';
import { createComputeRef, updateRef } from '@glimmer/reference/lib/reference';
import { consumeTag } from '@glimmer/validator/lib/tracking';
import { createTag, DIRTY_TAG as dirtyTag } from '@glimmer/validator/lib/validators';
import type { SimpleElement } from '@simple-dom/interface';
import type { OutletDefinitionState } from '../utils/outlet';
import type { Renderer } from '../renderer';
import type { OutletState } from '../utils/outlet';
import { makeRouteTemplate } from '../component-managers/route-template';
import { upgradeLegacyOutletState } from './legacy-outlet-state';

export interface BootEnvironment {
  hasDOM: boolean;
  isInteractive: boolean;
  _renderMode?: string;
  options: BootOptions;
}

const TOP_LEVEL_NAME = '-top-level';

/**
  The compat facade over the root outlet. It owns two things:

  1. The root outlet-state cell: `state.ref` is the head of the outlet-state
     ref chain, and `setOutletState` writes the next state into it (after
     normalizing raw legacy renders through the `legacy-outlet-state`
     pseudo-manager).
  2. The intimate API surface older addons and the test-helpers depend on:
     `create`/`appendTo`/`setOutletState`/`extend`/`reopenClass`, the
     `view:-outlet` registration, and the `didCreateRootView` flow.
 */
export default class OutletView {
  static extend(injections: any): typeof OutletView {
    return class extends OutletView {
      static create(options: any) {
        if (options) {
          return super.create(Object.assign({}, injections, options));
        } else {
          return super.create(injections);
        }
      }
    };
  }

  static reopenClass(injections: any): void {
    Object.assign(this, injections);
  }

  static create(options: {
    environment: BootEnvironment;
    application: InternalOwner;
    template: TemplateFactory;
  }): OutletView {
    let { environment: _environment, application: namespace, template: templateFactory } = options;
    let owner = getOwner(options);
    assert('OutletView is unexpectedly missing an owner', owner);
    let template = templateFactory(owner);
    return new OutletView(_environment, owner, template, namespace);
  }

  private ref: Reference;
  public state: OutletDefinitionState;

  constructor(
    private _environment: BootEnvironment,
    public owner: InternalOwner,
    public template: Template,
    public namespace: any
  ) {
    let outletStateTag = createTag();
    let outletState: OutletState = {
      outlets: { main: undefined },
      render: {
        owner: owner,
        name: TOP_LEVEL_NAME,
        controller: undefined,
        wrapper: undefined,
        invokable: undefined,
      },
    };

    let ref = (this.ref = createComputeRef(
      () => {
        consumeTag(outletStateTag);
        return outletState;
      },
      (state: OutletState) => {
        dirtyTag(outletStateTag);
        outletState.outlets['main'] = state;
      }
    ));

    this.state = {
      ref,
      name: TOP_LEVEL_NAME,
      // The root template renders with no `self`. The template is only
      // absent when unit tests construct a bare OutletView — those never
      // render, so the missing invokable is caught by `appendOutletView`'s
      // assertion if one ever tries.
      invokable:
        template !== undefined ? makeRouteTemplate(owner, TOP_LEVEL_NAME, template) : undefined,
    };
  }

  appendTo(selector: string | SimpleElement): void {
    let target;

    if (this._environment.hasDOM) {
      target = typeof selector === 'string' ? document.querySelector(selector) : selector;
    } else {
      target = selector;
    }

    let renderer = this.owner.lookup('renderer:-dom') as Renderer;

    // SAFETY: It's not clear that this cast is safe.
    // The types for appendOutletView may be incorrect or this is a potential bug.
    schedule('render', renderer, 'appendOutletView', this, target as SimpleElement);
  }

  rerender(): void {
    /**/
  }

  setOutletState(state: OutletState): void {
    // Normalize raw legacy renders (`template`/`controller` with no
    // `invokable`) into manager-shaped renders before they hit the outlet
    // core; see `legacy-outlet-state`.
    upgradeLegacyOutletState(this.owner, state);
    updateRef(this.ref, state);
  }

  destroy(): void {
    /**/
  }
}
