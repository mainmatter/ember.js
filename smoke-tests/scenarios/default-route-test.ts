/**
  `route:basic` is the class the router subclasses whenever a route has no
  definition of its own — every implicit `index`, every route named in
  `Router.map` but never written. Whatever route manager that class carries is
  therefore the manager for every route the app *didn't* write, which makes
  `route:basic` the seam an app uses to say "even those are mine".

  Ember registers classic `Route` there by default. An app overrides it the
  ordinary way: a `routes/basic` module, which every resolver already maps to
  `route:basic`.

  The interesting constraint is that an auto-generated route has no module
  behind it. There is no `routes/generated.gjs` to render, so the manager for
  such a route must be able to render nothing of its own and still hand the
  level below through to the DOM. This scenario builds exactly that: a classic
  `application` above, an app-managed auto-generated route in the middle with
  nothing to render, and a classic route below it that must still appear.
 */

import { v1AppScenarios, v2AppScenarios } from './scenarios';
import type { PreparedApp, Scenarios } from 'scenario-tester';
import * as QUnit from 'qunit';

const { module: Qmodule, test } = QUnit;

function defaultRouteTests(scenarios: Scenarios, appName: string) {
  scenarios
    .map('default-route', (project) => {
      project.mergeFiles({
        app: {
          'router.js': `
            import EmberRouter from '@ember/routing/router';
            import config from '${appName}/config/environment';

            export default class Router extends EmberRouter {
              location = config.locationType;
              rootURL = config.rootURL;
            }

            // \`generated\` is deliberately never written as a module, and
            // neither is its implicit \`generated.index\`. Both are what the
            // router auto-generates from \`route:basic\`.
            Router.map(function () {
              this.route('generated', function () {
                this.route('child');
              });
            });
          `,
          components: {
            'base-outlet.gjs': `
              import {
                getComponentTemplate,
                setComponentTemplate,
                setInternalComponentManager,
              } from '@glimmer/manager';
              import { createComputeRef, createConstRef, NULL_REFERENCE } from '@glimmer/reference';

              // No invokable of its own — an auto-generated route has no module
              // to render. The level still has to exist so the chain below it
              // reaches the DOM, and the marker element is the proof that it
              // did: a manager that returned \`null\` instead would end the
              // chain and nothing below would render at all.
              const LAYOUT = <template>
                <div data-test-generated-route={{@name}}><@outlet /></div>
              </template>;

              /** What \`getRouteWrapper\` returns. */
              export class BaseOutlet {
                constructor(bucket, childOutlet) {
                  this.bucket = bucket;
                  // Managers are handed a callback; \`prepareArgs\` passes
                  // \`@outlet\` to the template as an argument, which wants a
                  // reference.
                  this.childOutlet = createComputeRef(childOutlet);
                }
              }

              setInternalComponentManager(
                {
                  getCapabilities() {
                    return {
                      dynamicLayout: false,
                      dynamicTag: false,
                      prepareArgs: true,
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
                  },

                  prepareArgs(definition) {
                    return {
                      positional: [],
                      named: {
                        name: createConstRef(definition.bucket.name, '@name'),
                        outlet: definition.childOutlet,
                      },
                    };
                  },

                  getDebugName(definition) {
                    return \`base outlet for \${definition.bucket.name}\`;
                  },

                  getSelf() {
                    return NULL_REFERENCE;
                  },

                  getDestroyable() {
                    return null;
                  },
                },
                BaseOutlet.prototype
              );

              setComponentTemplate(getComponentTemplate(LAYOUT), BaseOutlet.prototype);
            `,
          },
          routes: {
            // Every resolver maps \`route:basic\` to this module, so writing it
            // is all it takes to own auto-generation.
            'basic.js': `
              import { setOwner } from '@ember/owner';
              import { routeCapabilities, setRouteManager } from '@ember/routing';
              import { BaseOutlet } from '${appName}/components/base-outlet';

              const created = [];

              /** Route names this manager has built a bucket for. */
              export function createdRouteNames() {
                return created.slice();
              }

              export function resetCreatedRouteNames() {
                created.length = 0;
              }

              class BaseBucket {
                constructor(name, route) {
                  this.name = name;
                  this.route = route;
                }
              }

              class BaseRouteManager {
                capabilities = routeCapabilities('1.0');

                constructor(owner) {
                  this.owner = owner;
                }

                createRoute(RouteClass, { name }) {
                  created.push(name);
                  return new BaseBucket(name, new RouteClass(this.owner));
                }

                getRoute(bucket) {
                  return bucket.route;
                }

                getDestroyable(bucket) {
                  return bucket.route;
                }

                getRenderState(bucket) {
                  return {
                    owner: this.owner,
                    name: bucket.name,
                    invokable: undefined,
                    bucket,
                  };
                }

                // Nothing to render at this level, but the chain continues.
                getRouteWrapper(bucket, childOutlet) {
                  return new BaseOutlet(bucket, childOutlet);
                }

                async getInvokable() {
                  return undefined;
                }

                willEnter() {}
                async enter() {}
                didEnter() {}
                willExit() {}
                exit() {}
                didExit() {}
              }

              /** A plain class — no EmberObject, no classic Route. */
              export default class BaseRoute {
                constructor(owner) {
                  setOwner(this, owner);
                }
              }

              setRouteManager((owner) => new BaseRouteManager(owner), BaseRoute);
            `,
            // Defined, so the app boots through classic and the app template
            // renders; only the middle of the chain is auto-generated.
            'application.js': `
              import Route from '@ember/routing/route';

              export default class extends Route {}
            `,
            generated: {
              'child.js': `
                import Route from '@ember/routing/route';

                export default class extends Route {
                  model() {
                    return 'child-model';
                  }
                }
              `,
            },
          },
          templates: {
            generated: {
              'child.gjs': `
                <template>
                  <div data-test-classic-route="generated.child">{{@model}}</div>
                </template>
              `,
            },
          },
        },
        tests: {
          acceptance: {
            'default-route-test.js': `
              import { module, test } from 'qunit';
              import { visit } from '@ember/test-helpers';
              import Route from '@ember/routing/route';
              import { setupApplicationTest } from '${appName}/tests/helpers';
              import BaseRoute, {
                createdRouteNames,
                resetCreatedRouteNames,
              } from '${appName}/routes/basic';

              module('Acceptance | default route', function (hooks) {
                setupApplicationTest(hooks);

                hooks.beforeEach(function () {
                  resetCreatedRouteNames();
                });

                test('an auto-generated route is built from the app-registered route:basic', async function (assert) {
                  await visit('/generated/child');

                  assert.deepEqual(
                    createdRouteNames(),
                    ['generated'],
                    'the app manager created the route no module defines'
                  );

                  const Generated = this.owner.factoryFor('route:generated').class;
                  assert.ok(
                    Generated.prototype instanceof BaseRoute,
                    'the generated route extends the app base route'
                  );
                  assert.notOk(
                    Generated.prototype instanceof Route,
                    'the generated route is not a classic route'
                  );
                });

                test('a route with nothing to render passes the outlet through', async function (assert) {
                  await visit('/generated/child');

                  assert
                    .dom('[data-test-generated-route="generated"]')
                    .exists('the auto-generated level rendered through the app manager');
                  assert
                    .dom(
                      '[data-test-generated-route="generated"] [data-test-classic-route="generated.child"]'
                    )
                    .hasText('child-model', 'the classic route below it rendered inside its outlet');
                });

                test('the implicit index is auto-generated through the same manager', async function (assert) {
                  await visit('/generated');

                  assert.deepEqual(
                    createdRouteNames().sort(),
                    ['generated', 'generated.index'],
                    'both levels came from the app manager'
                  );
                  assert
                    .dom(
                      '[data-test-generated-route="generated"] [data-test-generated-route="generated.index"]'
                    )
                    .exists('two pass-through levels nested, with nothing below');
                  assert
                    .dom('[data-test-classic-route="generated.child"]')
                    .doesNotExist('the leaf is not active');
                });

                test('routes the app did write are untouched', async function (assert) {
                  await visit('/generated/child');

                  assert
                    .dom('#title')
                    .exists('the classic application template still rendered above the chain');
                  assert.notOk(
                    createdRouteNames().includes('application'),
                    'a route with a module of its own did not go through route:basic'
                  );
                });
              });
            `,
          },
        },
      });
    })
    .forEachScenario((scenario) => {
      Qmodule(scenario.name, function (hooks) {
        let app: PreparedApp;

        hooks.before(async () => {
          app = await scenario.prepare();
        });

        test('ember test', async function (assert) {
          let result = await app.execute('pnpm test');
          assert.equal(result.exitCode, 0, result.output);
        });
      });
    });
}

defaultRouteTests(v1AppScenarios, 'ember-test-app');
defaultRouteTests(v2AppScenarios, 'v2-app-template');
