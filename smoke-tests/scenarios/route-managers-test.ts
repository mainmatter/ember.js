import { v1AppScenarios, v2AppScenarios } from './scenarios';
import type { PreparedApp, Scenarios } from 'scenario-tester';
import * as QUnit from 'qunit';
import { appFiles } from './route-managers/app';

const { module: Qmodule, test } = QUnit;

function routeManagerTests(scenarios: Scenarios, appName: string) {
  scenarios
    .map('route-managers', (project) => {
      project.mergeFiles({
        app: appFiles(appName),
        tests: {
          acceptance: {
            'route-managers-test.js': `
              import { module, test } from 'qunit';
              import { click, currentURL, settled, visit, waitUntil } from '@ember/test-helpers';
              import { setupApplicationTest } from '${appName}/tests/helpers';
              import { modelStarts } from '${appName}/router';
              import { resolveModel as resolveParentModel } from '${appName}/routes/reactive-context';
              import { resolveModel as resolveChildModel } from '${appName}/routes/reactive-context/child';

              function routeSelector(name) {
                return '[data-test-route="' + name + '"]';
              }

              function scenarioLink(name) {
                return '[data-test-scenario-link="' + name + '"]';
              }

              function childLink(name) {
                return '[data-test-child-link="' + name + '"]';
              }

              function modelLink(model) {
                return '[data-test-model-link="' + model + '"]';
              }

              function funkyGate(name) {
                return 'button[data-test-render-route="' + name + '"]';
              }

              function assertLevel(assert, kind, name, context) {
                let selector = routeSelector(name);

                assert.dom(selector).hasAttribute('data-test-route-kind', kind);
                assert
                  .dom(selector + ' > [data-test-route-context]')
                  .hasText(context ?? 'model:' + name);
              }

              function assertChain(assert, levels) {
                let selector = levels
                  .map(([, name]) => routeSelector(name))
                  .join(' > [data-test-outlet-boundary] ');

                assert.dom(selector).exists();

                for (let [kind, name, context] of levels) {
                  assertLevel(assert, kind, name, context);
                }
              }

              module('Acceptance | route-managers', function (hooks) {
                setupApplicationTest(hooks);

                test('walks classic -> funky', async function (assert) {
                  let route = 'classic-to-funky';

                  await visit('/');
                  await click(scenarioLink(route));

                  assertLevel(assert, 'classic', route);
                  assert.dom('[data-test-route-kind="funky"]').doesNotExist();

                  await click(childLink(route + '.child'));
                  await click(funkyGate(route + '.child'));

                  assertChain(assert, [
                    ['classic', route],
                    ['funky', route + '.child'],
                  ]);
                });

                test('walks funky -> classic', async function (assert) {
                  let route = 'funky-to-classic';

                  await visit('/');
                  await click(scenarioLink(route));

                  assert.dom('[data-test-route]').doesNotExist();

                  await click(funkyGate(route));
                  assertLevel(assert, 'funky', route);

                  await click(childLink(route + '.child'));

                  assertChain(assert, [
                    ['funky', route],
                    ['classic', route + '.child'],
                  ]);
                });

                test('walks classic -> funky -> classic', async function (assert) {
                  let route = 'classic-to-funky-to-classic';

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(childLink(route + '.child'));
                  await click(funkyGate(route + '.child'));
                  await click(childLink(route + '.child.grandchild'));

                  assertChain(assert, [
                    ['classic', route],
                    ['funky', route + '.child'],
                    ['classic', route + '.child.grandchild'],
                  ]);
                });

                test('walks funky -> classic -> funky', async function (assert) {
                  let route = 'funky-to-classic-to-funky';

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(funkyGate(route));
                  await click(childLink(route + '.child'));

                  assert.dom('[data-test-route-kind="funky"]').exists({ count: 1 });

                  await click(childLink(route + '.child.grandchild'));
                  await click(funkyGate(route + '.child.grandchild'));

                  assertChain(assert, [
                    ['funky', route],
                    ['classic', route + '.child'],
                    ['funky', route + '.child.grandchild'],
                  ]);
                });

                test('walks funky -> funky -> funky -> classic', async function (assert) {
                  let route = 'funky-to-funky-to-funky-to-classic';

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(funkyGate(route));

                  await click(childLink(route + '.child'));
                  await click(funkyGate(route + '.child'));

                  await click(childLink(route + '.child.grandchild'));
                  await click(funkyGate(route + '.child.grandchild'));

                  await click(childLink(route + '.child.grandchild.great-grandchild'));

                  assertChain(assert, [
                    ['funky', route],
                    ['funky', route + '.child'],
                    ['funky', route + '.child.grandchild'],
                    ['classic', route + '.child.grandchild.great-grandchild'],
                  ]);
                });

                test('walks funky -> funky -> classic -> classic -> funky', async function (assert) {
                  let route = 'funky-to-funky-to-classic-to-classic-to-funky';
                  let grandchild = route + '.child.grandchild';
                  let greatGrandchild = grandchild + '.great-grandchild';
                  let leaf = greatGrandchild + '.great-great-grandchild';

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(funkyGate(route));

                  await click(childLink(route + '.child'));
                  await click(funkyGate(route + '.child'));

                  await click(childLink(grandchild));
                  await click(childLink(greatGrandchild));
                  await click(childLink(leaf));

                  assert.dom('[data-test-route-kind="funky"]').exists({ count: 2 });

                  await click(funkyGate(leaf));

                  assertChain(assert, [
                    ['funky', route],
                    ['funky', route + '.child'],
                    ['classic', grandchild],
                    ['classic', greatGrandchild],
                    ['funky', leaf],
                  ]);
                });

                test('retained funky parent switches between classic and funky siblings', async function (assert) {
                  let route = 'sibling-transitions';

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(funkyGate(route));

                  await click(childLink(route + '.classic-child'));

                  assertChain(assert, [
                    ['funky', route],
                    ['classic', route + '.classic-child'],
                  ]);

                  await click(childLink(route + '.funky-child'));

                  assert.dom(routeSelector(route + '.classic-child')).doesNotExist();

                  await click(funkyGate(route + '.funky-child'));

                  assertChain(assert, [
                    ['funky', route],
                    ['funky', route + '.funky-child'],
                  ]);

                  await click(childLink(route + '.classic-child'));
                  await click(childLink(route + '.funky-child'));

                  assert.dom(funkyGate(route + '.funky-child')).exists();
                });

                test('re-entering a route with a changed model updates @context', async function (assert) {
                  let route = 'funky-route-params';

                  await visit('/');
                  await click(scenarioLink(route));

                  assert.strictEqual(currentURL(), '/funky-route-params/roger%20roger');

                  await click(funkyGate(route));

                  assertLevel(assert, 'funky', route, 'roger roger');

                  await click(modelLink('May forth be with you'));

                  assert.strictEqual(
                    currentURL(),
                    '/funky-route-params/May%20forth%20be%20with%20you'
                  );
                  assert.dom('button[data-test-render-route]').doesNotExist();
                  assertLevel(assert, 'funky', route, 'May forth be with you');
                });

                test('a real Glimmer component class works as a wrapper', async function (assert) {
                  let route = 'glimmer-wrapper';
                  let log = this.owner.lookup('service:wrapper-log');

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(childLink(route + '.child'));

                  assertChain(assert, [
                    ['glimmer', route],
                    ['glimmer', route + '.child'],
                  ]);

                  for (let name of [route, route + '.child']) {
                    assert
                      .dom('[data-test-outlet-with-service="' + name + '"]')
                      .hasAttribute('data-test-wrapper-owner', 'present');
                  }

                  assert.deepEqual(
                    log.entries.filter((entry) => entry.startsWith('created:')),
                    ['created:' + route, 'created:' + route + '.child']
                  );
                });

                test('an exiting Glimmer wrapper still sees its own context while tearing down', async function (assert) {
                  let route = 'glimmer-wrapper';
                  let log = this.owner.lookup('service:wrapper-log');

                  await visit('/');
                  await click(scenarioLink(route));
                  await click(childLink(route + '.child'));

                  log.entries.length = 0;

                  await click(scenarioLink(route));

                  assert.deepEqual(log.entries, [
                    'destroyed:' + route + '.child=model:' + route + '.child',
                  ]);
                  assert
                    .dom('[data-test-outlet-with-service="' + route + '.child"]')
                    .doesNotExist();
                  assert.dom('[data-test-outlet-with-service="' + route + '"]').exists();
                });

                test('enters a deep URL directly', async function (assert) {
                  let route = 'classic-to-classic-to-funky-to-funky-to-classic';
                  let grandchild = route + '.child.grandchild';
                  let greatGrandchild = grandchild + '.great-grandchild';
                  let leaf = greatGrandchild + '.great-great-grandchild';

                  await visit(
                    '/classic-to-classic-to-funky-to-funky-to-classic/child/grandchild/great-grandchild/great-great-grandchild'
                  );

                  assertLevel(assert, 'classic', route);
                  assertLevel(assert, 'classic', route + '.child');
                  assert.dom('[data-test-route-kind="funky"]').doesNotExist();

                  await click(funkyGate(grandchild));
                  await click(funkyGate(greatGrandchild));

                  assertChain(assert, [
                    ['classic', route],
                    ['classic', route + '.child'],
                    ['funky', grandchild],
                    ['funky', greatGrandchild],
                    ['classic', leaf],
                  ]);
                });

                test('a non-classic manager loads ancestor and descendant models in parallel', async function (assert) {
                  modelStarts.length = 0;

                  visit('/reactive-context/child');

                  try {
                    await waitUntil(() => modelStarts.length === 2, { timeout: 2000 });
                  } catch {}

                  let startedWhilePending = modelStarts.slice();

                  resolveParentModel('PARENT-CTX');
                  resolveChildModel('CHILD-CTX');
                  await settled();

                  assert.deepEqual(startedWhilePending, [
                    'reactive-context',
                    'reactive-context.child',
                  ]);
                  assertChain(assert, [
                    ['reactive', 'reactive-context', 'PARENT-CTX'],
                    ['reactive', 'reactive-context.child', 'CHILD-CTX'],
                  ]);
                });

                test('a filled-in context survives a transition that keeps the route mounted', async function (assert) {
                  modelStarts.length = 0;

                  let visitPromise = visit('/reactive-context/child');

                  await waitUntil(() => modelStarts.length === 2, { timeout: 2000 });

                  resolveParentModel('PARENT-CTX');
                  resolveChildModel('CHILD-CTX');
                  await visitPromise;

                  assertLevel(assert, 'reactive', 'reactive-context', 'PARENT-CTX');

                  await visit('/reactive-context');

                  assertLevel(assert, 'reactive', 'reactive-context', 'PARENT-CTX');
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

routeManagerTests(v1AppScenarios, 'ember-test-app');
routeManagerTests(v2AppScenarios, 'v2-app-template');
