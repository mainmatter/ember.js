
import { CustomRenderNode, InternalComponentCapabilities, Reference } from '@glimmer/interfaces';
import {
  setInternalComponentManager
} from '@glimmer/manager';
import { NULL_REFERENCE } from '@glimmer/reference';

/**
 * Component manager for the classic wrapper. Functionally identical to glimmer's
 * `TemplateOnlyComponentManager` except that `getDebugCustomRenderTree` returns
 * an empty array, so the wrapper does not appear as its own node in the render
 * tree. This keeps the render-tree shape (and the assertion-error output that
 * cites it) the same as before the wrapper layer was introduced: the existing
 * tests assert `{{outlet}} for X -> X (route template)` directly with no
 * intermediate node.
 */
class ClassicRouteWrapperManager
{
  getCapabilities(): InternalComponentCapabilities {
    return {
      dynamicLayout: false,
      dynamicTag: false,
      prepareArgs: false,
      createArgs: false,
      attributeHook: false,
      elementHook: false,
      createCaller: false,
      dynamicScope: false,
      updateHook: false,
      createInstance: false,
      wrapped: false,
      willDestroy: false,
      hasSubOwner: false,
    };
  }

  getDebugName(): string {
    return '';
  }

  getDebugCustomRenderTree(): CustomRenderNode[] {
    return [];
  }

  getSelf(): Reference {
    return NULL_REFERENCE;
  }

  getDestroyable(): null {
    return null;
  }
}

const CLASSIC_WRAPPER_MANAGER = new ClassicRouteWrapperManager();
export class ClassicRouteWrapper {
  <template>
    <@Component @model={{@model}} @controller={{@controller}} />
  </template>
}

setInternalComponentManager(() => new ClassicRouteWrapperManager(), ClassicRouteWrapper);
