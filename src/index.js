// Alerts your phone through ntfy when an Expensify/App issue gets the "Help Wanted" label, and sends a
// quieter heads-up when an issue is marked "External" but is not open for proposals yet.
// Runs every 10 minutes on Cloudflare's free Workers plan. The logic lives in watcher.js.

import {DurableObject} from 'cloudflare:workers';

import {checkAndReport, sendTest} from './watcher.js';

/**
 * Holds the memory of which alerts were already sent. Unlike Workers KV, Durable Object storage always returns the
 * latest write, so a check never reads stale data and sends an alert twice.
 */
export class Watcher extends DurableObject {
    async check() {
        // A Durable Object can take a new request while an earlier one is waiting on the network, so make sure two
        // checks never overlap and both send the same alert.
        if (this.isChecking) {
            return;
        }
        this.isChecking = true;
        try {
            await checkAndReport(this.ctx.storage, this.env);
        } finally {
            this.isChecking = false;
        }
    }
}

function getWatcher(env) {
    return env.WATCHER.get(env.WATCHER.idFromName('main'));
}

export default {
    async scheduled(event, env) {
        await getWatcher(env).check();
    },

    // Visiting /test?key=<TEST_KEY> sends a test alert for the newest Help Wanted issue.
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== '/test' || !env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
            return new Response('Not found', {status: 404});
        }
        try {
            await sendTest(env);
            return new Response('Test notification sent. Check your phone.');
        } catch (error) {
            return new Response(`Test failed: ${error.message}`, {status: 500});
        }
    },
};
