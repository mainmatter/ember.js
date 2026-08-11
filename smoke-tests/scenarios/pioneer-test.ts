/**
  A "full pioneer" app: every route in the app — including `application` and
  every implicit `index` — is backed by an app-defined route manager, and the
  app itself never mentions classic routing.

  Two things are under test:

  1. The app boots and navigates entirely through its own manager, and the
     router never falls back to auto-generating a route from `route:basic`
     (which would make that route classic).

  2. No classic route-manager module is *loaded*. Vite's dev server hands out
     one module per request, so the app's real module graph can be walked and
     filtered. This is the target the RFC-1169 work is aiming at, and it
     currently FAILS: `@ember/application` imports `Route` to register
     `route:basic`, and `@ember/routing/router` imports `defaultSerialize` /
     `getFullQueryParams` / `hasDefaultSerialize` from the same module.
     `@ember/routing/route` ends with a `setRouteManager(… ClassicRouteManager
     …)` side effect, so importing it at all drags the whole classic manager
     in. The failure message names the offending modules and their importers.
 */

import { v2AppScenarios } from './scenarios';
import type { PreparedApp } from 'scenario-tester';
import * as QUnit from 'qunit';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const { module: Qmodule, test } = QUnit;

/** Modules that only exist to serve classic routes. */
const CLASSIC_MODULE = /route-managers\/classic\/|@ember\/routing\/route\.js/;

// -- dev server ---------------------------------------------------------------

interface DevServer {
  origin: string;
  stop(): void;
}

/** Vite colorizes the port itself, so the banner has to be de-styled to be read. */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

async function startDevServer(app: PreparedApp): Promise<DevServer> {
  const child = spawn(join(app.dir, 'node_modules', '.bin', 'vite'), [], {
    cwd: app.dir,
    // The `development` export condition is what resolves ember-source to its
    // per-module `dist/dev` files rather than the pre-built `dist/prod` bundle.
    env: { ...process.env, NODE_ENV: 'development', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';

  const origin = await new Promise<string>((resolve, reject) => {
    // Every failure path has to take the server down with it, or a server that
    // never announced itself outlives the test run.
    const fail = (error: Error) => {
      child.kill('SIGTERM');
      reject(error);
    };

    const timer = setTimeout(
      () => fail(new Error(`vite did not become ready in time:\n${stripAnsi(output)}`)),
      180_000
    );

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // "  ➜  Local:   http://localhost:5173/"
      const match = /(http:\/\/localhost:\d+)\//.exec(stripAnsi(output));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Already dead; no kill needed.
      reject(new Error(`vite exited with ${code} before becoming ready:\n${stripAnsi(output)}`));
    });
  });

  return {
    origin,
    stop() {
      child.kill('SIGTERM');
    },
  };
}

// -- module graph -------------------------------------------------------------

/**
  Walks the dev server the way the browser does: fetch a module, read the
  imports out of what the server returned, fetch those. Vite rewrites every
  specifier it serves to a URL, so the transformed source names its own
  imports. Only static edges are followed — that is what the browser requests
  on load.
 */
async function crawlModuleGraph(origin: string) {
  const STATIC_IMPORT = /(?:from|^\s*import)\s*["']([^"']+)["']/gm;

  const modules = new Set<string>();
  const importedBy = new Map<string, Set<string>>();

  const isLocal = (specifier: string) =>
    specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../');

  async function get(url: URL): Promise<string | undefined> {
    // The first requests can race dependency optimization, which answers 504
    // until it settles.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return await response.text();
        }
        if (response.status !== 504) {
          return undefined;
        }
      } catch {
        // connection reset while the server restarts; retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return undefined;
  }

  async function crawl(url: URL, importer: string) {
    if (url.origin !== new URL(origin).origin) {
      return;
    }

    const id = url.pathname + url.search;

    let importers = importedBy.get(id);
    if (!importers) {
      importers = new Set();
      importedBy.set(id, importers);
    }
    importers.add(importer);

    if (modules.has(id)) {
      return;
    }
    modules.add(id);

    const body = await get(url);
    if (body === undefined) {
      return;
    }

    const next = new Set<string>();
    for (const match of body.matchAll(STATIC_IMPORT)) {
      if (isLocal(match[1]!)) {
        next.add(match[1]!);
      }
    }

    await Promise.all([...next].map((specifier) => crawl(new URL(specifier, url), id)));
  }

  const html = await (await fetch(origin)).text();
  const entries = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((match) => match[1]!);

  await Promise.all(entries.map((entry) => crawl(new URL(entry, origin), 'index.html')));

  return { modules: [...modules].sort(), importedBy };
}

function shortName(module: string): string {
  return module.replace(/^.*\/node_modules\/ember-source\//, 'ember-source/').replace(/\?.*$/, '');
}

function reportOffenders(offenders: string[], importedBy: Map<string, Set<string>>): string {
  const lines = [`${offenders.length} classic route-manager module(s) loaded:`];

  for (const offender of offenders) {
    lines.push(`  ${shortName(offender)}`);
    for (const importer of importedBy.get(offender) ?? []) {
      lines.push(`      imported by  ${shortName(importer)}`);
    }
  }

  return lines.join('\n');
}

// -- scenario -----------------------------------------------------------------

function pioneerTests(appName: string) {
  const BASE_ROUTE = `${appName}/route-managers/base-route`;

  /** `application`, `index`, `parent`, `parent.index`, `parent.child`. */
  function routeModule(name: string, body: string, model = `'${name}'`): string {
    return `
      import BaseRoute from '${BASE_ROUTE}';

      export const component = <template>
        <div data-test-pioneer-route="${name}">
          <span data-test-route-model>{{@context}}</span>
          ${body}
        </div>
      </template>;

      export default class extends BaseRoute {
        async model() {
          return ${model};
        }
      }
    `;
  }

  const OUTLET = `<div data-test-outlet-boundary>{{outlet}}</div>`;

  v2AppScenarios
    .map('pioneer', (project) => {
      // The classic `application` template would only ever be rendered by a
      // classic `application` route; this app has a pioneer one.
      const appFiles = project.files['app'] as Record<string, unknown> | undefined;
      if (appFiles) {
        delete appFiles['templates'];
      }

      project.mergeFiles({
        'vite.config.mjs': `
          import { defineConfig } from 'vite';
          import { extensions, classicEmberSupport, ember } from '@embroider/vite';
          import { babel } from '@rollup/plugin-babel';

          export default defineConfig({
            // Keeps ember-source out of the dep pre-bundler so the dev server
            // serves one framework module per request. Without this, everything
            // arrives inside opaque \`.vite/deps/chunk-*.js\` files and the module
            // graph cannot be filtered.
            optimizeDeps: {
              exclude: ['ember-source'],
            },
            plugins: [
              classicEmberSupport(),
              ember(),
              babel({
                babelHelpers: 'runtime',
                extensions,
              }),
            ],
          });
        `,
        app: {
          'router.js': `
            import EmberRouter from '@embroider/router';
            import config from '${appName}/config/environment';

            export default class Router extends EmberRouter {
              location = config.locationType;
              rootURL = config.rootURL;
            }

            // Every route here is backed by a file whose class extends
            // BaseRoute, i.e. driven by PioneerRouteManager. The implicit
            // \`index\` routes are declared as files too, so the router never
            // auto-generates one from \`route:basic\` — an auto-generated route
            // is a classic route.
            Router.map(function () {
              this.route('parent', function () {
                this.route('child');
              });
            });
          `,
          'route-managers': {
            'base-route.js': `
              import { setOwner } from '@ember/owner';
              import { setRouteManager } from '@ember/routing';
              import PioneerRouteManager from '${appName}/route-managers/pioneer';

              /** A plain class — no EmberObject, no classic Route. */
              export default class BaseRoute {
                constructor(owner) {
                  setOwner(this, owner);
                }

                async model() {
                  return undefined;
                }
              }

              setRouteManager((owner) => new PioneerRouteManager(owner), BaseRoute);
            `,
            'pioneer.js': `
              import { routeCapabilities } from '@ember/routing';
              import { tracked } from '@glimmer/tracking';
              import { PioneerOutlet } from '${appName}/components/pioneer-outlet';

              // One module per route, loaded when the route first renders.
              const ROUTE_MODULES = import.meta.glob('../routes/**/*.gjs');

              const created = [];

              /** Route names this manager has built a bucket for. */
              export function createdRouteNames() {
                return created.slice();
              }

              export function resetCreatedRouteNames() {
                created.length = 0;
              }

              class PioneerBucket {
                @tracked invokable = undefined;
                @tracked context = undefined;

                constructor(name, route) {
                  this.name = name;
                  this.route = route;
                }
              }

              export default class PioneerRouteManager {
                capabilities = routeCapabilities('1.0');

                constructor(owner) {
                  this.owner = owner;
                }

                createRoute(RouteClass, { name }) {
                  created.push(name);
                  return new PioneerBucket(name, new RouteClass(this.owner));
                }

                getRoute(bucket) {
                  return bucket.route;
                }

                getDestroyable(bucket) {
                  return bucket.route;
                }

                getRouteWrapper(bucket, childOutlet) {
                  return new PioneerOutlet(bucket, childOutlet);
                }

                getRenderState(bucket) {
                  return {
                    owner: this.owner,
                    name: bucket.name,
                    invokable: bucket.invokable,
                    bucket,
                  };
                }

                willEnter() {}

                async enter(bucket) {
                  bucket.context = await bucket.route.model();
                  return bucket.context;
                }

                didEnter() {}
                willExit() {}
                exit() {}
                didExit() {}

                async getInvokable(bucket) {
                  if (bucket.invokable !== undefined) {
                    return bucket.invokable;
                  }

                  const path = \`../routes/\${bucket.name.replace(/\\./g, '/')}.gjs\`;
                  const routeModule = await ROUTE_MODULES[path]();

                  bucket.invokable = routeModule.component;
                  return bucket.invokable;
                }
              }
            `,
          },
          components: {
            'pioneer-outlet.gjs': `
              import {
                getComponentTemplate,
                setComponentTemplate,
                setInternalComponentManager,
              } from '@glimmer/manager';
              import { createConstRef, NULL_REFERENCE } from '@glimmer/reference';

              // The bucket is tracked, so this reads what to render straight off it.
              const LAYOUT = <template>
                {{#if @bucket.invokable}}
                  <@bucket.invokable @context={{@bucket.context}} @outlet={{@outlet}} />
                {{/if}}
              </template>;

              /** What \`getRouteWrapper\` returns. */
              export class PioneerOutlet {
                constructor(bucket, childOutlet) {
                  this.bucket = bucket;
                  this.childOutlet = childOutlet;
                }
              }

              setInternalComponentManager(
                {
                  getCapabilities() {
                    return {
                      dynamicLayout: false,
                      dynamicTag: false,
                      // Supplies the layout's args, and discards anything a
                      // parent passed into \`<@outlet />\`.
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
                        bucket: createConstRef(definition.bucket, '@bucket'),
                        outlet: definition.childOutlet,
                      },
                    };
                  },

                  getDebugName(definition) {
                    return \`pioneer outlet for \${definition.bucket.name}\`;
                  },

                  getSelf() {
                    return NULL_REFERENCE;
                  },

                  getDestroyable() {
                    return null;
                  },
                },
                PioneerOutlet.prototype
              );

              setComponentTemplate(getComponentTemplate(LAYOUT), PioneerOutlet.prototype);
            `,
          },
          routes: {
            'application.gjs': routeModule('application', OUTLET),
            'index.gjs': routeModule('index', ''),
            'parent.gjs': routeModule('parent', OUTLET),
            parent: {
              'index.gjs': routeModule('parent.index', ''),
              'child.gjs': routeModule('parent.child', ''),
            },
          },
        },
        tests: {
          acceptance: {
            'pioneer-test.js': `
              import { module, test } from 'qunit';
              import { visit } from '@ember/test-helpers';
              import { setupApplicationTest } from '${appName}/tests/helpers';
              import {
                createdRouteNames,
                resetCreatedRouteNames,
              } from '${appName}/route-managers/pioneer';

              function assertPioneerRoute(assert, name) {
                assert
                  .dom(\`[data-test-pioneer-route="\${name}"]\`)
                  .exists(\`\${name} rendered through the pioneer manager\`);
              }

              module('Acceptance | pioneer', function (hooks) {
                setupApplicationTest(hooks);

                hooks.beforeEach(function () {
                  resetCreatedRouteNames();
                });

                test('the application route and its index are pioneer', async function (assert) {
                  await visit('/');

                  assertPioneerRoute(assert, 'application');
                  assertPioneerRoute(assert, 'index');
                  assert.deepEqual(createdRouteNames().sort(), ['application', 'index']);
                });

                test('a nested route and its implicit index are pioneer', async function (assert) {
                  await visit('/parent');

                  assertPioneerRoute(assert, 'application');
                  assertPioneerRoute(assert, 'parent');
                  assertPioneerRoute(assert, 'parent.index');
                  assert.deepEqual(createdRouteNames().sort(), [
                    'application',
                    'parent',
                    'parent.index',
                  ]);
                });

                test('a leaf route is pioneer', async function (assert) {
                  await visit('/parent/child');

                  assertPioneerRoute(assert, 'application');
                  assertPioneerRoute(assert, 'parent');
                  assertPioneerRoute(assert, 'parent.child');
                  assert.dom('[data-test-pioneer-route="parent.index"]').doesNotExist();
                  assert.deepEqual(createdRouteNames().sort(), [
                    'application',
                    'parent',
                    'parent.child',
                  ]);
                });

                test('the route context reaches the route component', async function (assert) {
                  await visit('/parent/child');

                  assert
                    .dom('[data-test-pioneer-route="parent.child"] [data-test-route-model]')
                    .hasText('parent.child');
                });

                test('nothing is auto-generated from route:basic', async function (assert) {
                  // Auto-generation does \`factoryFor('route:basic')\` and
                  // subclasses the result. Swapping in a class with no route
                  // manager turns that fallback into a loud failure instead of
                  // a silently classic route.
                  this.owner.unregister('route:basic');
                  this.owner.register('route:basic', class NotARoute {});

                  await visit('/');
                  await visit('/parent');
                  await visit('/parent/child');

                  assert.deepEqual(createdRouteNames().sort(), [
                    'application',
                    'index',
                    'parent',
                    'parent.child',
                    'parent.index',
                  ]);
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

        test('no classic route-manager module is loaded', async function (assert) {
          const server = await startDevServer(app);

          try {
            const { modules, importedBy } = await crawlModuleGraph(server.origin);

            // Guards against the crawl silently walking nothing and the
            // filter below passing for the wrong reason.
            const emberSourceModules = modules.filter((module) =>
              module.includes('/ember-source/')
            );
            assert.ok(
              emberSourceModules.length > 50,
              `expected the crawl to reach ember-source's modules, saw ${emberSourceModules.length} ` +
                `of ${modules.length} modules`
            );

            const offenders = modules.filter((module) => CLASSIC_MODULE.test(module));

            assert.deepEqual(
              offenders.map(shortName),
              [],
              offenders.length === 0
                ? 'no classic route-manager module was loaded'
                : reportOffenders(offenders, importedBy)
            );
          } finally {
            server.stop();
          }
        });
      });
    });
}

pioneerTests('v2-app-template');
