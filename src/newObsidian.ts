import { graphql } from 'https://cdn.pika.dev/graphql@15.0.0';
import { renderPlaygroundPage } from 'https://deno.land/x/oak_graphql@0.6.2/graphql-playground-html/render-playground-html.ts';
import { makeExecutableSchema } from 'https://deno.land/x/oak_graphql@0.6.2/graphql-tools/schema/makeExecutableSchema.ts';
import LFUCache from './lfuBrowserCache.js';
//import { Cache } from './CacheClassAST.js';
import {Cache} from './quickCache.js'
import queryDepthLimiter from './DoSSecurity.ts';
import {restructure} from './restructure.ts';
import {invalidateCacheCheck} from './invalidateCacheCheck.js';
//import normalize from './Old/normalize.js'
import {normalizeResult, cachePrimaryFields} from './astNormalize.js' 
import {rebuildFromQuery} from './rebuild.js'
import {mapSelectionSet} from '../testingSelection.js'


interface Constructable<T> {
  new (...args: any): T & OakRouter;
}

interface OakRouter {
  post: any;
  get: any;
  obsidianSchema?: any;
}

export interface ObsidianRouterOptions<T> {
  Router: Constructable<T>;
  path?: string;
  typeDefs: any;
  resolvers: ResolversProps;
  context?: (ctx: any) => any;
  usePlayground?: boolean;
  useCache?: boolean;
  redisPort?: number;
  policy?: string;
  maxmemory?: string;
  maxQueryDepth?: number;
}

export interface ResolversProps {
  Query?: any;
  Mutation?: any;
  [dynamicProperty: string]: any;
}

// Export developer chosen port for redis database connection //
export let redisPortExport: number = 6379;

export async function ObsidianRouter<T>({
  Router,
  path = '/graphql',
  typeDefs,
  resolvers,
  context,
  usePlayground = false,
  useCache = true,
  redisPort = 6379,
  policy,
  maxmemory,
  maxQueryDepth = 0,
}: ObsidianRouterOptions<T>): Promise<T> {
  redisPortExport = redisPort;
  const router = new Router();

  const schema = makeExecutableSchema({ typeDefs, resolvers });

  // If using LFU Browser Caching, the following cache line needs to be uncommented.
   //const cache = new LFUCache(50);

  // If using Redis caching, the following lines need to be uncommented.
  const cache = new Cache();
  
  // clear redis cache when restarting the server
  cache.cacheClear();

  // set redis configurations

  if (policy || maxmemory) {
    cache.configSet('maxmemory-policy', policy);
    cache.configSet('maxmemory', maxmemory);
  }

  await router.post(path, async (ctx: any) => {
    var t0 = performance.now();

    const { response, request } = ctx;

    if (request.hasBody) {
     
      try {
        const contextResult = context ? await context(ctx) : undefined;
        let body = await request.body().value;
        console.log("the first body,", body)

        // If a securty limit is set for maxQueryDepth, invoke queryDepthLimiter
        // which throws error if query depth exceeds maximum
        if (maxQueryDepth) queryDepthLimiter(body.query, maxQueryDepth);

         // if we run restructre to get rid of variables and fragments 
          //then we wont have to do it anywhere later 
          // mike thinks we're golden
        
          body = {query : restructure(body)};
          console.log("Before invalidateCacheCheck");
          console.log("typeof body.query", typeof body.query)
          console.log("body:",body)
          //invalidateCacheCheck(body);
        // Variable to block the normalization of mutations //
        let toNormalize = true;

        if (useCache) {
          // console.log("body.query1", body.query)
          // Send query off to be destructured and found in Redis if possible //
          let obsidianReturn = await cache.read(body.query);
          if (!obsidianReturn) {
            const rebuildReturn = await rebuildFromQuery(body.query);
            obsidianReturn = rebuildReturn
          }
          // let log = await console.log("body.query2", (obsidianReturn))
          
          // console.log('Retrieved from cache: \n\t', obsidianReturn);

          if (obsidianReturn) {
            // console.log("Obsidian Return")
            response.status = 200;
            response.body = obsidianReturn;
            var t1 = performance.now();
            console.log(
              '%c Obsidian retrieved data from cache and took ' +
                (t1 - t0) +
                ' milliseconds.', "background: #222; color: #00FF00"
            );
            console.log(body.query);
            return;
          }
        }

        // if not in cache, it will fetch a new response from database
        const result = await (graphql as any)(
          schema,
          body.query,
          resolvers,
          contextResult,
          body.variables || undefined,
          body.operationName || undefined
        );

        // Send database response to client //
        response.status = 200;
        response.body = result;
          console.log("&&&&&&&&", result.errors)
          //cache of whole query completely non normalized
        // cache.write(body.query, result, false);

        // Normalize response and store in cache //
        if (useCache && toNormalize && !result.errors) {
           //console.log('Writing to cache right now', "\n body.query", body.query, "\n result", result);
           //console.log(normalize(result))

           //run to map alias 
           let map = mapSelectionSet(body.query)
           console.log("___+_", map)
        // this normalizeds the result and saves to REDIS
         let normalized = await normalizeResult(result, map)

         console.log("+++++", normalized)

         await cachePrimaryFields(normalized, body.query, map)

         


          
        }
        var t1 = performance.now();
        console.log(
          '%c Obsidian received new data and took ' + (t1 - t0) + ' milliseconds', 'background: #222; color: #FFFF00'
        );
        return;
      } catch (error) {
        response.status = 200;
        response.body = {
          data: null,
          errors: [
            {
              message: error.message ? error.message : error,
            },
          ],
        };
        console.error('Error: ', error.message);
        return;
      }
    }
  });
  // serve graphql playground
  await router.get(path, async (ctx: any) => {
    const { request, response } = ctx;
    if (usePlayground) {
      const prefersHTML = request.accepts('text/html');

      if (prefersHTML) {
        const playground = renderPlaygroundPage({
          endpoint: request.url.origin + path,
          subscriptionEndpoint: request.url.origin,
        });
        response.status = 200;
        response.body = playground;
        return;
      }
    }
  });

  return router;
}
